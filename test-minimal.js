const http = require('http');
http.createServer((req, res) => {
  res.end('file-works');
}).listen(process.env.PORT || 10000);
