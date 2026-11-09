const db = require('../services/db');

// Dates are returned as plain 'YYYY-MM-DD' text so no time zone can shift them.
const COLUMNS = `id, workout_id as "workoutId", title, started_at as "startedAt",
  duration_min as "durationMin", calories, avg_heart_rate as "avgHeartRate",
  local_day::text as "day"`;

async function create({ userId, workoutId, title, startedAt, durationMin, calories, avgHeartRate, day }) {
  const { rows } = await db.query(
    `insert into workout_logs
       (user_id, workout_id, title, started_at, duration_min, calories, avg_heart_rate, local_day)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${COLUMNS}`,
    [userId, workoutId, title, startedAt, durationMin, calories, avgHeartRate, day]
  );
  return rows[0];
}

/** Totals for one calendar day. avgHeartRate is null when no workout that day recorded one. */
async function statsForDay(userId, day) {
  const { rows } = await db.query(
    `select coalesce(sum(calories), 0)::int     as "calories",
            coalesce(sum(duration_min), 0)::int as "minutes",
            round(avg(avg_heart_rate))::int     as "avgHeartRate",
            count(*)::int                       as "workouts"
     from workout_logs where user_id = $1 and local_day = $2`,
    [userId, day]
  );
  return rows[0];
}

/** The days (YYYY-MM-DD) in a range on which the member trained at least once. */
async function daysTrained(userId, from, to) {
  const { rows } = await db.query(
    `select distinct local_day::text as day from workout_logs
     where user_id = $1 and local_day between $2 and $3 order by 1`,
    [userId, from, to]
  );
  return rows.map((r) => r.day);
}

async function listRecent(userId, limit = 30) {
  const { rows } = await db.query(
    `select ${COLUMNS} from workout_logs where user_id = $1
     order by started_at desc limit $2`,
    [userId, limit]
  );
  return rows;
}

async function remove(id, userId) {
  const { rowCount } = await db.query('delete from workout_logs where id = $1 and user_id = $2', [id, userId]);
  return rowCount > 0;
}

/**
 * Workout history grouped by day, newest day first. Pass the oldest day you already have as
 * `before` to get the next page. Returns { days, nextBefore } (nextBefore is null at the end).
 */
async function history(userId, { before, limit = 14 }) {
  const { rows: dayRows } = await db.query(
    `select distinct local_day::text as day from workout_logs
     where user_id = $1 and ($2::date is null or local_day < $2::date)
     order by day desc limit $3`,
    [userId, before ?? null, limit + 1]
  );
  const hasMore = dayRows.length > limit;
  const days = dayRows.slice(0, limit).map((r) => r.day);
  if (!days.length) return { days: [], nextBefore: null };
  const { rows } = await db.query(
    `select ${COLUMNS} from workout_logs where user_id = $1 and local_day = any($2::date[])
     order by started_at desc`,
    [userId, days]
  );
  const grouped = days.map((day) => {
    const workouts = rows.filter((r) => r.day === day);
    return {
      day,
      workouts,
      totalMinutes: workouts.reduce((a, w) => a + w.durationMin, 0),
      totalCalories: workouts.reduce((a, w) => a + w.calories, 0),
    };
  });
  return { days: grouped, nextBefore: hasMore ? days[days.length - 1] : null };
}

/** Lifetime totals for the top of the Logs screen. */
async function lifetime(userId) {
  const { rows } = await db.query(
    `select count(*)::int as workouts, coalesce(sum(duration_min), 0)::int as minutes,
            coalesce(sum(calories), 0)::int as calories, count(distinct local_day)::int as "activeDays"
     from workout_logs where user_id = $1`,
    [userId]
  );
  return rows[0];
}

module.exports = { create, statsForDay, daysTrained, listRecent, remove, history, lifetime };
