const db = require('../services/db');

async function saveSteps(userId, entries) {
  for (const e of entries) {
    await db.query(
      `insert into step_logs (user_id, local_day, steps) values ($1, $2, $3)
       on conflict (user_id, local_day) do update set steps = excluded.steps, updated_at = now()`,
      [userId, e.day, e.steps]
    );
  }
}

const stepsForDay = async (userId, day) =>
  (await db.query('select steps from step_logs where user_id = $1 and local_day = $2', [userId, day])).rows[0]?.steps ?? null;

/** One row per calendar day in the range (steps is null on days nothing was reported). */
async function stepsBetween(userId, from, to) {
  const { rows } = await db.query(
    `select d::date::text as day, s.steps
     from generate_series($2::date, $3::date, interval '1 day') d
     left join step_logs s on s.user_id = $1 and s.local_day = d::date
     order by d`,
    [userId, from, to]
  );
  return rows;
}

/** One row per day for 7 days from weekStart: everything the coach checks for compliance. */
async function week(memberId, weekStart) {
  const { rows } = await db.query(
    `select d::date::text as day,
       (select steps from step_logs s where s.user_id = $1 and s.local_day = d::date) as steps,
       (select coalesce(sum(amount_ml), 0)::int from water_logs w where w.user_id = $1 and w.local_day = d::date) as "waterMl",
       (select count(*)::int from meals m where m.user_id = $1 and m.local_day = d::date) as meals,
       (select count(*)::int from diet_items i where i.member_id = $1 and i.plan_day = d::date) as "dietPlanned",
       (select count(*)::int from diet_completions c join diet_items i on i.id = c.item_id
          where c.member_id = $1 and i.plan_day = d::date) as "dietDone",
       (select count(*)::int from workout_logs l where l.user_id = $1 and l.local_day = d::date) as workouts
     from generate_series($2::date, $2::date + 6, interval '1 day') d order by d`,
    [memberId, weekStart]
  );
  return rows;
}

/**
 * One row per calendar day from `from` to `to`: steps, water, meals logged, diet items planned and done,
 * and workouts with their minutes and calories. For the member's own month view.
 */
async function range(memberId, from, to) {
  const { rows } = await db.query(
    `select d::date::text as day,
       (select steps from step_logs s where s.user_id = $1 and s.local_day = d::date) as steps,
       (select coalesce(sum(amount_ml), 0)::int from water_logs w where w.user_id = $1 and w.local_day = d::date) as "waterMl",
       (select count(*)::int from meals m where m.user_id = $1 and m.local_day = d::date) as meals,
       (select count(*)::int from diet_items i where i.member_id = $1 and i.plan_day = d::date) as "dietPlanned",
       (select count(*)::int from diet_completions c join diet_items i on i.id = c.item_id
          where c.member_id = $1 and i.plan_day = d::date) as "dietDone",
       (select count(*)::int from workout_logs l where l.user_id = $1 and l.local_day = d::date) as workouts,
       (select coalesce(sum(duration_min), 0)::int from workout_logs l where l.user_id = $1 and l.local_day = d::date) as "workoutMinutes",
       (select coalesce(sum(calories), 0)::int from workout_logs l where l.user_id = $1 and l.local_day = d::date) as "workoutCalories"
     from generate_series($2::date, $3::date, interval '1 day') d order by d`,
    [memberId, from, to]
  );
  return rows;
}

async function workoutsForDay(memberId, day) {
  const { rows } = await db.query(
    `select id, title, started_at as "startedAt", duration_min as "durationMin", calories
     from workout_logs where user_id = $1 and local_day = $2 order by started_at`,
    [memberId, day]
  );
  return rows;
}

/**
 * True when the member logged a finished workout for the dietitian's plan of that day. Personal plans are
 * logged without a catalog id (workout_id is null) and carry the plan's title, so the title is the link.
 */
async function planDone(memberId, title, day) {
  const { rowCount } = await db.query(
    'select 1 from workout_logs where user_id = $1 and local_day = $2 and workout_id is null and title = $3 limit 1',
    [memberId, day, title]
  );
  return rowCount > 0;
}

module.exports = { stepsBetween, saveSteps, stepsForDay, week, range, workoutsForDay, planDone };
