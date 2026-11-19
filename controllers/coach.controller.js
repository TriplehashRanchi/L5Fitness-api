/** What the coach sets and sees per client (targets, daily compliance), and what the member reports (steps). */
const targets = require('../models/targets.model');
const activity = require('../models/activity.model');
const meals = require('../models/meal.model');
const water = require('../models/water.model');
const diet = require('../models/diet.model');
const coaching = require('../models/coaching.model');
const { requireClient } = require('./diet.controller');
const { withPhotoUrl } = require('./fitness.controller');
const notifyMember = require('../services/notify-member');
const { HttpError } = require('../middleware/errors');
const { readDay, readInt, addDays, dayToMs, DAY_MS } = require('./validate');

/** null / '' clears a target; otherwise a whole number in range. */
const optionalInt = (value, name, min, max) => (value == null || value === '' ? null : readInt(value, name, min, max));

// ── Member side ───────────────────────────────────────────────────────────────────────────────

const STEP_HISTORY_DAYS = 35;

/** A day from the phone that is today or up to 35 days back (the phone's health app keeps that history). */
function readStepDay(value) {
  const day = readDay(value, 'day');
  const age = Date.now() - dayToMs(day);
  if (age < -2 * DAY_MS || age > (STEP_HISTORY_DAYS + 2) * DAY_MS)
    throw new HttpError(400, 'INVALID_DATE', `"day" must be within the last ${STEP_HISTORY_DAYS} days.`);
  return day;
}

/** PUT /me/steps { entries: [{ day, steps }] }: the phone reports its step counts (up to 40 days at once). */
async function saveSteps(req, res) {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || !entries.length || entries.length > 40)
    throw new HttpError(400, 'INVALID_VALUE', '"entries" must list 1 to 40 days.');
  const clean = entries.map((e) => ({ day: readStepDay(e?.day), steps: readInt(e?.steps, 'steps', 0, 200_000) }));
  await activity.saveSteps(req.user.id, clean);
  res.json({ saved: clean.length });
}

/** GET /me/steps?to=YYYY-MM-DD&days=30: the saved steps for each of the days up to `to`, oldest first. */
async function myStepHistory(req, res) {
  const to = readDay(req.query.to, 'to');
  const days = req.query.days === undefined ? 30 : readInt(Number(req.query.days), 'days', 1, 92);
  const from = addDays(to, -(days - 1));
  const [goal, rows] = await Promise.all([targets.effective(req.user.id), activity.stepsBetween(req.user.id, from, to)]);
  res.json({ from, to, goal: goal.steps, prescribed: goal.prescribed.steps, days: rows });
}

/**
 * GET /me/activity?to=YYYY-MM-DD&days=30: one row per day up to `to`, oldest first, with the member's steps,
 * water, meals and workouts, plus the goals to measure them against. Powers the month view on the Activity page.
 */
async function myActivity(req, res) {
  const to = readDay(req.query.to, 'to');
  const days = req.query.days === undefined ? 30 : readInt(Number(req.query.days), 'days', 1, 92);
  const from = addDays(to, -(days - 1));
  const [goal, rows] = await Promise.all([targets.effective(req.user.id), activity.range(req.user.id, from, to)]);
  res.json({ from, to, goals: { steps: goal.steps, waterMl: goal.waterMl }, days: rows });
}

/** GET /me/targets: what the dietitian prescribed (falls back to the member's own settings). */
async function myTargets(req, res) {
  res.json({ targets: await targets.effective(req.user.id) });
}

/**
 * GET /me/day?day=YYYY-MM-DD: everything the dietitian planned for this member on one day, and how much
 * is done. Powers the app's Activity page and the "Today's plan" page.
 */
async function myDay(req, res) {
  const day = readDay(req.query.day, 'day');
  const userId = req.user.id;
  const care = await coaching.status(userId);
  const accepted = care.status === 'accepted';
  const [goal, steps, waterSummary, mealRows, items, workouts, training] = await Promise.all([
    targets.effective(userId),
    activity.stepsForDay(userId, day),
    water.summaryForDay(userId, day),
    meals.listForDay(userId, day),
    accepted ? diet.itemsForDay(userId, day) : [],
    activity.workoutsForDay(userId, day),
    accepted ? coaching.trainingFor(userId, day) : null,
  ]);
  const trainingDone = training ? await activity.planDone(userId, training.title, day) : false;
  const dietDone = items.filter((i) => i.done).length;

  // Every planned thing counts the same: each diet item, the workout, water, steps.
  const parts = [
    ...items.map((i) => (i.done ? 1 : 0)),
    ...(training ? [trainingDone ? 1 : 0] : []),
    Math.min(1, waterSummary.totalMl / (goal.waterMl || 1)),
    Math.min(1, (steps ?? 0) / (goal.steps || 1)),
  ];
  const percent = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100);

  res.json({
    day,
    coaching: care,
    targets: goal,
    percent,
    training: training ? { ...training, done: trainingDone } : null,
    diet: { total: items.length, done: dietDone, items },
    water: { totalMl: waterSummary.totalMl, goalMl: goal.waterMl },
    steps: { value: steps, goal: goal.steps },
    meals: await Promise.all(mealRows.map(withPhotoUrl)),
    workouts,
  });
}

// ── Coach side ────────────────────────────────────────────────────────────────────────────────

/** GET /dietitian/clients/:id/targets */
async function getTargets(req, res) {
  const { id } = await requireClient(req);
  res.json({ targets: await targets.get(id) });
}

/** PUT /dietitian/clients/:id/targets { waterMl, steps, calories, proteinG, weeklyWorkouts } (null clears one) */
async function saveTargets(req, res) {
  const { id } = await requireClient(req);
  const b = req.body ?? {};
  const t = {
    waterMl: optionalInt(b.waterMl, 'waterMl', 500, 10_000),
    steps: optionalInt(b.steps, 'steps', 1000, 100_000),
    calories: optionalInt(b.calories, 'calories', 800, 6000),
    proteinG: optionalInt(b.proteinG, 'proteinG', 0, 500),
    weeklyWorkouts: optionalInt(b.weeklyWorkouts, 'weeklyWorkouts', 1, 7),
  };
  const saved = await targets.save(id, t, req.user.id);
  notifyMember.targetsUpdated(id, { id: req.user.id, name: req.user.name });
  res.json({ targets: saved });
}

/** GET /dietitian/clients/:id/day?day=YYYY-MM-DD: everything the client did on one day, against targets. */
async function clientDay(req, res) {
  const { id } = await requireClient(req);
  const day = readDay(req.query.day, 'day');
  const [goal, steps, waterSummary, mealRows, items, workouts, training] = await Promise.all([
    targets.effective(id),
    activity.stepsForDay(id, day),
    water.summaryForDay(id, day),
    meals.listForDay(id, day),
    diet.itemsForDay(id, day),
    activity.workoutsForDay(id, day),
    coaching.trainingFor(id, day),
  ]);
  res.json({
    day,
    targets: goal,
    steps: { value: steps, goal: goal.steps },
    water: { totalMl: waterSummary.totalMl, goalMl: goal.waterMl },
    meals: await Promise.all(mealRows.map(withPhotoUrl)),
    diet: { total: items.length, done: items.filter((i) => i.done).length, items },
    workouts,
    training,
  });
}

/** GET /dietitian/clients/:id/week?weekStart=YYYY-MM-DD: 7 days of compliance in one table. */
async function clientWeek(req, res) {
  const { id } = await requireClient(req);
  const weekStart = req.query.weekStart ? readDay(req.query.weekStart, 'weekStart') : addDays(new Date().toISOString().slice(0, 10), -6);
  const [goal, days] = await Promise.all([targets.effective(id), activity.week(id, weekStart)]);
  res.json({ weekStart, targets: goal, days });
}

module.exports = { saveSteps, myStepHistory, myActivity, myDay, myTargets, getTargets, saveTargets, clientDay, clientWeek };
