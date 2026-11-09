const db = require('../services/db');

const SLOT_ORDER = { breakfast: 1, lunch: 2, snack: 3, dinner: 4, supplement: 5 };

const ITEM = `i.id, i.plan_day::text as "day", i.meal_slot as "mealSlot", i.title, i.details, i.calories,
  (c.item_id is not null) as "done", c.completed_at as "completedAt"`;

/** One member's plan for one day, in meal order, with what they have ticked. */
async function itemsForDay(memberId, day) {
  const { rows } = await db.query(
    `select ${ITEM} from diet_items i left join diet_completions c on c.item_id = i.id
     where i.member_id = $1 and i.plan_day = $2 order by i.sort_order, i.created_at`,
    [memberId, day]
  );
  return rows;
}

/** Planned and ticked counts for each of the 7 days starting at weekStart. */
async function weekSummary(memberId, weekStart) {
  const { rows } = await db.query(
    `select d::date::text as day,
            count(i.id)::int as total, count(c.item_id)::int as done
     from generate_series($2::date, $2::date + 6, interval '1 day') d
     left join diet_items i on i.member_id = $1 and i.plan_day = d::date
     left join diet_completions c on c.item_id = i.id
     group by d order by d`,
    [memberId, weekStart]
  );
  return rows;
}

async function setDone(itemId, memberId, done) {
  const owned = await db.query('select 1 from diet_items where id = $1 and member_id = $2', [itemId, memberId]);
  if (!owned.rowCount) return false;
  if (done) {
    await db.query(
      'insert into diet_completions (item_id, member_id) values ($1, $2) on conflict (item_id) do nothing',
      [itemId, memberId]
    );
  } else {
    await db.query('delete from diet_completions where item_id = $1 and member_id = $2', [itemId, memberId]);
  }
  return true;
}

async function countForDay(memberId, day) {
  const { rows } = await db.query('select count(*)::int n from diet_items where member_id = $1 and plan_day = $2', [memberId, day]);
  return rows[0].n;
}

async function createItem({ memberId, day, mealSlot, title, details, calories, createdBy }) {
  const { rows } = await db.query(
    `insert into diet_items (member_id, plan_day, meal_slot, title, details, calories, sort_order, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [memberId, day, mealSlot, title, details, calories, SLOT_ORDER[mealSlot], createdBy]
  );
  return rows[0].id;
}

/** Copies every item of one day onto another day (not ticked). Returns how many were copied. */
async function copyDay({ memberId, from, to, createdBy }) {
  const { rowCount } = await db.query(
    `insert into diet_items (member_id, plan_day, meal_slot, title, details, calories, sort_order, created_by)
     select member_id, $3::date, meal_slot, title, details, calories, sort_order, $4
     from diet_items where member_id = $1 and plan_day = $2::date`,
    [memberId, from, to, createdBy]
  );
  return rowCount;
}

async function findItem(itemId) {
  const { rows } = await db.query('select id, member_id as "memberId", plan_day::text as day from diet_items where id = $1', [itemId]);
  return rows[0] ?? null;
}

async function removeItem(itemId) {
  const { rowCount } = await db.query('delete from diet_items where id = $1', [itemId]);
  return rowCount > 0;
}

/** Share of the last 7 days' planned items that were ticked, or null when nothing was planned. */
async function adherence(memberId) {
  const { rows } = await db.query(
    `select (select count(*)::int from diet_items i where i.member_id = $1 and i.plan_day between current_date - 6 and current_date) as planned,
            (select count(*)::int from diet_completions c join diet_items i on i.id = c.item_id
               where c.member_id = $1 and i.plan_day between current_date - 6 and current_date) as done`,
    [memberId]
  );
  return rows[0];
}

module.exports = { itemsForDay, weekSummary, setDone, countForDay, createItem, copyDay, findItem, removeItem, adherence };
