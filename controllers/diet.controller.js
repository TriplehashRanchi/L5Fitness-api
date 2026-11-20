/** Diet plans: members read and tick them; dietitians write them. */
const coaching = require('../models/coaching.model');
const diet = require('../models/diet.model');
const profiles = require('../models/body-profile.model');
const members = require('../models/member.model');
const logs = require('../models/log.model');
const { withAge } = require('./profile.controller');
const { HttpError } = require('../middleware/errors');
const notifyMember = require('../services/notify-member');
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
  const care = await coaching.status(req.user.id);
  const [items, week, profile] = await Promise.all([
    care.status === 'accepted' ? diet.itemsForDay(req.user.id, day) : [],
    care.status === 'accepted' ? diet.weekSummary(req.user.id, weekStart) : [],
    profiles.get(req.user.id),
  ]);
  res.json({
    day,
    coaching: care,
    items,
    summary: { total: items.length, done: items.filter((i) => i.done).length },
    week,
    // Without consent a dietitian cannot see this member, so no plan will appear.
    sharing: profile?.shareWithDietitian ?? false,
  });
}

async function setItemDone(req, res, done) {
  if ((await coaching.status(req.user.id)).status !== 'accepted')
    throw new HttpError(403, 'ACCEPTANCE_REQUIRED', 'Your dietitian must accept you before you can use this plan.');
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
  if ((await coaching.status(memberId)).status !== 'accepted') return null;
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
    requests: req.staff.role === 'dietitian' ? await coaching.requests(req.user.id) : [],
    clients: await members.listClients({
      search: q || undefined,
      dietitianId: req.staff.role === 'dietitian' ? req.user.id : undefined,
    }),
  });
}

/** GET /dietitian/clients/:id */
async function clientDetail(req, res) {
  const { id, profile } = await requireClient(req);
  const [care, who, history, adherence, history14] = await Promise.all([
    coaching.status(id),
    members.get(id),
    profiles.weightHistory(id),
    diet.adherence(id),
    logs.history(id, { limit: 7 }),
  ]);
  res.json({
    client: who ? { id, name: who.name, email: who.email, image: who.image, dietitianName: care.dietitianName } : { id },
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
  notifyMember.dietUpdated(id, { id: req.user.id, name: req.user.name });
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
  notifyMember.dietUpdated(id, { id: req.user.id, name: req.user.name });
  res.status(201).json({ copied, items: await diet.itemsForDay(id, to) });
}


/** Only a dietitian can personally accept a request. Admin assignment stays pending. */
async function acceptClient(req, res) {
  if (req.staff.role !== 'dietitian') throw new HttpError(403, 'FORBIDDEN', 'A dietitian must accept this client.');
  const id = req.params.id;
  if (!id || id.length > 128 || !(await coaching.accept(id, req.user.id)))
    throw new HttpError(409, 'CLIENT_UNAVAILABLE', 'This request is no longer available. Refresh your client list.');
  res.json({ accepted: true });
}

async function getTraining(req, res) {
  const { id } = await requireClient(req);
  const day = readPlanDay(req.query.day);
  res.json({ day, plan: await coaching.trainingFor(id, day) });
}

async function saveTraining(req, res) {
  const { id } = await requireClient(req);
  const b = req.body ?? {};
  const day = readPlanDay(b.day);
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const instructions = typeof b.instructions === 'string' ? b.instructions.trim() : '';
  if (!title || title.length > 80) throw new HttpError(400, 'INVALID_TITLE', 'Enter a workout title of up to 80 characters.');
  if (!instructions || instructions.length > 4000) throw new HttpError(400, 'INVALID_INSTRUCTIONS', 'Add exercises, sets, reps and notes (up to 4000 characters).');
  const durationMin = readInt(b.durationMin, 'durationMin', 1, 600);
  const kcal = b.kcal == null ? 0 : readInt(b.kcal, 'kcal', 0, 5000);
  const plan = await coaching.saveTraining({ memberId: id, day, title, instructions, durationMin, kcal, createdBy: req.user.id });
  notifyMember.trainingUpdated(id, { id: req.user.id, name: req.user.name }, title);
  res.json({ day, plan });
}

async function removeTraining(req, res) {
  const { id } = await requireClient(req);
  await coaching.removeTraining(id, readPlanDay(req.query.day));
  res.status(204).end();
}

module.exports = { canManage, requireClient, acceptClient, getTraining, saveTraining, removeTraining, getMyDiet, markDone, markUndone, listClients, clientDetail, clientPlan, addItem, removeItem, copyDay };
