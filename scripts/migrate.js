/**
 * Applies the numbered files in db/migrations, in order. Each file runs once, inside a
 * transaction, and is recorded in the `schema_migrations` table. To change the schema, add a
 * new file (003_….sql); never edit one that has already run.
 *
 * Uses the direct (non-pooled) connection, as Neon recommends for schema changes.
 */
const fs = require('node:fs');
const path = require('node:path');

const env = require('../config/env');
const db = require('../services/db');

const dir = path.join(__dirname, '..', 'db', 'migrations');

(async () => {
  const pool = db.createPool(env.databaseUrlDirect, { max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const { rows } = await client.query('select name from schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`${file}: ${err.message}`);
      }
      console.log(`applied ${file}`);
      ran += 1;
    }
    console.log(ran ? `Done: ${ran} migration(s) applied.` : 'Nothing to do: database is up to date.');
  } finally {
    client.release();
    await pool.end();
    await db.pool.end();
  }
})().catch((err) => {
  console.error('Migration failed, nothing from that file was kept:', err.message);
  process.exit(1);
});
