const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const env = require('./config/env'); // loads .env.local / .env and fails fast if a value is missing
const db = require('./services/db');
const routes = require('./routes');
const { apiLimiter } = require('./middleware/rate-limit');
const { notFound, errorHandler } = require('./middleware/errors');
const adminSession = require('./services/admin-session');
const realtime = require('./services/realtime');
const { canManage } = require('./controllers/diet.controller');

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

if (env.isProduction && !env.trustProxy)
  console.warn('[config] TRUST_PROXY is not set. Behind a host proxy every user would share one address for rate limits. Set TRUST_PROXY=1.');

const server = app.listen(env.port, () => {
  console.log(`L5 Fitness API listening on http://localhost:${env.port}`);
  adminSession.reportStatus();
});

// Live chat (Socket.IO) shares the API's port; it answers /socket.io itself, before Express.
realtime.attach(server, { canManage });

// Finish in-flight requests and close database connections on stop / redeploy.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  // Closing Socket.IO also closes the HTTP server it is attached to.
  void realtime.close();
  server.close(async () => {
    await db.pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
