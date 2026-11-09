/** Settings, water intake, meals (with photos in the storage bucket), and account deletion. */
const profiles = require('../models/profile.model');
const water = require('../models/water.model');
const meals = require('../models/meal.model');
const uploads = require('../models/upload.model');
const account = require('../models/account.model');
const storage = require('../services/storage');
const { forget } = require('../middleware/require-auth');
const { withPhotoUrl } = require('./fitness.controller');
const { HttpError } = require('../middleware/errors');
const { isUuid, readDay, readToday, readInt, dayToMs, DAY_MS } = require('./validate');

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'];

// ── Settings ──────────────────────────────────────────────────────────────────────────────────

async function getSettings(req, res) {
  res.json({ settings: await profiles.getSettings(req.user.id) });
}

/** PUT /me/settings: send only what changed, e.g. { "stepGoal": 8000 }. */
async function updateSettings(req, res) {
  const body = req.body ?? {};
  const fields = {};
  if (body.weeklyGoal !== undefined) fields.weeklyGoal = readInt(body.weeklyGoal, 'weeklyGoal', 1, 7);
  if (body.stepGoal !== undefined) fields.stepGoal = readInt(body.stepGoal, 'stepGoal', 1000, 100_000);
  if (body.waterGoalMl !== undefined) fields.waterGoalMl = readInt(body.waterGoalMl, 'waterGoalMl', 500, 10_000);
  if (!Object.keys(fields).length)
    throw new HttpError(400, 'NOTHING_TO_UPDATE', 'Send at least one setting to change.');
  res.json({ settings: await profiles.updateSettings(req.user.id, fields) });
}

// ── Water ─────────────────────────────────────────────────────────────────────────────────────

/** POST /water { amountMl, day } */
async function addWater(req, res) {
  const amountMl = readInt(req.body?.amountMl, 'amountMl', 1, 2000);
  const day = readToday(req.body?.day, 'day');
  const entry = await water.add({ userId: req.user.id, amountMl, day });
  const settings = await profiles.getSettings(req.user.id);
  res.status(201).json({ entry, water: { ...(await water.summaryForDay(req.user.id, day)), goalMl: settings.waterGoalMl } });
}

/** GET /water?day=YYYY-MM-DD */
async function listWater(req, res) {
  const day = readDay(req.query.day, 'day');
  const settings = await profiles.getSettings(req.user.id);
  res.json({
    day,
    entries: await water.listForDay(req.user.id, day),
    water: { ...(await water.summaryForDay(req.user.id, day)), goalMl: settings.waterGoalMl },
  });
}

/** DELETE /water/:id?day=YYYY-MM-DD: the "undo" of a drink. Returns the day's new total. */
async function removeWater(req, res) {
  const day = readDay(req.query.day, 'day');
  if (!isUuid(req.params.id) || !(await water.remove(req.params.id, req.user.id)))
    throw new HttpError(404, 'WATER_NOT_FOUND', 'That entry was not found.');
  const settings = await profiles.getSettings(req.user.id);
  res.json({ water: { ...(await water.summaryForDay(req.user.id, day)), goalMl: settings.waterGoalMl } });
}

// ── Meals ─────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /meals { mealType, note?, uploadId?, eatenAt, day }
 * The photo is uploaded first with POST /uploads (signed link), then attached here by its id.
 */
async function createMeal(req, res) {
  const body = req.body ?? {};
  if (!MEAL_TYPES.includes(body.mealType))
    throw new HttpError(400, 'INVALID_MEAL_TYPE', 'Choose breakfast, lunch, dinner or snack.');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 200) throw new HttpError(400, 'NOTE_TOO_LONG', 'Keep the note under 200 characters.');

  const eatenAt = new Date(typeof body.eatenAt === 'string' ? body.eatenAt : NaN);
  const eatenMs = eatenAt.getTime();
  if (Number.isNaN(eatenMs) || eatenMs > Date.now() + 5 * 60_000 || eatenMs < Date.now() - 2 * DAY_MS)
    throw new HttpError(400, 'INVALID_TIME', 'The meal time must be within the last 2 days.');
  const day = readToday(body.day, 'day');
  if (Math.abs(dayToMs(day) - dayToMs(eatenAt.toISOString().slice(0, 10))) > DAY_MS)
    throw new HttpError(400, 'INVALID_DATE', '"day" does not match the meal time.');

  if (!note && !body.uploadId)
    throw new HttpError(400, 'EMPTY_MEAL', 'Add a photo or a note to save a meal.');

  let uploadId = null;
  if (body.uploadId != null) {
    // The photo must be this member's own and fully uploaded.
    const upload = isUuid(body.uploadId) ? await uploads.findForUser(body.uploadId, req.user.id) : null;
    if (!upload || upload.status !== 'ready') throw new HttpError(404, 'UPLOAD_NOT_FOUND', 'The photo was not found. Upload it again.');
    uploadId = upload.id;
  }

  let meal;
  try {
    meal = await meals.create({ userId: req.user.id, mealType: body.mealType, note: note || null, uploadId, day, eatenAt });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'PHOTO_ALREADY_USED', 'That photo is already attached to a meal.');
    throw err;
  }
  const { photoKey, uploadId: _unused, ...rest } = meal; // eslint-disable-line no-unused-vars
  res.status(201).json({ meal: await withPhotoUrl({ ...rest, photoKey }) });
}

/** GET /meals?day=YYYY-MM-DD */
async function listMeals(req, res) {
  const day = readDay(req.query.day, 'day');
  const rows = await meals.listForDay(req.user.id, day);
  res.json({ day, meals: await Promise.all(rows.map(withPhotoUrl)) });
}

/** DELETE /meals/:id: removes the meal and its photo (the file and its record). */
async function removeMeal(req, res) {
  const meal = isUuid(req.params.id) ? await meals.findForUser(req.params.id, req.user.id) : null;
  if (!meal) throw new HttpError(404, 'MEAL_NOT_FOUND', 'Meal not found.');
  // Photo file first: if that fails the meal stays and the delete can be retried.
  if (meal.photoKey) await storage.remove(meal.photoKey);
  await meals.remove(meal.id, req.user.id);
  if (meal.uploadId) await uploads.remove(meal.uploadId, req.user.id);
  res.status(204).end();
}

// ── Account ───────────────────────────────────────────────────────────────────────────────────

/**
 * DELETE /me: erases everything we store about the member (database rows and their files).
 * The app then deletes the Firebase sign-in itself. Safe to call again if something was missed.
 */
async function deleteAccountData(req, res) {
  const keys = await account.deleteAllData(req.user.id);
  forget(req.user.id);
  let failed = 0;
  for (const key of keys) {
    try {
      await storage.remove(key);
    } catch (err) {
      failed += 1;
      console.error('[account] could not delete a stored file:', err.message);
    }
  }
  res.json({ deleted: true, files: keys.length, filesNotRemoved: failed });
}

module.exports = {
  getSettings, updateSettings, addWater, listWater, removeWater,
  createMeal, listMeals, removeMeal, deleteAccountData,
};
