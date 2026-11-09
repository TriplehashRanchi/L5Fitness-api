const db = require('../services/db');

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
 *   - the address in ADMIN_EMAIL becomes the admin (only while there is no admin yet)
 *   - an address the admin invited becomes a dietitian (the invitation is used up)
 */
async function applyAccessRules({ id, email, emailVerified }, adminEmail) {
  if (!emailVerified || !email) return;
  const address = email.toLowerCase();
  if (adminEmail && address === adminEmail.toLowerCase()) {
    try {
      await db.query(
        `update members set role = 'admin' where user_id = $1 and role <> 'admin'
           and not exists (select 1 from members where role = 'admin')`,
        [id]
      );
    } catch (err) {
      if (err.code !== '23505') throw err; // two people raced for the one admin seat: the loser stays a member
    }
    return;
  }
  await db.query(
    `with used as (delete from dietitian_invites where email = $1 returning email)
     update members set role = 'dietitian' where user_id = $2 and role = 'member' and exists (select 1 from used)`,
    [address, id]
  );
}

/** { role, disabled } for a member (members never seen are plain, enabled members). */
async function accessOf(userId) {
  const { rows } = await db.query('select role, disabled from members where user_id = $1', [userId]);
  return rows[0] ?? { role: 'member', disabled: false };
}

const roleOf = async (userId) => (await accessOf(userId)).role;

async function get(userId) {
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
  let where = "m.role = 'member' and b.share_with_dietitian";
  if (dietitianId) {
    params.push(dietitianId);
    where += ` and exists (select 1 from client_assignments a where a.member_id = m.user_id and a.dietitian_id = $${params.length})`;
  }
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where += ` and (m.name ilike $${params.length} or m.email ilike $${params.length})`;
  }
  params.push(limit);
  const { rows } = await db.query(
    `select m.user_id as id, m.name, m.email, m.image, b.goal,
            b.weight_kg::float8 as "weightKg", b.target_weight_kg::float8 as "targetWeightKg",
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
    'select 1 from client_assignments where member_id = $1 and dietitian_id = $2',
    [memberId, dietitianId]
  );
  return rowCount > 0;
}

module.exports = { touch, applyAccessRules, accessOf, roleOf, get, setRoleByEmail, listClients, isAssigned };
