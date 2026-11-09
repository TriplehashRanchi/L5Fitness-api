/** Loads the starter content in db/seed.sql. Safe to run again: existing rows are left untouched. */
const fs = require('node:fs');
const path = require('node:path');

const db = require('../services/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'seed.sql'), 'utf8');
  await db.transaction((client) => client.query(sql));
  const { rows } = await db.query(`select
    (select count(*)::int from workout_categories) as categories,
    (select count(*)::int from workouts)           as workouts,
    (select count(*)::int from plan_days)          as plan_days,
    (select count(*)::int from class_slots)        as class_slots`);
  console.log('Seeded. Now in the database:', rows[0]);
  await db.pool.end();
})().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
