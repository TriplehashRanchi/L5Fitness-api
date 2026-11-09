const db = require('../services/db');

const SELECT = `m.id, m.meal_type as "mealType", m.note, m.local_day::text as "day",
  m.eaten_at as "eatenAt", u.object_key as "photoKey"`;

/** Throws a Postgres 23505 error when the photo already belongs to another meal. */
async function create({ userId, mealType, note, uploadId, day, eatenAt }) {
  const { rows } = await db.query(
    `insert into meals (user_id, meal_type, note, upload_id, local_day, eaten_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [userId, mealType, note, uploadId, day, eatenAt]
  );
  return findForUser(rows[0].id, userId);
}

async function findForUser(id, userId) {
  const { rows } = await db.query(
    `select ${SELECT}, m.upload_id as "uploadId" from meals m
     left join uploads u on u.id = m.upload_id where m.id = $1 and m.user_id = $2`,
    [id, userId]
  );
  return rows[0] ?? null;
}

const listForDay = async (userId, day) =>
  (
    await db.query(
      `select ${SELECT} from meals m left join uploads u on u.id = m.upload_id
       where m.user_id = $1 and m.local_day = $2 order by m.eaten_at limit 50`,
      [userId, day]
    )
  ).rows;

async function remove(id, userId) {
  const { rowCount } = await db.query('delete from meals where id = $1 and user_id = $2', [id, userId]);
  return rowCount > 0;
}

module.exports = { create, findForUser, listForDay, remove };
