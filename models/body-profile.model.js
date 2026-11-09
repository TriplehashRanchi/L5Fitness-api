const db = require('../services/db');

const COLUMNS = `goal, sex, birth_date::text as "birthDate", height_cm::float8 as "heightCm",
  weight_kg::float8 as "weightKg", target_weight_kg::float8 as "targetWeightKg",
  start_weight_kg::float8 as "startWeightKg", activity_level as "activityLevel",
  diet_type as "dietType", allergies, medical_notes as "medicalNotes",
  share_with_dietitian as "shareWithDietitian", completed_at as "completedAt", updated_at as "updatedAt"`;

async function get(userId) {
  const { rows } = await db.query(`select ${COLUMNS} from body_profiles where user_id = $1`, [userId]);
  return rows[0] ?? null;
}

/**
 * Saves the setup answers. The first save also records the starting weight; later saves keep it.
 * A changed weight is added to the weight history, on the given calendar day.
 */
async function save(userId, p, day) {
  await db.transaction(async (client) => {
    const existing = await client.query('select weight_kg::float8 as w from body_profiles where user_id = $1', [userId]);
    await client.query(
      `insert into body_profiles (user_id, goal, sex, birth_date, height_cm, weight_kg, target_weight_kg,
         start_weight_kg, activity_level, diet_type, allergies, medical_notes, share_with_dietitian)
       values ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11,$12)
       on conflict (user_id) do update set goal = excluded.goal, sex = excluded.sex,
         birth_date = excluded.birth_date, height_cm = excluded.height_cm, weight_kg = excluded.weight_kg,
         target_weight_kg = excluded.target_weight_kg, activity_level = excluded.activity_level,
         diet_type = excluded.diet_type, allergies = excluded.allergies, medical_notes = excluded.medical_notes,
         share_with_dietitian = excluded.share_with_dietitian, updated_at = now()`,
      [userId, p.goal, p.sex, p.birthDate, p.heightCm, p.weightKg, p.targetWeightKg, p.activityLevel,
       p.dietType, p.allergies, p.medicalNotes, p.shareWithDietitian]
    );
    if (!existing.rowCount || existing.rows[0].w !== p.weightKg) {
      await client.query('insert into weight_logs (user_id, weight_kg, local_day) values ($1, $2, $3)', [userId, p.weightKg, day]);
    }
  });
  return get(userId);
}

/** Records a new weight and makes it the member's current weight. */
async function addWeight(userId, weightKg, day) {
  return db.transaction(async (client) => {
    const upd = await client.query('update body_profiles set weight_kg = $2, updated_at = now() where user_id = $1', [userId, weightKg]);
    if (!upd.rowCount) return null; // no profile yet
    const { rows } = await client.query(
      `insert into weight_logs (user_id, weight_kg, local_day) values ($1, $2, $3)
       returning id, weight_kg::float8 as "weightKg", local_day::text as day`,
      [userId, weightKg, day]
    );
    return rows[0];
  });
}

/** Newest first. */
async function weightHistory(userId, limit = 60) {
  const { rows } = await db.query(
    `select id, weight_kg::float8 as "weightKg", local_day::text as day from weight_logs
     where user_id = $1 order by local_day desc, created_at desc limit $2`,
    [userId, limit]
  );
  return rows;
}

module.exports = { get, save, addWeight, weightHistory };
