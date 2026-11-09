const db = require('../services/db');

const COLUMNS = `w.id, w.slug, w.title, w.category_slug as "category", w.level,
  w.duration_min as "durationMin", w.kcal_estimate as "kcal", w.exercise_count as "exerciseCount",
  w.focus, w.coach, w.icon, w.is_program as "isProgram"`;

/** `%` and `_` typed by a user must match themselves, not act as wildcards. */
const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

async function list({ category, search, programsOnly } = {}) {
  const where = ['w.is_active'];
  const params = [];
  if (category) {
    params.push(category);
    where.push(`w.category_slug = $${params.length}`);
  }
  if (search) {
    params.push(`%${escapeLike(search)}%`);
    where.push(`(w.title ilike $${params.length} or w.focus ilike $${params.length} or c.name ilike $${params.length})`);
  }
  if (programsOnly) where.push('w.is_program');

  const { rows } = await db.query(
    `select ${COLUMNS}
     from workouts w join workout_categories c on c.slug = w.category_slug
     where ${where.join(' and ')}
     order by w.sort_order, w.title
     limit 200`,
    params
  );
  return rows;
}

async function categories() {
  const { rows } = await db.query(
    `select c.slug, c.name, count(w.id)::int as "count"
     from workout_categories c
     left join workouts w on w.category_slug = c.slug and w.is_active
     group by c.slug, c.name, c.sort_order
     order by c.sort_order`
  );
  return rows;
}

async function findById(id) {
  const { rows } = await db.query(`select ${COLUMNS} from workouts w where w.id = $1 and w.is_active`, [id]);
  return rows[0] ?? null;
}

/** weekday: 0 = Sunday … 6 = Saturday */
async function planFor(weekday) {
  const { rows } = await db.query(
    `select ${COLUMNS} from plan_days p join workouts w on w.id = p.workout_id
     where p.weekday = $1 and w.is_active`,
    [weekday]
  );
  return rows[0] ?? null;
}

module.exports = { list, categories, findById, planFor };
