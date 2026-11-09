/**
 * Postgres (Neon) connection pool.
 *
 * Driver: node-postgres (`pg`). This API is a long-running Node server, so one pool is created
 * at start-up and reused by every request. It connects through Neon's pooled endpoint.
 */
const { Pool } = require('pg');

const env = require('../config/env');

/**
 * Neon hands out URLs with `sslmode=require`. `pg` already treats that as full certificate
 * verification today but warns that this will weaken in pg v9, so ask for it by name.
 */
function withVerifiedTls(connectionString) {
  const url = new URL(connectionString);
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

function createPool(connectionString, options = {}) {
  const pool = new Pool({
    connectionString: withVerifiedTls(connectionString),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ...options,
  });
  // An idle client can be dropped when Neon scales the compute to zero. Without this listener
  // that would crash the process; the pool just opens a new connection on the next query.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  return pool;
}

const pool = createPool(env.databaseUrlPooled);

/** Run one query. Always use $1, $2… placeholders for values. */
const query = (text, params) => pool.query(text, params);

/**
 * Run several statements as one all-or-nothing unit. A transaction must stay on ONE connection,
 * so use the `client` passed in for every statement inside (never `query`/`pool` from above).
 */
async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function ping() {
  const started = Date.now();
  await pool.query('select 1');
  return Date.now() - started;
}

module.exports = { pool, query, transaction, ping, createPool };
