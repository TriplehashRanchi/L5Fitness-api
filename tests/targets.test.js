/** Dietitian-set targets and steps. Disposable schema, like coaching.test.js. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

if (!process.env.COACHING_TEST_DATABASE_URL) throw new Error('Set COACHING_TEST_DATABASE_URL to an isolated test database.');
const schema = `subs_test_${process.pid}_${Date.now()}`;
const bootstrap = new Pool({ connectionString: process.env.COACHING_TEST_DATABASE_URL });
const pool = new Pool({ connectionString: process.env.COACHING_TEST_DATABASE_URL, options: `-c search_path=${schema},public` });
const query = (sql, args) => pool.query(sql, args);
const db = { query, transaction: async (work) => {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await work(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
} };
function stub(file, exports) { require.cache[require.resolve(file)] = { id: require.resolve(file), filename: require.resolve(file), loaded: true, exports }; }
stub('../services/db', db);
stub('../services/admin-session', { ADMIN_ID: 'local-admin', verify: async () => null });
stub('../services/firebase-auth', { getSession: async () => null });
stub('../services/storage', { signDownload: async () => null });
const care = require('../models/coaching.model');
const admin = require('../models/admin.model');
const coach = require('../controllers/coach.controller');
const wellness = require('../controllers/wellness.controller');
const fitness = require('../controllers/fitness.controller');
const today = new Date().toISOString().slice(0, 10);

function req(id, { role = 'dietitian', member = 'm1', body = {}, query = {} } = {}) {
  return { user: { id }, staff: { role }, params: { id: member }, query: { day: today, today, weekStart: today, ...query }, body };
}
async function invoke(fn, request) {
  let data; let status = 200;
  const response = { json: (v) => { data = v; }, status: (v) => { status = v; return response; }, end: () => {} };
  await fn(request, response);
  return { data, status };
}

before(async () => {
  await bootstrap.query(`create schema ${schema}`);
  const dir = path.join(__dirname, '../db/migrations');
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await query(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const [id, role] of [['m1', 'member'], ['m2', 'member'], ['d1', 'dietitian'], ['d2', 'dietitian']]) {
    await query('insert into members (user_id,name,email,role) values ($1,$1,$1,$2)', [id, role]);
    if (role === 'member') await query(`insert into body_profiles (user_id,goal,sex,birth_date,height_cm,weight_kg,target_weight_kg,start_weight_kg,activity_level,diet_type,share_with_dietitian)
      values ($1,'maintain','other','2000-01-01',170,70,70,70,'moderate','vegetarian',true)`, [id]);
  }
  await admin.setAssignment('m1', 'd1', 'local-admin');
});
after(async () => { await pool.end(); await bootstrap.query(`drop schema if exists ${schema} cascade`); await bootstrap.end(); });

test('dietitian targets override member settings and lock them', async () => {
  await assert.rejects(invoke(coach.saveTargets, req('d2', { body: { waterMl: 3000 } })), { code: 'CLIENT_NOT_FOUND' });
  await assert.rejects(invoke(coach.saveTargets, req('d1', { body: { waterMl: 50 } })), { code: 'INVALID_NUMBER' });
  const saved = await invoke(coach.saveTargets, req('d1', { body: { waterMl: 3500, steps: 8000, calories: 1800 } }));
  assert.equal(saved.data.targets.waterMl, 3500);

  const mine = (await invoke(coach.myTargets, req('m1', { role: 'member' }))).data.targets;
  assert.equal(mine.waterMl, 3500);
  assert.equal(mine.prescribed.waterMl, true);
  assert.equal(mine.weeklyWorkouts, 5, 'falls back to the member default when not prescribed');
  assert.equal(mine.prescribed.weeklyWorkouts, false);

  await assert.rejects(invoke(wellness.updateSettings, req('m1', { role: 'member', body: { waterGoalMl: 1000 } })), { code: 'TARGET_SET_BY_DIETITIAN' });
  const ok = await invoke(wellness.updateSettings, req('m1', { role: 'member', body: { weeklyGoal: 4 } }));
  assert.equal(ok.data.settings.weeklyGoal, 4);

  const home = (await invoke(fitness.home, req('m1', { role: 'member' }))).data;
  assert.equal(home.water.goalMl, 3500);
  assert.equal(home.settings.stepGoal, 8000);
  assert.equal(home.steps.goal, 8000);
  assert.ok(Array.isArray(home.diet.items));
  assert.equal(home.diet.total, 0);

  const cleared = await invoke(coach.saveTargets, req('d1', { body: { waterMl: null, steps: null } }));
  assert.equal(cleared.data.targets.waterMl, null);
  assert.equal((await invoke(coach.myTargets, req('m1', { role: 'member' }))).data.targets.waterMl, 2500);
});

test('steps reach the coach; day and week views are scoped to the assigned dietitian', async () => {
  await assert.rejects(invoke(coach.saveSteps, req('m1', { role: 'member', body: { entries: [{ day: today, steps: -5 }] } })), { code: 'INVALID_NUMBER' });
  await assert.rejects(invoke(coach.saveSteps, req('m1', { role: 'member', body: { entries: [] } })), { code: 'INVALID_VALUE' });
  await invoke(coach.saveSteps, req('m1', { role: 'member', body: { entries: [{ day: today, steps: 4000 }] } }));
  await invoke(coach.saveSteps, req('m1', { role: 'member', body: { entries: [{ day: today, steps: 6500 }] } }));
  await query("insert into water_logs (user_id, amount_ml, local_day) values ('m1', 500, $1), ('m1', 250, $1)", [today]);
  await query("insert into meals (user_id, meal_type, note, local_day, eaten_at) values ('m1','lunch','dal rice',$1, now())", [today]);

  const day = (await invoke(coach.clientDay, req('d1'))).data;
  assert.equal(day.steps.value, 6500, 'the latest report wins');
  assert.equal(day.water.totalMl, 750);
  assert.equal(day.meals.length, 1);
  assert.equal(day.meals[0].note, 'dal rice');
  const week = (await invoke(coach.clientWeek, req('d1', { query: { weekStart: today } }))).data;
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].steps, 6500);
  assert.equal(week.days[0].meals, 1);
  await assert.rejects(invoke(coach.clientDay, req('d2')), { code: 'CLIENT_NOT_FOUND' });
  await assert.rejects(invoke(coach.clientWeek, req('d2')), { code: 'CLIENT_NOT_FOUND' });
});

test('a deleted account cannot come back with a still-valid token; disabled accounts are refused', async () => {
  const { requireAuth } = require('../middleware/require-auth');
  const authSvc = require('../services/firebase-auth');
  const run = async (uid, method = 'GET', path = '/home') => {
    authSvc.getSession = async () => ({ user: { id: uid, name: uid, email: `${uid}@example.com`, image: null } });
    const r = { user: null, method, path, get: () => 'Bearer x' };
    let passed = false;
    await requireAuth(r, {}, () => { passed = true; });
    return passed;
  };
  assert.equal(await run('m2'), true);
  await query("update members set disabled = true where user_id = 'm2'");
  await assert.rejects(run('m2'), { code: 'ACCOUNT_DISABLED' });
  await query("update members set disabled = false where user_id = 'm2'");
  const keys = await require('../models/account.model').deleteAllData('m2');
  assert.ok(Array.isArray(keys));
  require('../middleware/require-auth').forget('m2');
  await assert.rejects(run('m2'), { code: 'ACCOUNT_DELETED' });
  assert.equal(await run('m2', 'DELETE', '/me'), true, 'deleting again must still work');
  assert.equal((await query("select 1 from members where user_id = 'm2'")).rowCount, 0);
});

test('member day view: what the dietitian planned and how much is done', async () => {
  const diet = require('../controllers/diet.controller');
  const fit = require('../controllers/fitness.controller');
  await invoke(diet.addItem, req('d1', { body: { day: today, mealSlot: 'breakfast', title: 'Oats', calories: 300 } }));
  await invoke(diet.addItem, req('d1', { body: { day: today, mealSlot: 'lunch', title: 'Dal rice', calories: 500 } }));
  const saved = await invoke(diet.saveTraining, req('d1', { body: { day: today, title: 'Leg day', durationMin: 30, kcal: 200, instructions: 'Squats 3 x 12\nLunges 3 x 10' } }));
  const first = (await invoke(coach.myDay, req('m1', { role: 'member' }))).data;
  assert.equal(first.diet.total, 2);
  assert.equal(first.diet.done, 0);
  assert.equal(first.training.title, 'Leg day');
  assert.equal(first.training.done, false);
  // water (750 of 2500 ml) and steps (6500 of 10000) were logged by earlier tests: 0 diet, 0 workout.
  assert.equal(first.percent, Math.round(((0 + 0 + 0 + 750 / 2500 + 6500 / 10000) / 5) * 100));

  await invoke(diet.markDone, { ...req('m1', { role: 'member' }), params: { id: first.diet.items[0].id } });
  await invoke(fit.createLog, req('m1', { role: 'member', body: { workoutId: saved.data.plan.id, startedAt: new Date().toISOString(), durationMin: 30, day: today } }));
  const second = (await invoke(coach.myDay, req('m1', { role: 'member' }))).data;
  assert.equal(second.diet.done, 1);
  assert.equal(second.training.done, true);
  assert.ok(second.percent > first.percent && second.percent < 100);
  await assert.rejects(invoke(coach.myDay, req('m1', { role: 'member', query: { day: 'nope' } })), { code: 'INVALID_DATE' });
  const other = (await invoke(coach.myDay, req('m2', { role: 'member' }))).data;
  assert.equal(other.training, null, 'another member sees none of it');
});

test('a month of steps is kept and read back; days too old are refused', async () => {
  const day = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  await invoke(coach.saveSteps, req('m1', { role: 'member', body: { entries: [{ day: day(10), steps: 9000 }, { day: day(29), steps: 1200 }] } }));
  await assert.rejects(invoke(coach.saveSteps, req('m1', { role: 'member', body: { entries: [{ day: day(60), steps: 5 }] } })), { code: 'INVALID_DATE' });
  const month = (await invoke(coach.myStepHistory, req('m1', { role: 'member', query: { to: today, days: '30' } }))).data;
  assert.equal(month.days.length, 30);
  assert.equal(month.days[29].day, today);
  assert.equal(month.days[29].steps, 6500);
  assert.equal(month.days.find((d) => d.day === day(10)).steps, 9000);
  assert.equal(month.days.find((d) => d.day === day(29)).steps, 1200);
  assert.equal(month.days.find((d) => d.day === day(5)).steps, null);
  assert.equal(month.goal, 10000);
  const other = (await invoke(coach.myStepHistory, req('m2', { role: 'member', query: { to: today } }))).data;
  assert.equal(other.days.every((d) => d.steps === null), true, 'another member sees none of it');
  await assert.rejects(invoke(coach.myStepHistory, req('m1', { role: 'member', query: { to: today, days: '500' } })), { code: 'INVALID_NUMBER' });
});
