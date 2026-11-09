const db = require('../services/db');

const COLUMNS = 'id, amount_ml as "amountMl", created_at as "createdAt"';

const add = async ({ userId, amountMl, day }) =>
  (
    await db.query(
      `insert into water_logs (user_id, amount_ml, local_day) values ($1, $2, $3) returning ${COLUMNS}`,
      [userId, amountMl, day]
    )
  ).rows[0];

/** { totalMl, lastId }: the day's total and the newest entry (so the app can offer "undo"). */
async function summaryForDay(userId, day) {
  const { rows } = await db.query(
    `select coalesce(sum(amount_ml), 0)::int as "totalMl",
            (array_agg(id order by created_at desc))[1] as "lastId"
     from water_logs where user_id = $1 and local_day = $2`,
    [userId, day]
  );
  return rows[0];
}

const listForDay = async (userId, day) =>
  (
    await db.query(
      `select ${COLUMNS} from water_logs where user_id = $1 and local_day = $2 order by created_at desc limit 100`,
      [userId, day]
    )
  ).rows;

async function remove(id, userId) {
  const { rowCount } = await db.query('delete from water_logs where id = $1 and user_id = $2', [id, userId]);
  return rowCount > 0;
}

module.exports = { add, summaryForDay, listForDay, remove };
