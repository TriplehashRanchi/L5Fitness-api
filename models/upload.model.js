const db = require('../services/db');

const COLUMNS = `id, object_key as "key", content_type as "contentType",
  size_bytes::int as "size", status, created_at as "createdAt"`;

async function create({ userId, key, contentType, size }) {
  const { rows } = await db.query(
    `insert into uploads (user_id, object_key, content_type, size_bytes)
     values ($1, $2, $3, $4) returning ${COLUMNS}`,
    [userId, key, contentType, size]
  );
  return rows[0];
}

/** Every lookup is scoped to the owner, so one user can never reach another user's file. */
async function findForUser(id, userId) {
  const { rows } = await db.query(`select ${COLUMNS} from uploads where id = $1 and user_id = $2`, [
    id,
    userId,
  ]);
  return rows[0] ?? null;
}

async function markReady(id, userId, size) {
  const { rows } = await db.query(
    `update uploads set status = 'ready', size_bytes = $3
     where id = $1 and user_id = $2 returning ${COLUMNS}`,
    [id, userId, size]
  );
  return rows[0] ?? null;
}

async function listForUser(userId, limit = 50) {
  const { rows } = await db.query(
    `select ${COLUMNS} from uploads
     where user_id = $1 and status = 'ready'
     order by created_at desc limit $2`,
    [userId, limit]
  );
  return rows;
}

async function remove(id, userId) {
  const { rowCount } = await db.query('delete from uploads where id = $1 and user_id = $2', [id, userId]);
  return rowCount > 0;
}

module.exports = { create, findForUser, markReady, listForUser, remove };
