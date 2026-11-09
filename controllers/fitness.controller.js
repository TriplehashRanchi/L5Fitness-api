const workouts = require('../models/workout.model');
const logs = require('../models/log.model');
const profiles = require('../models/profile.model');
const water = require('../models/water.model');
const meals = require('../models/meal.model');
const storage = require('../services/storage');
const classes = require('../models/class.model');
const { HttpError } = require('../middleware/errors');
const { isUuid, readDay, readToday, readInt, addDays, weekdayOf, dayToMs, DAY_MS } = require('./validate');

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * GET /home?today=YYYY-MM-DD&weekStart=YYYY-MM-DD
 * Everything the Home screen shows, in one request. `today` and `weekStart` come from the phone
 * (its time zone and its first day of the week).
 */
async function home(req, res) {
  const today = readToday(req.query.today);
  const weekStart = req.query.weekStart ? readDay(req.query.weekStart, 'weekStart') : addDays(today, -6);
  if (weekStart > today || weekStart < addDays(today, -6))
    throw new HttpError(400, 'INVALID_DATE', '"weekStart" must be within the 7 days up to today.');
  const weekEnd = addDays(weekStart, 6);
  const userId = req.user.id;

  const [plan, stats, daysTrained, settings, categories, programs, todaysClasses, waterToday, mealsToday] = await Promise.all([
    workouts.planFor(weekdayOf(today)),
    logs.statsForDay(userId, today),
    logs.daysTrained(userId, weekStart, weekEnd),
    profiles.getSettings(userId),
    workouts.categories(),
    workouts.list({ programsOnly: true }),
    classes.gymToday().then((day) => classes.listForDate(day, userId)),
    water.summaryForDay(userId, today),
    meals.listForDay(userId, today),
  ]);
  const goal = settings.weeklyGoal;

  res.json({
    today,
    plan,
    stats,
    week: {
      start: weekStart,
      end: weekEnd,
      goal,
      daysTrained,
      done: daysTrained.length,
      percent: Math.min(100, Math.round((daysTrained.length / goal) * 100)),
    },
    categories,
    programs,
    classes: todaysClasses,
    settings,
    water: { ...waterToday, goalMl: settings.waterGoalMl },
    meals: await Promise.all(mealsToday.map(withPhotoUrl)),
  });
}

/** GET /workouts?category=strength&q=legs&programs=1 */
async function listWorkouts(req, res) {
  const search = text(req.query.q).slice(0, 60);
  const category = text(req.query.category).toLowerCase().slice(0, 40);
  res.json({
    workouts: await workouts.list({
      category: category || undefined,
      search: search || undefined,
      programsOnly: req.query.programs === '1',
    }),
  });
}

async function listCategories(req, res) {
  res.json({ categories: await workouts.categories() });
}

/**
 * POST /workout-logs — record a finished workout.
 *   From the catalog: { workoutId, startedAt, durationMin, day, avgHeartRate? }
 *   Anything else:    { title, calories?, startedAt, durationMin, day, avgHeartRate? }
 */
async function createLog(req, res) {
  const body = req.body ?? {};
  const durationMin = readInt(body.durationMin, 'durationMin', 1, 600);
  const day = readDay(body.day, 'day');

  const startedAt = new Date(typeof body.startedAt === 'string' ? body.startedAt : NaN);
  const startedMs = startedAt.getTime();
  if (Number.isNaN(startedMs) || startedMs > Date.now() + 5 * 60_000 || startedMs < Date.now() - 7 * DAY_MS)
    throw new HttpError(400, 'INVALID_START', 'The workout start time must be within the last 7 days.');
  // `day` is the phone's calendar day; it can only be a day either side of the UTC date.
  if (Math.abs(dayToMs(day) - dayToMs(startedAt.toISOString().slice(0, 10))) > DAY_MS)
    throw new HttpError(400, 'INVALID_DATE', '"day" does not match the workout start time.');

  const avgHeartRate = body.avgHeartRate == null ? null : readInt(body.avgHeartRate, 'avgHeartRate', 30, 230);

  let workoutId = null;
  let title;
  let calories;
  if (body.workoutId != null) {
    const workout = isUuid(body.workoutId) ? await workouts.findById(body.workoutId) : null;
    if (!workout) throw new HttpError(404, 'WORKOUT_NOT_FOUND', 'Workout not found.');
    workoutId = workout.id;
    title = workout.title;
    // Worked out here, not sent by the app: the estimate for the part of the workout that was done.
    calories = Math.round((workout.kcal * durationMin) / workout.durationMin);
  } else {
    title = text(body.title);
    if (title.length < 1 || title.length > 80)
      throw new HttpError(400, 'INVALID_TITLE', 'Give the workout a name of up to 80 characters.');
    calories = body.calories == null ? 0 : readInt(body.calories, 'calories', 0, 5000);
  }

  const log = await logs.create({ userId: req.user.id, workoutId, title, startedAt, durationMin, calories, avgHeartRate, day });
  res.status(201).json({ log });
}

async function listLogs(req, res) {
  res.json({ logs: await logs.listRecent(req.user.id) });
}

/** GET /workout-logs/history?before=YYYY-MM-DD&limit=14: every day the member trained, newest first. */
async function logHistory(req, res) {
  const before = req.query.before ? readDay(req.query.before, 'before') : undefined;
  const limit = req.query.limit ? readInt(Number(req.query.limit), 'limit', 1, 30) : 14;
  const [page, summary] = await Promise.all([
    logs.history(req.user.id, { before, limit }),
    before ? Promise.resolve(null) : logs.lifetime(req.user.id), // totals only on the first page
  ]);
  res.json({ summary, ...page });
}

async function removeLog(req, res) {
  const removed = isUuid(req.params.id) && (await logs.remove(req.params.id, req.user.id));
  if (!removed) throw new HttpError(404, 'LOG_NOT_FOUND', 'Workout not found.');
  res.status(204).end();
}

/** A meal as the app sees it: the storage key is swapped for a short-lived link to the photo. */
async function withPhotoUrl({ photoKey, ...meal }) {
  return { ...meal, photoUrl: photoKey ? await storage.signDownload(photoKey) : null };
}

module.exports = { home, listWorkouts, listCategories, createLog, listLogs, logHistory, removeLog, withPhotoUrl };
