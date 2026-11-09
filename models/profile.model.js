const db = require('../services/db');

const DEFAULT_WEEKLY_GOAL = 5;

/** A member has no profile row until they change a setting, so fall back to the default. */
async function getWeeklyGoal(userId) {
  const { rows } = await db.query('select weekly_goal from profiles where user_id = $1', [userId]);
  return rows[0]?.weekly_goal ?? DEFAULT_WEEKLY_GOAL;
}

async function setWeeklyGoal(userId, weeklyGoal) {
  const { rows } = await db.query(
    `insert into profiles (user_id, weekly_goal) values ($1, $2)
     on conflict (user_id) do update set weekly_goal = excluded.weekly_goal, updated_at = now()
     returning weekly_goal`,
    [userId, weeklyGoal]
  );
  return rows[0].weekly_goal;
}

module.exports = { getWeeklyGoal, setWeeklyGoal, DEFAULT_WEEKLY_GOAL };
