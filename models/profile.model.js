const db = require('../services/db');

const DEFAULTS = { weeklyGoal: 5, stepGoal: 10_000, waterGoalMl: 2500 };

const COLUMNS = 'weekly_goal as "weeklyGoal", step_goal as "stepGoal", water_goal_ml as "waterGoalMl"';

/** A member has no profile row until they change a setting, so fall back to the defaults. */
async function getSettings(userId) {
  const { rows } = await db.query(`select ${COLUMNS} from profiles where user_id = $1`, [userId]);
  return rows[0] ?? { ...DEFAULTS };
}

/** Changes only the fields that are given (null / undefined = leave as it is). */
async function updateSettings(userId, { weeklyGoal = null, stepGoal = null, waterGoalMl = null }) {
  const { rows } = await db.query(
    `insert into profiles (user_id, weekly_goal, step_goal, water_goal_ml)
     values ($1, coalesce($2::int, $5::int), coalesce($3::int, $6::int), coalesce($4::int, $7::int))
     on conflict (user_id) do update set
       weekly_goal    = coalesce($2::int, profiles.weekly_goal),
       step_goal      = coalesce($3::int, profiles.step_goal),
       water_goal_ml  = coalesce($4::int, profiles.water_goal_ml),
       updated_at     = now()
     returning ${COLUMNS}`,
    [userId, weeklyGoal, stepGoal, waterGoalMl, DEFAULTS.weeklyGoal, DEFAULTS.stepGoal, DEFAULTS.waterGoalMl]
  );
  return rows[0];
}

module.exports = { getSettings, updateSettings, DEFAULTS };
