const db = require('../services/db');
const { ADMIN_ID } = require('../services/admin-session');

/** Remember who this is (name, email, photo). Called when someone uses the app or the console. */
async function touch({ id, name, email, image, emailVerified }) {
  await db.query(
    `insert into members (user_id, name, email, image, email_verified) values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update set name = excluded.name, email = excluded.email,
       image = excluded.image, email_verified = excluded.email_verified, last_seen_at = now()`,
    [id, name || '', email || '', image || null, !!emailVerified]
  );
}

/**
 * Gives access that was prepared in advance, the moment the person signs in with a VERIFIED email:
 * an address the admin invited becomes a dietitian (the invitation is used up).
 * Nobody becomes the admin this way: the admin is the account in the API's .env.
 */
async function applyAccessRules({ id, email, emailVerified }) {
  if (!emailVerified || !email) return;
  const address = email.toLowerCase();
  await db.query(
    `with used as (delete from dietitian_invites where email = $1 returning email)
     update members set role = 'dietitian' where user_id = $2 and role = 'member' and exists (select 1 from used)`,
    [address, id]
  );
}

/** True when this account was deleted (its sign-in token may still be valid for a while). */
async function isDeleted(userId) {
  const { rowCount } = await db.query('select 1 from deleted_accounts where user_id = $1', [userId]);
  return rowCount > 0;
}

/** { role, disabled } for a member (members never seen are plain, enabled members). */
async function accessOf(userId) {
  // The console admin signs in with the email and password in .env and has no database row.
  if (userId === ADMIN_ID) return { role: 'admin', disabled: false };
  const { rows } = await db.query('select role, disabled from members where user_id = $1', [userId]);
  return rows[0] ?? { role: 'member', disabled: false };
}

const roleOf = async (userId) => (await accessOf(userId)).role;

async function get(userId) {
  if (userId === ADMIN_ID) return { id: ADMIN_ID, name: 'Admin', email: '', image: null, role: 'admin', disabled: false };
  const { rows } = await db.query(
    'select user_id as id, name, email, image, role, disabled from members where user_id = $1',
    [userId]
  );
  return rows[0] ?? null;
}

async function setRoleByEmail(email, role) {
  const { rows } = await db.query(
    'update members set role = $2 where lower(email) = lower($1) returning user_id, name, email, role',
    [email, role]
  );
  return rows;
}

/**
 * Members who finished setup AND agreed to share, with a short progress line.
 * Pass dietitianId to see only the clients assigned to that dietitian (an admin passes nothing).
 */
async function listClients({ search, dietitianId, limit = 100 }) {
  const params = [];
  let where = "m.role = 'member' and b.share_with_dietitian and exists (select 1 from client_assignments ca join members d on d.user_id = ca.dietitian_id and d.role = 'dietitian' and not d.disabled where ca.member_id = m.user_id and ca.accepted_at is not null)";
  if (dietitianId) {
    params.push(dietitianId);
    where += ` and exists (select 1 from client_assignments a where a.member_id = m.user_id and a.dietitian_id = $${params.length} and a.accepted_at is not null)`;
  }
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where += ` and (m.name ilike $${params.length} or m.email ilike $${params.length})`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `select m.user_id as id, m.name, m.email, m.image, b.goal,
            b.weight_kg::float8 as "weightKg", b.target_weight_kg::float8 as "targetWeightKg",
            (select d.name from client_assignments ca join members d on d.user_id = ca.dietitian_id
               where ca.member_id = m.user_id and ca.accepted_at is not null order by ca.accepted_at limit 1) as "dietitianName",
            (select count(*)::int from diet_items i where i.member_id = m.user_id
               and i.plan_day between current_date - 6 and current_date) as "planned7",
            (select count(*)::int from diet_completions c join diet_items i on i.id = c.item_id
               where c.member_id = m.user_id and i.plan_day between current_date - 6 and current_date) as "done7"
     from members m join body_profiles b on b.user_id = m.user_id
     where ${where} order by lower(m.name), m.user_id limit $${params.length}`,
    params
  );
  return rows;
}

/** Is this member assigned to this dietitian? */
async function isAssigned(memberId, dietitianId) {
  const { rowCount } = await db.query(
    'select 1 from client_assignments where member_id = $1 and dietitian_id = $2 and accepted_at is not null',
    [memberId, dietitianId]
  );
  return rowCount > 0;
}

module.exports = { isDeleted, touch, applyAccessRules, accessOf, roleOf, get, setRoleByEmail, listClients, isAssigned };
