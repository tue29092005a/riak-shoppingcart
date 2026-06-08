const http = require('http');

const start = Date.now();
const req = http.request({
  hostname: 'localhost',
  port: 3001,
  path: '/api/cart/user1',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(`Latency: ${Date.now() - start}ms`);
    console.log(data);
  });
});
req.on('error', (e) => console.error(e));
req.write(JSON.stringify({ item: 'Mouse', quantity: 1 }));
req.end();
