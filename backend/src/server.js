require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const healthRouter = require('./routes/health');
const cartRouter = require('./routes/cart');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());
app.use(morgan('dev'));

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/cart', cartRouter);

// Root ping
app.get('/', (req, res) => {
  res.json({ message: 'Riak Shopping Cart API', version: '1.0.0', status: 'running' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err);
  res.status(500).json({ error: 'Internal Server Error', details: err.message });
});

// ─── Start ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║  Riak Shopping Cart Backend            ║
║  Listening on port ${PORT}               ║
╚════════════════════════════════════════╝
  `);
});

module.exports = app;
