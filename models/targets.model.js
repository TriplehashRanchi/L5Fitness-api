const db = require('../services/db');
const profiles = require('./profile.model');

const COLS = `water_ml as "waterMl", steps, calories, protein_g as "proteinG",
  weekly_workouts as "weeklyWorkouts", updated_at as "updatedAt"`;

async function get(memberId) {
  const { rows } = await db.query(`select ${COLS} from client_targets where member_id = $1`, [memberId]);
  return rows[0] ?? { waterMl: null, steps: null, calories: null, proteinG: null, weeklyWorkouts: null, updatedAt: null };
}

/** Replaces all targets (null clears one). */
async function save(memberId, t, actor) {
  await db.query(
    `insert into client_targets (member_id, water_ml, steps, calories, protein_g, weekly_workouts, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (member_id) do update set water_ml = excluded.water_ml, steps = excluded.steps,
       calories = excluded.calories, protein_g = excluded.protein_g,
       weekly_workouts = excluded.weekly_workouts, updated_by = excluded.updated_by, updated_at = now()`,
    [memberId, t.waterMl, t.steps, t.calories, t.proteinG, t.weeklyWorkouts, actor]
  );
  return get(memberId);
}

/**
 * What the member must do today. The dietitian's number wins; the member's own Settings value is
 * only a fallback shown until the dietitian sets one (`prescribed` says which it is).
 */
async function effective(memberId) {
  const [t, s] = await Promise.all([get(memberId), profiles.getSettings(memberId)]);
  return {
    waterMl: t.waterMl ?? s.waterGoalMl,
    steps: t.steps ?? s.stepGoal,
    weeklyWorkouts: t.weeklyWorkouts ?? s.weeklyGoal,
    calories: t.calories,
    proteinG: t.proteinG,
    prescribed: { waterMl: t.waterMl != null, steps: t.steps != null, weeklyWorkouts: t.weeklyWorkouts != null },
  };
}

module.exports = { get, save, effective };
