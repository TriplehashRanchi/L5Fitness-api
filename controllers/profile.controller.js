/** The setup answers a dietitian needs, plus weight tracking. */
const db = require('../services/db');
const profiles = require('../models/body-profile.model');
const members = require('../models/member.model');
const { HttpError } = require('../middleware/errors');
const { readDay, readToday } = require('./validate');

const GOALS = ['lose', 'maintain', 'gain'];
const SEXES = ['female', 'male', 'other'];
const ACTIVITY = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
const DIETS = ['vegetarian', 'non_vegetarian', 'eggetarian', 'vegan'];

const readEnum = (value, list, name) => {
  if (!list.includes(value)) throw new HttpError(400, 'INVALID_VALUE', `Choose a valid ${name}.`);
  return value;
};

/** A number with at most one decimal, within a range: 72.5 */
function readKg(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw new HttpError(400, 'INVALID_NUMBER', `"${name}" must be a number from ${min} to ${max}.`);
  return Math.round(value * 10) / 10;
}

function readText(value, max, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'INVALID_VALUE', `"${name}" must be text.`);
  const text = value.trim();
  if (text.length > max) throw new HttpError(400, 'TEXT_TOO_LONG', `Keep "${name}" under ${max} characters.`);
  return text || null;
}

function ageOf(birthDate, now = new Date()) {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) age -= 1;
  return age;
}

const withAge = (profile) => (profile ? { ...profile, age: ageOf(profile.birthDate) } : null);

/** GET /me/profile → { role, completed, profile, weightHistory } */
async function getProfile(req, res) {
  const [role, profile, history, onboarding] = await Promise.all([
    members.roleOf(req.user.id),
    profiles.get(req.user.id),
    profiles.weightHistory(req.user.id),
    db.query('select onboarding_completed_at from members where user_id = $1', [req.user.id]),
  ]);
  // Dietitians and the admin have no weight goal of their own, so they skip the member setup questions.
  res.json({ role, completed: !!profile || !!onboarding.rows[0]?.onboarding_completed_at || role !== 'member', profile: withAge(profile), weightHistory: history });
}

/** PUT /me/profile: the setup form (and "Edit details" later). */
async function saveProfile(req, res) {
  const b = req.body ?? {};
  const day = readToday(b.day, 'day');
  const goal = readEnum(b.goal, GOALS, 'goal');
  const weightKg = readKg(b.weightKg, 'weightKg', 25, 300);
  let targetWeightKg = readKg(b.targetWeightKg, 'targetWeightKg', 25, 300);

  if (goal === 'lose' && targetWeightKg >= weightKg)
    throw new HttpError(400, 'INVALID_TARGET', 'To lose weight, your target must be lower than your current weight.');
  if (goal === 'gain' && targetWeightKg <= weightKg)
    throw new HttpError(400, 'INVALID_TARGET', 'To gain weight, your target must be higher than your current weight.');
  if (goal === 'maintain') {
    if (Math.abs(targetWeightKg - weightKg) > 5)
      throw new HttpError(400, 'INVALID_TARGET', 'To maintain your weight, your target should be within 5 kg of it.');
  }

  const birthDate = readDay(b.birthDate, 'birthDate');
  const age = ageOf(birthDate);
  if (age < 12 || age > 100) throw new HttpError(400, 'INVALID_AGE', 'Age must be between 12 and 100.');

  if (typeof b.shareWithDietitian !== 'boolean')
    throw new HttpError(400, 'INVALID_VALUE', 'Say whether you agree to share this with your dietitian.');

  const profile = await profiles.save(
    req.user.id,
    {
      goal,
      sex: readEnum(b.sex, SEXES, 'sex'),
      birthDate,
      heightCm: readKg(b.heightCm, 'heightCm', 100, 250),
      weightKg,
      targetWeightKg,
      activityLevel: readEnum(b.activityLevel, ACTIVITY, 'activity level'),
      dietType: readEnum(b.dietType, DIETS, 'diet type'),
      allergies: readText(b.allergies, 300, 'allergies'),
      medicalNotes: readText(b.medicalNotes, 500, 'medicalNotes'),
      shareWithDietitian: b.shareWithDietitian,
    },
    day
  );
  res.json({ completed: true, profile: withAge(profile), weightHistory: await profiles.weightHistory(req.user.id) });
}

/** POST /me/weight { weightKg, day } */
async function addWeight(req, res) {
  const weightKg = readKg(req.body?.weightKg, 'weightKg', 25, 300);
  const day = readToday(req.body?.day, 'day');
  const entry = await profiles.addWeight(req.user.id, weightKg, day);
  if (!entry) throw new HttpError(409, 'PROFILE_REQUIRED', 'Finish your profile setup first.');
  res.status(201).json({
    entry,
    profile: withAge(await profiles.get(req.user.id)),
    weightHistory: await profiles.weightHistory(req.user.id),
  });
}

// Completing onboarding does not invent body measurements or consent.
async function completeOnboarding(req, res) {
  await db.query('update members set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where user_id = $1', [req.user.id]);
  return getProfile(req, res);
}

module.exports = { completeOnboarding, getProfile, saveProfile, addWeight, ageOf, withAge };
