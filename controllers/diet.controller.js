/** Diet plans: members read and tick them; dietitians write them. */
const diet = require('../models/diet.model');
const profiles = require('../models/body-profile.model');
const members = require('../models/member.model');
const logs = require('../models/log.model');
const { withAge } = require('./profile.controller');
const { HttpError } = require('../middleware/errors');
const { isUuid, readDay, readInt, dayToMs, DAY_MS } = require('./validate');

const SLOTS = ['breakfast', 'lunch', 'snack', 'dinner', 'supplement'];
const MAX_ITEMS_PER_DAY = 30;
const MAX_DAYS_AWAY = 120;

/** Plans can be written for about four months either side of today. */
function readPlanDay(value, name = 'day') {
  const day = readDay(value, name);
  if (Math.abs(dayToMs(day) - Date.now()) > MAX_DAYS_AWAY * DAY_MS)
    throw new HttpError(400, 'INVALID_DATE', `"${name}" is too far from today.`);
  return day;
}

// ── Member ────────────────────────────────────────────────────────────────────────────────────

/** GET /diet?day=YYYY-MM-DD&weekStart=YYYY-MM-DD */
async function getMyDiet(req, res) {
  const day = readPlanDay(req.query.day);
  const weekStart = req.query.weekStart ? readPlanDay(req.query.weekStart, 'weekStart') : day;
  const [items, week, profile] = await Promise.all([
    diet.itemsForDay(req.user.id, day),
    diet.weekSummary(req.user.id, weekStart),
    profiles.get(req.user.id),
  ]);
  res.json({
    day,
    items,
    summary: { total: items.length, done: items.filter((i) => i.done).length },
    week,
    // Without consent a dietitian cannot see this member, so no plan will appear.
    sharing: profile?.shareWithDietitian ?? false,
  });
}

async function setItemDone(req, res, done) {
  if (!isUuid(req.params.id) || !(await diet.setDone(req.params.id, req.user.id, done)))
    throw new HttpError(404, 'ITEM_NOT_FOUND', 'That item was not found.');
  res.json({ id: req.params.id, done });
}
const markDone = (req, res) => setItemDone(req, res, true);
const markUndone = (req, res) => setItemDone(req, res, false);

// ── Dietitian ─────────────────────────────────────────────────────────────────────────────────

/**
 * Can this staff member work with this member? A dietitian: only members assigned to them.
 * The admin: any member. Either way the member must have finished setup AND agreed to share.
 */
async function canManage(req, memberId) {
  if (typeof memberId !== 'string' || !memberId || memberId.length > 128) return null;
  const profile = await profiles.get(memberId);
  if (!profile || !profile.shareWithDietitian) return null;
  if (req.staff.role === 'dietitian' && !(await members.isAssigned(memberId, req.user.id))) return null;
  return profile;
}

/** A client of the person asking. Anyone else is "not found" (we do not reveal who exists). */
async function requireClient(req) {
  const profile = await canManage(req, req.params.id);
  if (!profile) throw new HttpError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
  return { id: req.params.id, profile };
}

/** GET /dietitian/clients?q= */
async function listClients(req, res) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  res.json({
    clients: await members.listClients({
      search: q || undefined,
      dietitianId: req.staff.role === 'dietitian' ? req.user.id : undefined,
    }),
  });
}

/** GET /dietitian/clients/:id */
async function clientDetail(req, res) {
  const { id, profile } = await requireClient(req);
  const [who, history, adherence, history14] = await Promise.all([
    members.get(id),
    profiles.weightHistory(id),
    diet.adherence(id),
    logs.history(id, { limit: 7 }),
  ]);
  res.json({
    client: who ? { id, name: who.name, email: who.email, image: who.image } : { id },
    profile: withAge(profile),
    weightHistory: history,
    adherence,
    recentWorkouts: history14.days,
  });
}

/** GET /dietitian/clients/:id/plan?day=&weekStart= */
async function clientPlan(req, res) {
  const { id } = await requireClient(req);
  const day = readPlanDay(req.query.day);
  const weekStart = req.query.weekStart ? readPlanDay(req.query.weekStart, 'weekStart') : day;
  const [items, week] = await Promise.all([diet.itemsForDay(id, day), diet.weekSummary(id, weekStart)]);
  res.json({ day, items, week });
}

/** POST /dietitian/clients/:id/plan { day, mealSlot, title, details?, calories? } */
async function addItem(req, res) {
  const { id } = await requireClient(req);
  const b = req.body ?? {};
  const day = readPlanDay(b.day);
  if (!SLOTS.includes(b.mealSlot)) throw new HttpError(400, 'INVALID_MEAL_SLOT', 'Choose a meal slot.');
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length < 1 || title.length > 100) throw new HttpError(400, 'INVALID_TITLE', 'Give the item a title of up to 100 characters.');
  const details = typeof b.details === 'string' && b.details.trim() ? b.details.trim() : null;
  if (details && details.length > 300) throw new HttpError(400, 'TEXT_TOO_LONG', 'Keep the details under 300 characters.');
  const calories = b.calories == null || b.calories === '' ? null : readInt(b.calories, 'calories', 0, 3000);
  if ((await diet.countForDay(id, day)) >= MAX_ITEMS_PER_DAY)
    throw new HttpError(409, 'DAY_FULL', `A day can have at most ${MAX_ITEMS_PER_DAY} items.`);

  const itemId = await diet.createItem({ memberId: id, day, mealSlot: b.mealSlot, title, details, calories, createdBy: req.user.id });
  res.status(201).json({ item: (await diet.itemsForDay(id, day)).find((i) => i.id === itemId) });
}

/** DELETE /dietitian/plan-items/:id */
async function removeItem(req, res) {
  const item = isUuid(req.params.id) ? await diet.findItem(req.params.id) : null;
  if (!item || !(await canManage(req, item.memberId))) throw new HttpError(404, 'ITEM_NOT_FOUND', 'That item was not found.');
  await diet.removeItem(item.id);
  res.status(204).end();
}

/** POST /dietitian/clients/:id/plan/copy { from, to } */
async function copyDay(req, res) {
  const { id } = await requireClient(req);
  const from = readPlanDay(req.body?.from, 'from');
  const to = readPlanDay(req.body?.to, 'to');
  if (from === to) throw new HttpError(400, 'SAME_DAY', 'Choose two different days.');
  const [source, target] = await Promise.all([diet.countForDay(id, from), diet.countForDay(id, to)]);
  if (!source) throw new HttpError(409, 'NOTHING_TO_COPY', 'The day you are copying from has no items.');
  if (source + target > MAX_ITEMS_PER_DAY) throw new HttpError(409, 'DAY_FULL', `A day can have at most ${MAX_ITEMS_PER_DAY} items.`);
  const copied = await diet.copyDay({ memberId: id, from, to, createdBy: req.user.id });
  res.status(201).json({ copied, items: await diet.itemsForDay(id, to) });
}

module.exports = { getMyDiet, markDone, markUndone, listClients, clientDetail, clientPlan, addItem, removeItem, copyDay };
