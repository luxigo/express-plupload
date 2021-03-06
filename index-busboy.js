var crypto = require('crypto');
var Busboy = require('busboy');
var QueuedStream = require('queued-stream');

var uploads = {};

function id(req, options) {
  var ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  return md5([ip, options.chunks, options.name, options.filename, req.path].join());
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

exports.middleware = function(req, res, next, options) {
  var contentType = req.get('content-type');
  if (!contentType || !~contentType.indexOf('multipart/form-data')) return next();

  var attrs = {};
  var timeout;

  var busboy = req.busboy = new Busboy({ headers: req.headers });
  busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
    req._abort = (options && options.validate && options.validate[fieldname] && options.validate[fieldname](req,res,next,val) === false);
    attrs[fieldname] = val;
  });
  busboy.on('file', function(fieldname, file, filename, encoding, mimetype) {
    if (req._abort) {
      file.resume();
      return;
    }
    attrs.chunk = parseInt(attrs.chunk, 10);
    attrs.chunks = parseInt(attrs.chunks, 10);

    var uploadId = id(req, attrs);
    var upload = req.plupload = uploads[uploadId];
    
    if (upload) {
      upload.fields = attrs;
    }

    // console.log(filename, attrs.chunk, attrs.chunks, 'begin');
    if (attrs.chunk === 0) {
      if (upload && upload.stream) {
        upload.stream.destroy();
      }
      upload = req.plupload = uploads[uploadId] = {
        isNew: true,
        filename: filename,
        totalChunks: attrs.chunks,
        nextChunk: 0, // chunk that can be added to the queue
        completedChunks: 0,
        completedOffset: 0,
        fields: attrs
      };
    } else if (!upload || attrs.chunk !== upload.nextChunk) {
      return next(new Error('expecting chunk ' + (upload && upload.nextChunk || 0) + ' got ' + attrs.chunk));
    }

    // Increment next chunk
    upload.nextChunk = attrs.chunk + 1;

    file.on('unpipe', function(readable) {
      if (timeout) clearTimeout(timeout);
      upload.completedChunks = attrs.chunk;
      upload.completedOffset += upload.stream.currentBytes;
    });

    // Continue with existing stream
    if (upload.stream) {
      upload.isNew = false;
      upload.stream.append(file);
      if (upload.nextChunk === upload.totalChunks) {
        upload.stream.append(null);
      }
      return next();
    }

    function cleanUp() {
      if (!uploads[uploadId] || upload.stream) return;
      delete(uploads[uploadId]);
    }

    function onError() {
      if (!upload) return;
      upload.nextChunk = upload.completedChunks + 1;
      upload.stream = null;
      timeout = setTimeout(cleanUp, 30000);
    }

    // Start a new stream
    upload.stream = new QueuedStream();
    upload.stream
    .on('data', function() {
      if (timeout) clearTimeout(timeout);
      if (req._abort) {
        file.resume();
      } else {
        timeout = setTimeout(onError, 3000);
      }
    })
    .on('error', function(err) {
      if (timeout) clearTimeout(timeout);
      onError();
    })
    .on('end', function() {
      if (timeout) clearTimeout(timeout);
      cleanUp();
    })
    .append(file);

    if (upload.nextChunk === upload.totalChunks) {
      upload.stream.append(null);
    }
    next();
  });
  busboy.on('finish', function() {
    // console.log(filename, attrs.chunk, attrs.chunks, 'finish');
  });
  req.pipe(busboy);
};
