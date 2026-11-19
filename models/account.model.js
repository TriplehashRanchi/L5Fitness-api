const db = require('../services/db');

/**
 * Removes everything stored about one member. Returns the storage keys of their files so the
 * caller can delete the files too. Safe to run again: a second run finds nothing.
 */
async function deleteAllData(userId) {
  return db.transaction(async (client) => {
    const { rows } = await client.query('select object_key from uploads where user_id = $1', [userId]);
    for (const table of ['meals', 'water_logs', 'workout_logs', 'class_bookings', 'uploads', 'profiles', 'weight_logs', 'body_profiles', 'step_logs', 'members']) {
      await client.query(`delete from ${table} where user_id = $1`, [userId]);
    }
    await client.query('delete from client_assignments where member_id = $1', [userId]);
    await client.query('insert into deleted_accounts (user_id) values ($1) on conflict do nothing', [userId]);
    // Diet plans written FOR this member (their ticks go with the items).
    await client.query('delete from diet_items where member_id = $1', [userId]);
    return rows.map((r) => r.object_key);
  });
}

module.exports = { deleteAllData };
