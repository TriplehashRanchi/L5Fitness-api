const db = require('../services/db');

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────

async function overview() {
  const { rows } = await db.query(
    `select
       (select count(*)::int from members where role = 'member') as members,
       (select count(*)::int from members where role = 'member' and created_at >= now() - interval '7 days') as "newMembers7",
       (select count(*)::int from members where role = 'dietitian' and not disabled) as dietitians,
       (select count(*)::int from dietitian_invites) as "pendingInvites",
       (select count(*)::int from members m join body_profiles b on b.user_id = m.user_id
          where m.role = 'member' and b.share_with_dietitian
            and not exists (select 1 from client_assignments a where a.member_id = m.user_id)) as "unassignedClients",
       (select count(distinct user_id)::int from workout_logs where local_day >= current_date - 6) as "activeMembers7",
       (select count(*)::int from workout_logs where local_day >= current_date - 6) as "workouts7",
       (select count(*)::int from diet_items where plan_day between current_date - 6 and current_date) as "planned7",
       (select count(*)::int from diet_completions c join diet_items i on i.id = c.item_id
          where i.plan_day between current_date - 6 and current_date) as "done7"`
  );
  return rows[0];
}

// ── Dietitians ────────────────────────────────────────────────────────────────────────────────

async function listDietitians() {
  const active = await db.query(
    `select m.user_id as id, m.name, m.email, m.image, m.disabled, m.last_seen_at as "lastSeenAt",
            (select count(*)::int from client_assignments a where a.dietitian_id = m.user_id) as clients
     from members m where m.role = 'dietitian' order by lower(m.name), m.email`
  );
  const invites = await db.query('select email, created_at as "invitedAt" from dietitian_invites order by created_at desc');
  return { dietitians: active.rows, invites: invites.rows };
}

/** Returns 'promoted' | 'invited' | 'already' | 'admin'. */
async function inviteDietitian(email, invitedBy) {
  const address = email.toLowerCase();
  const { rows } = await db.query('select user_id, role, email_verified from members where lower(email) = $1', [address]);
  const existing = rows[0];
  if (existing?.role === 'admin') return 'admin';
  if (existing?.role === 'dietitian') return 'already';
  if (existing && existing.email_verified) {
    await db.query("update members set role = 'dietitian' where user_id = $1 and role = 'member'", [existing.user_id]);
    await db.query('delete from dietitian_invites where email = $1', [address]);
    return 'promoted';
  }
  await db.query('insert into dietitian_invites (email, invited_by) values ($1, $2) on conflict (email) do nothing', [address, invitedBy]);
  return 'invited';
}

const removeInvite = async (email) =>
  (await db.query('delete from dietitian_invites where email = $1', [email.toLowerCase()])).rowCount > 0;

/** Back to an ordinary member; their clients become unassigned. */
async function demoteDietitian(userId) {
  return db.transaction(async (client) => {
    const r = await client.query(
      "update members set role = 'member', disabled = false where user_id = $1 and role = 'dietitian' returning email",
      [userId]
    );
    if (!r.rowCount) return false;
    await client.query('delete from client_assignments where dietitian_id = $1', [userId]);
    await client.query('delete from dietitian_invites where email = lower($1)', [r.rows[0].email]);
    return true;
  });
}

async function setDisabled(userId, disabled) {
  const { rowCount } = await db.query("update members set disabled = $2 where user_id = $1 and role = 'dietitian'", [userId, disabled]);
  return rowCount > 0;
}

// ── Members and assignment ────────────────────────────────────────────────────────────────────

/** filter: 'all' | 'unassigned' | 'assigned' */
async function listMembers({ search, filter, limit, offset }) {
  const params = [];
  const where = ["m.role = 'member'"];
  if (search) {
    params.push(`%${search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(m.name ilike $${params.length} or m.email ilike $${params.length})`);
  }
  if (filter === 'unassigned') where.push('a.member_id is null');
  if (filter === 'assigned') where.push('a.member_id is not null');
  params.push(limit, offset);
  const { rows } = await db.query(
    `select m.user_id as id, m.name, m.email, m.image, m.created_at as "joinedAt", m.last_seen_at as "lastSeenAt",
            (b.user_id is not null) as "setupDone", coalesce(b.share_with_dietitian, false) as sharing,
            b.goal, b.weight_kg::float8 as "weightKg", b.target_weight_kg::float8 as "targetWeightKg",
            d.user_id as "dietitianId", d.name as "dietitianName", d.email as "dietitianEmail",
            (select count(*)::int from workout_logs w where w.user_id = m.user_id and w.local_day >= current_date - 6) as "workouts7",
            (select count(*)::int from diet_items i where i.member_id = m.user_id and i.plan_day between current_date - 6 and current_date) as "planned7",
            (select count(*)::int from diet_completions c join diet_items i on i.id = c.item_id
               where c.member_id = m.user_id and i.plan_day between current_date - 6 and current_date) as "done7",
            count(*) over()::int as total
     from members m
     left join body_profiles b on b.user_id = m.user_id
     left join client_assignments a on a.member_id = m.user_id
     left join members d on d.user_id = a.dietitian_id
     where ${where.join(' and ')}
     order by m.last_seen_at desc, m.user_id limit $${params.length - 1} offset $${params.length}`,
    params
  );
  return { members: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

/** dietitianId = null removes the assignment. Returns 'ok' | 'no-member' | 'no-dietitian'. */
async function setAssignment(memberId, dietitianId, adminId) {
  const member = await db.query("select 1 from members where user_id = $1 and role = 'member'", [memberId]);
  if (!member.rowCount) return 'no-member';
  if (dietitianId === null) {
    await db.query('delete from client_assignments where member_id = $1', [memberId]);
    return 'ok';
  }
  const d = await db.query("select 1 from members where user_id = $1 and role = 'dietitian' and not disabled", [dietitianId]);
  if (!d.rowCount) return 'no-dietitian';
  await db.query(
    `insert into client_assignments (member_id, dietitian_id, assigned_by) values ($1, $2, $3)
     on conflict (member_id) do update set dietitian_id = excluded.dietitian_id, assigned_by = excluded.assigned_by, assigned_at = now()`,
    [memberId, dietitianId, adminId]
  );
  return 'ok';
}

// ── Workout catalog ───────────────────────────────────────────────────────────────────────────

const WORKOUT = `w.id, w.slug, w.title, w.category_slug as "categorySlug", c.name as "categoryName", w.level,
  w.duration_min as "durationMin", w.kcal_estimate as "kcalEstimate", w.exercise_count as "exerciseCount",
  w.focus, w.coach, w.icon, w.is_program as "isProgram", w.is_active as "isActive", w.sort_order as "sortOrder"`;

const slugify = (text) =>
  text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'workout';

async function uniqueSlug(table, base) {
  let slug = base;
  for (let n = 2; n < 100; n += 1) {
    const { rowCount } = await db.query(`select 1 from ${table} where slug = $1`, [slug]);
    if (!rowCount) return slug;
    slug = `${base}-${n}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function listWorkouts() {
  const { rows } = await db.query(
    `select ${WORKOUT} from workouts w join workout_categories c on c.slug = w.category_slug
     order by w.is_active desc, w.sort_order, lower(w.title)`
  );
  return rows;
}

async function getWorkout(id) {
  const { rows } = await db.query(`select ${WORKOUT} from workouts w join workout_categories c on c.slug = w.category_slug where w.id = $1`, [id]);
  return rows[0] ?? null;
}

async function categories() {
  const { rows } = await db.query('select slug, name from workout_categories order by sort_order, name');
  return rows;
}

async function createCategory(name) {
  const slug = await uniqueSlug('workout_categories', slugify(name));
  const { rows } = await db.query(
    `insert into workout_categories (slug, name, sort_order)
     values ($1, $2, coalesce((select max(sort_order) + 1 from workout_categories), 1)) returning slug, name`,
    [slug, name]
  );
  return rows[0];
}

async function createWorkout(d) {
  const slug = await uniqueSlug('workouts', slugify(d.title));
  const { rows } = await db.query(
    `insert into workouts (slug, title, category_slug, level, duration_min, kcal_estimate, exercise_count, focus, coach, icon, is_program, is_active, sort_order)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, coalesce((select max(sort_order) + 1 from workouts), 1)) returning id`,
    [slug, d.title, d.categorySlug, d.level, d.durationMin, d.kcalEstimate, d.exerciseCount, d.focus, d.coach, d.icon, d.isProgram, d.isActive]
  );
  return getWorkout(rows[0].id);
}

async function updateWorkout(id, d) {
  const { rowCount } = await db.query(
    `update workouts set title=$2, category_slug=$3, level=$4, duration_min=$5, kcal_estimate=$6, exercise_count=$7,
       focus=$8, coach=$9, icon=$10, is_program=$11, is_active=$12 where id = $1`,
    [id, d.title, d.categorySlug, d.level, d.durationMin, d.kcalEstimate, d.exerciseCount, d.focus, d.coach, d.icon, d.isProgram, d.isActive]
  );
  return rowCount ? getWorkout(id) : null;
}

/** A workout is never deleted (members' history points at it): it is switched off instead. */
async function setWorkoutActive(id, active) {
  const { rowCount } = await db.query('update workouts set is_active = $2 where id = $1', [id, active]);
  return rowCount > 0;
}

// ── Weekly plan (the workout Home shows each weekday) ─────────────────────────────────────────

async function weeklyPlan() {
  const { rows } = await db.query(
    `select d as weekday, w.id as "workoutId", w.title as "workoutTitle"
     from generate_series(0, 6) d left join plan_days p on p.weekday = d left join workouts w on w.id = p.workout_id
     order by d`
  );
  return rows;
}

async function setPlanDay(weekday, workoutId) {
  const w = await db.query('select 1 from workouts where id = $1 and is_active', [workoutId]);
  if (!w.rowCount) return false;
  await db.query(
    `insert into plan_days (weekday, workout_id) values ($1, $2)
     on conflict (weekday) do update set workout_id = excluded.workout_id`,
    [weekday, workoutId]
  );
  return true;
}

// ── Class timetable ───────────────────────────────────────────────────────────────────────────

const CLASS = `id, name, trainer, icon, weekdays, to_char(start_time, 'HH24:MI') as "startTime",
  duration_min as "durationMin", capacity, is_active as "isActive"`;

async function listClasses() {
  const { rows } = await db.query(`select ${CLASS} from class_slots order by is_active desc, start_time, lower(name)`);
  return rows;
}

async function createClass(d) {
  const { rows } = await db.query(
    `insert into class_slots (name, trainer, icon, weekdays, start_time, duration_min, capacity, is_active)
     values ($1,$2,$3,$4::smallint[],$5,$6,$7,$8) returning ${CLASS}`,
    [d.name, d.trainer, d.icon, d.weekdays, d.startTime, d.durationMin, d.capacity, d.isActive]
  );
  return rows[0];
}

async function updateClass(id, d) {
  const { rows } = await db.query(
    `update class_slots set name=$2, trainer=$3, icon=$4, weekdays=$5::smallint[], start_time=$6,
       duration_min=$7, capacity=$8, is_active=$9 where id = $1 returning ${CLASS}`,
    [id, d.name, d.trainer, d.icon, d.weekdays, d.startTime, d.durationMin, d.capacity, d.isActive]
  );
  return rows[0] ?? null;
}

async function setClassActive(id, active) {
  const { rowCount } = await db.query('update class_slots set is_active = $2 where id = $1', [id, active]);
  return rowCount > 0;
}

module.exports = {
  overview, listDietitians, inviteDietitian, removeInvite, demoteDietitian, setDisabled,
  listMembers, setAssignment,
  listWorkouts, getWorkout, categories, createCategory, createWorkout, updateWorkout, setWorkoutActive,
  weeklyPlan, setPlanDay, listClasses, createClass, updateClass, setClassActive,
};
