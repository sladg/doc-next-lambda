// Entrypoint for Lambda.

// Patches FS to use S3
require('./dist/s3fs.js')

// Starts Next server
require('./server.js')
