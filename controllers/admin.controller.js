/** The admin's tools: dashboard, dietitians, member assignment, and the gym's catalog. */
const admin = require('../models/admin.model');
const adminSession = require('../services/admin-session');
const members = require('../models/member.model');
const { HttpError } = require('../middleware/errors');
const { isUuid, readInt } = require('./validate');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LEVELS = ['beginner', 'intermediate', 'advanced', 'all'];
// The icon keys the mobile app knows how to draw.
const ICONS = ['dumbbell', 'strength', 'functional', 'run', 'yoga', 'mobility', 'boxing', 'flame', 'core', 'bolt'];

const text = (value, name, min, max, { optional = false } = {}) => {
  const t = typeof value === 'string' ? value.trim() : '';
  if (!t && optional) return null;
  if (t.length < min || t.length > max)
    throw new HttpError(400, 'INVALID_VALUE', `"${name}" must be ${min === 1 ? 'filled in' : `at least ${min} characters`} and at most ${max}.`);
  return t;
};
const pick = (value, list, name) => {
  if (!list.includes(value)) throw new HttpError(400, 'INVALID_VALUE', `"${name}" must be one of: ${list.join(', ')}.`);
  return value;
};
const flag = (value, name, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new HttpError(400, 'INVALID_VALUE', `"${name}" must be true or false.`);
  return value;
};
const uuidParam = (req, what) => {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'NOT_FOUND', `${what} not found.`);
  return req.params.id;
};

// ── Dashboard ─────────────────────────────────────────────────────────────────────────────────

async function overview(req, res) {
  res.json({ overview: await admin.overview() });
}

// ── Dietitians ────────────────────────────────────────────────────────────────────────────────

async function listDietitians(req, res) {
  res.json(await admin.listDietitians());
}

/** POST /admin/dietitians { email } */
async function inviteDietitian(req, res) {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  const result = await admin.inviteDietitian(email, req.user.id);
  if (result === 'admin') throw new HttpError(409, 'IS_ADMIN', 'That email belongs to the admin.');
  if (result === 'already') throw new HttpError(409, 'ALREADY_DIETITIAN', 'That person is already a dietitian.');
  res.status(201).json({ result, email });
}

async function removeInvite(req, res) {
  const email = decodeURIComponent(req.params.email || '');
  if (!(await admin.removeInvite(email))) throw new HttpError(404, 'INVITE_NOT_FOUND', 'No pending invitation for that email.');
  res.status(204).end();
}

/** DELETE /admin/dietitians/:id: they become an ordinary member; their clients are unassigned. */
async function removeDietitian(req, res) {
  if (typeof req.params.id !== 'string' || !(await admin.demoteDietitian(req.params.id)))
    throw new HttpError(404, 'DIETITIAN_NOT_FOUND', 'Dietitian not found.');
  res.status(204).end();
}

/** PATCH /admin/dietitians/:id { disabled } */
async function updateDietitian(req, res) {
  const disabled = flag(req.body?.disabled, 'disabled');
  if (disabled === undefined) throw new HttpError(400, 'NOTHING_TO_UPDATE', 'Send "disabled": true or false.');
  if (!(await admin.setDisabled(req.params.id, disabled))) throw new HttpError(404, 'DIETITIAN_NOT_FOUND', 'Dietitian not found.');
  res.json({ id: req.params.id, disabled });
}

// ── Members ───────────────────────────────────────────────────────────────────────────────────

/** GET /admin/members?q=&filter=all|unassigned|assigned&page=1 */
async function listMembers(req, res) {
  const filter = ['all', 'unassigned', 'assigned'].includes(req.query.filter) ? req.query.filter : 'all';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  const limit = 25;
  const page = Math.max(1, Math.min(10_000, parseInt(req.query.page, 10) || 1));
  const result = await admin.listMembers({ search: q || undefined, filter, limit, offset: (page - 1) * limit });
  res.json({ ...result, page, pageSize: limit });
}

/** PUT /admin/members/:id/assignment { dietitianId: string | null } */
async function setAssignment(req, res) {
  const dietitianId = req.body?.dietitianId;
  if (dietitianId !== null && (typeof dietitianId !== 'string' || !dietitianId || dietitianId.length > 128))
    throw new HttpError(400, 'INVALID_VALUE', '"dietitianId" must be a dietitian id, or null to remove the assignment.');
  const result = await admin.setAssignment(req.params.id, dietitianId, req.user.id);
  if (result === 'no-member') throw new HttpError(404, 'MEMBER_NOT_FOUND', 'Member not found.');
  if (result === 'no-dietitian') throw new HttpError(400, 'DIETITIAN_NOT_AVAILABLE', 'That dietitian does not exist or is disabled.');
  res.json({ memberId: req.params.id, dietitianId });
}

// ── Workouts and categories ───────────────────────────────────────────────────────────────────

function readWorkout(b = {}) {
  return {
    title: text(b.title, 'title', 2, 80),
    categorySlug: text(b.categorySlug, 'categorySlug', 1, 60),
    level: pick(b.level, LEVELS, 'level'),
    durationMin: readInt(b.durationMin, 'durationMin', 1, 600),
    kcalEstimate: readInt(b.kcalEstimate, 'kcalEstimate', 0, 5000),
    exerciseCount: b.exerciseCount == null || b.exerciseCount === '' ? null : readInt(b.exerciseCount, 'exerciseCount', 1, 100),
    focus: text(b.focus, 'focus', 0, 80, { optional: true }),
    coach: text(b.coach, 'coach', 0, 60, { optional: true }),
    icon: pick(b.icon ?? 'dumbbell', ICONS, 'icon'),
    isProgram: flag(b.isProgram, 'isProgram', false),
    isActive: flag(b.isActive, 'isActive', true),
  };
}

async function listWorkouts(req, res) {
  res.json({ workouts: await admin.listWorkouts(), categories: await admin.categories(), levels: LEVELS, icons: ICONS });
}

async function createWorkout(req, res) {
  const data = readWorkout(req.body);
  if (!(await admin.categories()).some((c) => c.slug === data.categorySlug))
    throw new HttpError(400, 'INVALID_CATEGORY', 'Choose an existing category.');
  res.status(201).json({ workout: await admin.createWorkout(data) });
}

async function updateWorkout(req, res) {
  const id = uuidParam(req, 'Workout');
  const data = readWorkout(req.body);
  if (!(await admin.categories()).some((c) => c.slug === data.categorySlug))
    throw new HttpError(400, 'INVALID_CATEGORY', 'Choose an existing category.');
  const workout = await admin.updateWorkout(id, data);
  if (!workout) throw new HttpError(404, 'NOT_FOUND', 'Workout not found.');
  res.json({ workout });
}

/** DELETE /admin/workouts/:id switches it off (history keeps pointing at it). */
async function deactivateWorkout(req, res) {
  if (!(await admin.setWorkoutActive(uuidParam(req, 'Workout'), false))) throw new HttpError(404, 'NOT_FOUND', 'Workout not found.');
  res.status(204).end();
}

async function createCategory(req, res) {
  res.status(201).json({ category: await admin.createCategory(text(req.body?.name, 'name', 2, 40)) });
}

async function weeklyPlan(req, res) {
  res.json({ plan: await admin.weeklyPlan() });
}

/** PUT /admin/plan/:weekday { workoutId }: weekday 0 = Sunday … 6 = Saturday */
async function setPlanDay(req, res) {
  const weekday = Number(req.params.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new HttpError(400, 'INVALID_WEEKDAY', 'Weekday must be 0 (Sunday) to 6 (Saturday).');
  if (!isUuid(req.body?.workoutId) || !(await admin.setPlanDay(weekday, req.body.workoutId)))
    throw new HttpError(400, 'INVALID_WORKOUT', 'Choose an active workout.');
  res.json({ plan: await admin.weeklyPlan() });
}

// ── Class timetable ───────────────────────────────────────────────────────────────────────────

function readClass(b = {}) {
  const weekdays = Array.isArray(b.weekdays) ? [...new Set(b.weekdays)] : [];
  if (!weekdays.length || !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))
    throw new HttpError(400, 'INVALID_WEEKDAYS', 'Choose at least one weekday (0 = Sunday … 6 = Saturday).');
  if (typeof b.startTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.startTime))
    throw new HttpError(400, 'INVALID_TIME', 'Start time must look like 06:30.');
  return {
    name: text(b.name, 'name', 2, 60),
    trainer: text(b.trainer, 'trainer', 2, 60),
    icon: pick(b.icon ?? 'bolt', ICONS, 'icon'),
    weekdays: weekdays.sort((a, c) => a - c),
    startTime: b.startTime,
    durationMin: readInt(b.durationMin, 'durationMin', 5, 300),
    capacity: readInt(b.capacity, 'capacity', 1, 500),
    isActive: flag(b.isActive, 'isActive', true),
  };
}

const duplicate = (err) => {
  if (err.code === '23505') throw new HttpError(409, 'CLASS_EXISTS', 'A class with that name already starts at that time.');
  throw err;
};

async function listClasses(req, res) {
  res.json({ classes: await admin.listClasses(), icons: ICONS });
}

async function createClass(req, res) {
  const data = readClass(req.body);
  res.status(201).json({ class: await admin.createClass(data).catch(duplicate) });
}

async function updateClass(req, res) {
  const id = uuidParam(req, 'Class');
  const cls = await admin.updateClass(id, readClass(req.body)).catch(duplicate);
  if (!cls) throw new HttpError(404, 'NOT_FOUND', 'Class not found.');
  res.json({ class: cls });
}

async function deactivateClass(req, res) {
  if (!(await admin.setClassActive(uuidParam(req, 'Class'), false))) throw new HttpError(404, 'NOT_FOUND', 'Class not found.');
  res.status(204).end();
}

// ── Who am I (for the console's sign-in gate) ─────────────────────────────────────────────────

/** GET /staff/me: any signed-in person. The console only lets in dietitians and the admin. */
async function staffMe(req, res) {
  const who = (await members.get(req.user.id)) ?? { role: 'member', disabled: false };
  if (req.user.localAdmin) who.disabled = false;
  res.json({
    staff: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      image: req.user.image,
      role: who.role,
      disabled: who.disabled,
      allowed: ['admin', 'dietitian'].includes(who.role) && !who.disabled,
    },
  });
}

/** POST /staff/login { email, password }: the admin's sign-in (not for anyone else). */
async function adminLogin(req, res) {
  const { email, password } = req.body ?? {};
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 254 || password.length > 200)
    throw new HttpError(400, 'INVALID_LOGIN', 'Enter your email and password.');
  const reason = adminSession.unavailableReason();
  if (reason) {
    console.error('[admin] login refused:', reason);
    throw new HttpError(503, 'ADMIN_LOGIN_OFF', 'Admin password sign-in is not switched on for this server.');
  }
  const token = await adminSession.login(email, password);
  // The same answer whether the email or the password was wrong.
  if (!token) throw new HttpError(401, 'INVALID_LOGIN', 'Incorrect email or password.');
  res.json({ token, expiresInHours: adminSession.SESSION_HOURS });
}

module.exports = {
  adminLogin,
  overview, listDietitians, inviteDietitian, removeInvite, removeDietitian, updateDietitian,
  listMembers, setAssignment,
  listWorkouts, createWorkout, updateWorkout, deactivateWorkout, createCategory, weeklyPlan, setPlanDay,
  listClasses, createClass, updateClass, deactivateClass, staffMe,
};
