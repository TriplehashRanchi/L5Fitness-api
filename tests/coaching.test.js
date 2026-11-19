/** Integration tests on a disposable Postgres schema; never load the app's .env. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

if (!process.env.COACHING_TEST_DATABASE_URL) throw new Error('Set COACHING_TEST_DATABASE_URL to an isolated test database.');
const schema = `coaching_test_${process.pid}_${Date.now()}`;
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
stub('../services/admin-session', { ADMIN_ID: 'local-admin' });
stub('../services/storage', { signDownload: async () => null });
const care = require('../models/coaching.model');
const diet = require('../controllers/diet.controller');
const fitness = require('../controllers/fitness.controller');
const admin = require('../models/admin.model');
const today = new Date().toISOString().slice(0, 10);
function req(id, role = 'dietitian', member = 'm1', body = {}) {
  return { user: { id }, staff: { role }, params: { id: member }, query: { day: today, today, weekStart: today }, body };
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
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await query(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  for (const [id, role] of [['m1','member'], ['m2','member'], ['m3','member'], ['m4','member'], ['d1','dietitian'], ['d2','dietitian']]) {
    await query('insert into members (user_id,name,email,role) values ($1,$1,$1,$2)', [id,role]);
    if (role === 'member') await query(`insert into body_profiles (user_id,goal,sex,birth_date,height_cm,weight_kg,target_weight_kg,start_weight_kg,activity_level,diet_type,share_with_dietitian)
      values ($1,'maintain','other','2000-01-01',170,70,70,70,'moderate','vegetarian',$2)`, [id,id !== 'm4']);
  }
});
after(async () => { await pool.end(); await bootstrap.query(`drop schema if exists ${schema} cascade`); await bootstrap.end(); });

test('unassigned clients cannot be opened or planned, and a dietitian cannot claim anyone', async () => {
  assert.equal((await care.status('m1')).status, 'pending');
  assert.deepEqual(await care.requests('d1'), [], 'there is no open pool of members');
  await assert.rejects(invoke(diet.clientDetail, req('d1')), { code: 'CLIENT_NOT_FOUND' });
  await assert.rejects(invoke(diet.addItem, req('d1')), { code: 'CLIENT_NOT_FOUND' });
  await assert.rejects(invoke(diet.saveTraining, req('d1')), { code: 'CLIENT_NOT_FOUND' });
  await assert.rejects(invoke(diet.acceptClient, req('local-admin', 'admin')), { code: 'FORBIDDEN' });
  assert.equal(await care.accept('m1', 'd1'), false, 'cannot self-assign');
  const mobile = await invoke(diet.getMyDiet, req('m1','member'));
  assert.deepEqual(mobile.data.items, []);
  assert.equal(mobile.data.coaching.status,'pending');
});

test('admin assignment activates at once; other dietitians stay locked out; bulk assign and handover', async () => {
  await admin.setAssignment('m1', 'd1', 'local-admin');
  assert.equal((await care.status('m1')).status, 'accepted');
  assert.equal((await care.status('m1')).dietitianId, 'd1');
  await invoke(diet.clientDetail, req('d1'));
  await assert.rejects(invoke(diet.clientDetail, req('d2')), { code: 'CLIENT_NOT_FOUND' });
  await admin.setAssignment('m2', 'd2', 'local-admin');
  assert.equal((await care.status('m2')).status, 'accepted');
  assert.equal(await admin.bulkAssign(['m3', 'm4', 'nobody', 'd2'], 'nope', 'local-admin'), null);
  const r = await admin.bulkAssign(['m3', 'm4', 'nobody', 'd2'], 'd1', 'local-admin');
  assert.deepEqual(r, { assigned: 2, skipped: 2 });
  assert.equal(await admin.clientCount('d1'), 3);
  assert.equal(await admin.handOver('d1', 'd2', 'local-admin'), 3);
  assert.equal(await admin.clientCount('d2'), 4);
  assert.equal(await admin.handOver('d2', 'missing', 'local-admin'), 0);
  assert.equal((await care.status('m1')).dietitianId, 'd2');
  await admin.bulkAssign(['m1'], 'd1', 'local-admin');
});

test('accepted client receives only their own diet and exercise plans; workout logging supports personal plan', async () => {
  const owner = (await care.status('m1')).dietitianId;
  assert.equal(owner, 'd1');
  await invoke(diet.addItem,req(owner,'dietitian','m1',{day:today,mealSlot:'breakfast',title:'Oats',details:'1 bowl',calories:320}));
  const saved = await invoke(diet.saveTraining,req(owner,'dietitian','m1',{day:today,title:'Personal strength',durationMin:30,kcal:200,instructions:'Squats: 3 × 12\nRest 60 seconds'}));
  assert.equal(saved.data.plan.instructions,'Squats: 3 × 12\nRest 60 seconds');
  const mobileDiet = (await invoke(diet.getMyDiet,req('m1','member'))).data;
  assert.equal(mobileDiet.items[0].title,'Oats');
  assert.equal(mobileDiet.coaching.status,'accepted');
  const mobileHome = (await invoke(fitness.home,req('m1','member'))).data;
  assert.equal(mobileHome.plan.title,'Personal strength');
  assert.equal(mobileHome.plan.personal,true);
  assert.equal((await invoke(fitness.home,req('m2','member'))).data.plan,null);
  await assert.rejects(invoke(diet.saveTraining,req(owner === 'd1' ? 'd2':'d1','dietitian','m1',{day:today})),{code:'CLIENT_NOT_FOUND'});
  await assert.rejects(invoke(diet.saveTraining,req(owner,'dietitian','m1',{day:today,title:'x',durationMin:0,kcal:0,instructions:'x'})),{code:'INVALID_NUMBER'});
  const clientList = (await invoke(diet.listClients, { ...req(owner), query: {} })).data;
  assert.equal(clientList.clients.some((c) => c.id === 'm1'), true);
  assert.equal(clientList.requests.some((c) => c.id === 'm1'), false);
  assert.equal((await invoke(diet.getTraining, req(owner))).data.plan.title, 'Personal strength');
  const directory = await admin.listMembers({ filter: 'all', limit: 100, offset: 0 });
  assert.ok(directory.members.find((m) => m.id === 'm1').acceptedAt);
  const itemId = mobileDiet.items[0].id;
  await assert.rejects(invoke(diet.markDone, { ...req('m2','member'),params:{id:itemId} }),{code:'ITEM_NOT_FOUND'});
  await invoke(diet.markDone, { ...req('m1','member'),params:{id:itemId} });
  const log = await invoke(fitness.createLog,req('m1','member','m1',{workoutId:saved.data.plan.id,startedAt:new Date().toISOString(),durationMin:15,day:today}));
  assert.equal(log.status,201);
  assert.equal(log.data.log.title,'Personal strength');
  assert.equal(log.data.log.calories,100);
  await assert.rejects(invoke(fitness.createLog,req('m2','member','m2',{workoutId:saved.data.plan.id,startedAt:new Date().toISOString(),durationMin:15,day:today})),{code:'WORKOUT_NOT_FOUND'});
  await invoke(diet.removeTraining,req(owner));
  assert.equal((await invoke(fitness.home,req('m1','member'))).data.plan,null);
});

test('reassigning resets acceptance; consent withdrawal and disabled dietitians hide plans', async () => {
  await admin.setAssignment('m2','d2','local-admin');
  assert.equal((await care.status('m2')).status,'accepted');
  await admin.setAssignment('m2','d1','local-admin');
  assert.equal((await care.status('m2')).status,'accepted');
  await invoke(diet.saveTraining,req('d1','dietitian','m2',{day:today,title:'Walk',durationMin:20,kcal:80,instructions:'Walk for 20 minutes.'}));
  await query("update members set disabled=true where user_id='d1'");
  assert.equal((await care.status('m2')).status,'pending');
  assert.equal(await care.trainingFor('m2',today),null);
  await query("update members set disabled=false where user_id='d1'");
  await query("update body_profiles set share_with_dietitian=false where user_id='m2'");
  assert.equal((await care.status('m2')).status,'not_shared');
  assert.equal(await care.trainingFor('m2',today),null);
  assert.deepEqual((await invoke(diet.getMyDiet,req('m2','member'))).data.items,[]);
  await assert.rejects(invoke(diet.markDone, { ...req('m2','member'),params:{id:'invalid'} }),{code:'ACCEPTANCE_REQUIRED'});
});
