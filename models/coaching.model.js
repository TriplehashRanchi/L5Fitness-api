const db = require('../services/db');

/** Consent and an enabled, accepted dietitian are required for personalized plans. */
async function status(memberId) {
  const { rows } = await db.query(
    `select coalesce(b.share_with_dietitian, false) as sharing,
       case when not coalesce(b.share_with_dietitian, false) then 'not_shared'
            when a.accepted_at is not null and d.role = 'dietitian' and not d.disabled then 'accepted'
            else 'pending' end as status,
       case when d.role = 'dietitian' and not d.disabled then d.name end as "dietitianName",
       a.dietitian_id as "dietitianId"
     from members m left join body_profiles b on b.user_id = m.user_id
     left join client_assignments a on a.member_id = m.user_id
     left join members d on d.user_id = a.dietitian_id where m.user_id = $1`, [memberId]);
  return rows[0] ?? { sharing: false, status: 'not_shared', dietitianName: null, dietitianId: null };
}

/** Only members the admin assigned to this dietitian and who are not yet active (e.g. no consent yet). */
async function requests(dietitianId) {
  const { rows } = await db.query(
    `select m.user_id as id, m.name, m.email, m.image from members m
     join client_assignments a on a.member_id = m.user_id and a.dietitian_id = $1
     where m.role = 'member' and not m.disabled and a.accepted_at is null
     order by a.assigned_at limit 100`, [dietitianId]);
  return rows;
}

/** Clients are assigned by the admin; this can only confirm an assignment made to this dietitian. */
async function accept(memberId, dietitianId) {
  const { rowCount } = await db.query(
    `update client_assignments a set accepted_at = coalesce(a.accepted_at, now())
     from members m, body_profiles b
     where a.member_id = $1 and a.dietitian_id = $2 and m.user_id = a.member_id and m.role = 'member' and not m.disabled
       and b.user_id = a.member_id and b.share_with_dietitian
       and exists (select 1 from members d where d.user_id = $2 and d.role = 'dietitian' and not d.disabled)`,
    [memberId, dietitianId]);
  return rowCount > 0;
}

const TRAINING = `p.id, p.title, p.duration_min as "durationMin", p.kcal_estimate as kcal,
  p.instructions, p.plan_day::text as day, 'personal' as slug, 'strength' as category,
  'all' as level, null::int as "exerciseCount", null::text as focus, d.name as coach,
  'dumbbell' as icon, false as "isProgram", true as personal`;

async function trainingFor(memberId, day) {
  const { rows } = await db.query(
    `select ${TRAINING} from client_training_plans p
     join client_assignments a on a.member_id = p.member_id and a.accepted_at is not null
     join members d on d.user_id = a.dietitian_id and d.role = 'dietitian' and not d.disabled
     join body_profiles b on b.user_id = p.member_id and b.share_with_dietitian
     where p.member_id = $1 and p.plan_day = $2`, [memberId, day]);
  return rows[0] ?? null;
}

async function findTraining(id, memberId) {
  const { rows } = await db.query(
    `select id, title, duration_min as "durationMin", kcal_estimate as kcal
     from client_training_plans where id = $1 and member_id = $2`, [id, memberId]);
  return rows[0] ?? null;
}

async function saveTraining({ memberId, day, title, durationMin, kcal, instructions, createdBy }) {
  await db.query(
    `insert into client_training_plans (member_id, plan_day, title, duration_min, kcal_estimate, instructions, created_by)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (member_id, plan_day) do update set title = excluded.title,
       duration_min = excluded.duration_min, kcal_estimate = excluded.kcal_estimate,
       instructions = excluded.instructions, created_by = excluded.created_by, updated_at = now()`,
    [memberId, day, title, durationMin, kcal, instructions, createdBy]);
  return trainingFor(memberId, day);
}

async function removeTraining(memberId, day) {
  await db.query('delete from client_training_plans where member_id = $1 and plan_day = $2', [memberId, day]);
}

module.exports = { status, requests, accept, trainingFor, findTraining, saveTraining, removeTraining };
