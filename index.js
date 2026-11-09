const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const env = require('./config/env'); // loads .env.local / .env and fails fast if a value is missing
const db = require('./services/db');
const routes = require('./routes');
const { apiLimiter } = require('./middleware/rate-limit');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.trustProxy);

app.use(helmet()); // standard security headers
// Open CORS is fine here: the API authenticates with a bearer token, never with cookies.
app.use(cors());
app.use(express.json({ limit: '100kb' }));

// One line per request. Never logs bodies, tokens or query strings.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    if (req.path !== '/health') console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
});

app.use(apiLimiter);
app.use(routes);
app.use(notFound);
app.use(errorHandler);

const server = app.listen(env.port, () => {
  console.log(`L5 Fitness API listening on http://localhost:${env.port}`);
});

// Finish in-flight requests and close database connections on stop / redeploy.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await db.pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
