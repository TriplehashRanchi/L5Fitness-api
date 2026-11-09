/**
 * End-to-end test against a RUNNING API (start it first with `npm start`).
 * Exercises Postgres, Neon Auth and object storage through the real HTTP endpoints.
 *
 * It creates two throwaway users (@example.com) and one small file, then deletes all of them.
 * Note: it runs against whichever Neon branch your env file points at.
 *
 *   npm run test:e2e            (API_URL defaults to http://localhost:4000)
 */
const crypto = require('node:crypto');

const db = require('../services/db');

const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, '');
const run = Date.now().toString(36);
const users = [
  { name: 'Smoke One', email: `l5-smoke-${run}-a@example.com`, password: `Pw-${crypto.randomUUID()}` },
  { name: 'Smoke Two', email: `l5-smoke-${run}-b@example.com`, password: `Pw-${crypto.randomUUID()}` },
];
// A real 1×1 PNG.
const FIREBASE_KEY = process.env.FIREBASE_WEB_API_KEY;
if (!FIREBASE_KEY || !process.env.FIREBASE_PROJECT_ID) {
  console.error('This test needs FIREBASE_WEB_API_KEY and FIREBASE_PROJECT_ID in .env.local.');
  process.exit(1);
}
const createdFirebaseUsers = []; // [{ idToken }] removed again at the end

async function firebaseCall(path, body) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${FIREBASE_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Firebase ${res.status}`);
  return data;
}
async function firebaseSignUp({ email, password, name }) {
  const out = await firebaseCall('accounts:signUp', { email, password, returnSecureToken: true });
  createdFirebaseUsers.push(out);
  return out;
}
const firebaseSignIn = ({ email, password }) => firebaseCall('accounts:signInWithPassword', { email, password, returnSecureToken: true });

/** A token that LOOKS right (issuer, audience, expiry) but is signed with a key Google never issued. */
async function forgeToken(projectId) {
  const { SignJWT, generateKeyPair } = await import('jose');
  const { privateKey } = await generateKeyPair('RS256');
  return new SignJWT({ email: 'attacker@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'forged' })
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setAudience(projectId)
    .setSubject('attacker-uid')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  console.log(`API: ${API}\n`);

  console.log('Health');
  const health = await api('GET', '/health');
  check('GET /health → 200', health.status === 200, `status ${health.status}`);
  for (const name of ['postgres', 'storage', 'auth']) {
    const s = health.body?.services?.[name];
    check(`${name} reachable`, s?.ok === true, `${s?.ms} ms`);
  }

  console.log('\nAuth (Firebase)');
  const anon = await api('GET', '/auth/me');
  check('no token → 401', anon.status === 401, anon.body?.error?.code);
  const junk = await api('GET', '/auth/me', { token: 'not-a-real-token' });
  check('made-up token → 401', junk.status === 401, junk.body?.error?.code);
  const forged = await forgeToken(process.env.FIREBASE_PROJECT_ID);
  const forgedRes = await api('GET', '/auth/me', { token: forged });
  check('well-formed token signed with the WRONG key → 401', forgedRes.status === 401, forgedRes.body?.error?.code);
  const otherProject = await forgeToken('some-other-project');
  check('token for a different Firebase project → 401', (await api('GET', '/auth/me', { token: otherProject })).status === 401);

  const [one, two] = users;
  const a1 = await firebaseSignUp(one);
  check('Firebase sign-up (email) returns an ID token', !!a1.idToken && !!a1.localId, `uid ${a1.localId}`);
  const token = a1.idToken;
  const reg = { body: { user: { id: a1.localId } } };
  const me = await api('GET', '/auth/me', { token });
  check('GET /auth/me returns the signed-in user', me.status === 200 && me.body?.user?.id === a1.localId && me.body.user.email === one.email, me.body?.user?.email);
  check('name falls back to the email name for a new account', me.body?.user?.name === 'L5-smoke-' + run + '-a'.slice(0) || typeof me.body?.user?.name === 'string', me.body?.user?.name);
  const login = await firebaseSignIn(one);
  check('Firebase login with the right password works', !!login.idToken && login.localId === a1.localId);
  const wrong = await firebaseSignIn({ ...one, password: 'definitely-wrong-1' }).catch((e) => ({ error: e.message }));
  check('Firebase login with a wrong password is refused', !!wrong.error, wrong.error);
  const b1 = await firebaseSignUp(two);
  const token2 = b1.idToken;
  check('second user signed up', !!token2);

  await fitness({ token, token2, userId: a1.localId });
  await wellness({ token, token2, userId: a1.localId });
  await profileAndDiet({ token, token2, userId: a1.localId });
  await staffAndAdmin({ token });

  console.log('\nUploads (object storage + Postgres)');
  const noAuth = await api('POST', '/uploads', { body: { contentType: 'image/png', size: PNG.length } });
  check('create upload without token → 401', noAuth.status === 401);
  const badType = await api('POST', '/uploads', { token, body: { contentType: 'application/x-msdownload', size: 10 } });
  check('unsupported file type → 400', badType.status === 400, badType.body?.error?.code);
  const tooBig = await api('POST', '/uploads', { token, body: { contentType: 'image/png', size: 11 * 1024 * 1024 } });
  check('file over 10 MB → 413', tooBig.status === 413, tooBig.body?.error?.code);

  const created = await api('POST', '/uploads', { token, body: { contentType: 'image/png', size: PNG.length } });
  check('create upload → 201 with signed URL', created.status === 201 && !!created.body?.uploadUrl, created.body?.upload?.key);
  const upload = created.body.upload;
  const row = await db.query('select status, user_id from uploads where id = $1', [upload.id]);
  check('pending row written to Postgres', row.rows[0]?.status === 'pending' && row.rows[0]?.user_id === reg.body.user.id);

  const early = await api('POST', `/uploads/${upload.id}/complete`, { token });
  check('complete before the file is uploaded → 409', early.status === 409, early.body?.error?.code);

  const wrongSize = await fetch(created.body.uploadUrl, { method: 'PUT', headers: created.body.headers, body: Buffer.concat([PNG, PNG]) });
  check('storage rejects a different size than was signed', !wrongSize.ok, `status ${wrongSize.status}`);
  const put = await fetch(created.body.uploadUrl, { method: 'PUT', headers: created.body.headers, body: PNG });
  check('PUT file to the signed URL → 200', put.status === 200, `status ${put.status}`);

  const done = await api('POST', `/uploads/${upload.id}/complete`, { token });
  check('complete → ready', done.status === 200 && done.body?.upload?.status === 'ready' && done.body.upload.size === PNG.length, `${done.body?.upload?.size} bytes`);

  const download = await fetch(done.body.upload.url);
  const bytes = Buffer.from(await download.arrayBuffer());
  check('download via signed URL returns the same bytes', download.status === 200 && bytes.equals(PNG), `${bytes.length} bytes, ${download.headers.get('content-type')}`);
  const unsigned = await fetch(done.body.upload.url.split('?')[0]);
  check('same object without a signature is refused (private bucket)', unsigned.status === 401 || unsigned.status === 403, `status ${unsigned.status}`);

  const list = await api('GET', '/uploads', { token });
  check('GET /uploads lists the file', list.status === 200 && list.body?.uploads?.some((u) => u.id === upload.id), `${list.body?.uploads?.length} file(s)`);

  const otherList = await api('GET', '/uploads', { token: token2 });
  check("second user does not see the first user's file", otherList.status === 200 && otherList.body.uploads.length === 0);
  const otherDelete = await api('DELETE', `/uploads/${upload.id}`, { token: token2 });
  check("second user cannot delete the first user's file → 404", otherDelete.status === 404, otherDelete.body?.error?.code);

  const del = await api('DELETE', `/uploads/${upload.id}`, { token });
  check('owner deletes the file → 204', del.status === 204);
  const gone = await fetch(done.body.upload.url);
  check('object is gone from storage', gone.status === 404, `status ${gone.status}`);
  const rowGone = await db.query('select 1 from uploads where id = $1', [upload.id]);
  check('row is gone from Postgres', rowGone.rowCount === 0);

}

/** Settings, water, meals with photos in the storage bucket, and account deletion. */
async function wellness({ token, token2, userId }) {
  const today = new Date().toISOString().slice(0, 10);
  const homeUrl = `/home?today=${today}`;
  const uploadPhoto = async (t) => {
    const c = await api('POST', '/uploads', { token: t, body: { contentType: 'image/png', size: PNG.length } });
    await fetch(c.body.uploadUrl, { method: 'PUT', headers: c.body.headers, body: PNG });
    const d = await api('POST', `/uploads/${c.body.upload.id}/complete`, { token: t });
    return { id: c.body.upload.id, key: c.body.upload.key, url: d.body.upload.url };
  };

  console.log('\nSettings');
  const def = await api('GET', '/me/settings', { token });
  check('new member gets the default goals', def.status === 200 && def.body.settings.stepGoal === 10000 && def.body.settings.waterGoalMl === 2500 && def.body.settings.weeklyGoal === 3, JSON.stringify(def.body.settings));
  const set = await api('PUT', '/me/settings', { token, body: { stepGoal: 8000, waterGoalMl: 3000 } });
  check('change step goal and water goal; other goal untouched', set.status === 200 && set.body.settings.stepGoal === 8000 && set.body.settings.waterGoalMl === 3000 && set.body.settings.weeklyGoal === 3);
  check('steps goal too low → 400', (await api('PUT', '/me/settings', { token, body: { stepGoal: 10 } })).status === 400);
  check('water goal too high → 400', (await api('PUT', '/me/settings', { token, body: { waterGoalMl: 99999 } })).status === 400);
  check('text instead of a number → 400', (await api('PUT', '/me/settings', { token, body: { stepGoal: 'lots' } })).status === 400);
  check('empty update → 400', (await api('PUT', '/me/settings', { token, body: {} })).status === 400);
  check("second user's goals are not affected", (await api('GET', '/me/settings', { token: token2 })).body.settings.stepGoal === 10000);

  console.log('\nWater intake');
  const w1 = await api('POST', '/water', { token, body: { amountMl: 250, day: today } });
  const w2 = await api('POST', '/water', { token, body: { amountMl: 500, day: today } });
  check('log 250 ml then 500 ml → total 750 of the 3000 goal', w1.status === 201 && w2.body.water.totalMl === 750 && w2.body.water.goalMl === 3000, `${w2.body?.water?.totalMl} / ${w2.body?.water?.goalMl}`);
  check('0 ml → 400', (await api('POST', '/water', { token, body: { amountMl: 0, day: today } })).status === 400);
  check('5 litres in one go → 400', (await api('POST', '/water', { token, body: { amountMl: 5000, day: today } })).status === 400);
  check('wrong day → 400', (await api('POST', '/water', { token, body: { amountMl: 250, day: '2020-01-01' } })).status === 400);
  const h1 = (await api('GET', homeUrl, { token })).body;
  check('Home carries the water total, goal and step goal', h1.water.totalMl === 750 && h1.water.goalMl === 3000 && h1.settings.stepGoal === 8000);
  const undo = await api('DELETE', `/water/${w2.body.entry.id}?day=${today}`, { token });
  check('undo the last drink → total 250', undo.status === 200 && undo.body.water.totalMl === 250);
  check("cannot undo another member's drink → 404", (await api('DELETE', `/water/${w1.body.entry.id}?day=${today}`, { token: token2 })).status === 404);
  check("second user's water is separate", (await api('GET', homeUrl, { token: token2 })).body.water.totalMl === 0);

  console.log('\nMeals with photos (Neon bucket)');
  const photo = await uploadPhoto(token);
  const eatenAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const noPhotoNoNote = await api('POST', '/meals', { token, body: { mealType: 'lunch', eatenAt, day: today } });
  check('a meal needs a photo or a note → 400', noPhotoNoNote.status === 400, noPhotoNoNote.body?.error?.code);
  check('unknown meal type → 400', (await api('POST', '/meals', { token, body: { mealType: 'brunch', note: 'x', eatenAt, day: today } })).status === 400);
  const ghost = await api('POST', '/meals', { token, body: { mealType: 'lunch', uploadId: crypto.randomUUID(), eatenAt, day: today } });
  check('photo that does not exist → 404', ghost.status === 404);
  const m = await api('POST', '/meals', { token, body: { mealType: 'lunch', note: 'Dal, rice and salad', uploadId: photo.id, eatenAt, day: today } });
  check('save a meal with a photo → 201 with a photo link', m.status === 201 && m.body.meal.mealType === 'lunch' && /^https:/.test(m.body.meal.photoUrl || ''), m.body?.meal?.note);
  const img = await fetch(m.body.meal.photoUrl);
  check('the photo link returns the same image from the bucket', img.status === 200 && Buffer.from(await img.arrayBuffer()).equals(PNG));
  check('same photo on a second meal → 409', (await api('POST', '/meals', { token, body: { mealType: 'dinner', uploadId: photo.id, eatenAt, day: today } })).status === 409);
  const foreign = await uploadPhoto(token2);
  check("another member's photo cannot be used → 404", (await api('POST', '/meals', { token, body: { mealType: 'snack', uploadId: foreign.id, eatenAt, day: today } })).status === 404);
  const noteOnly = await api('POST', '/meals', { token, body: { mealType: 'snack', note: 'Banana', eatenAt, day: today } });
  check('a note-only meal works too', noteOnly.status === 201 && noteOnly.body.meal.photoUrl === null);
  const longNote = await api('POST', '/meals', { token, body: { mealType: 'snack', note: 'x'.repeat(201), eatenAt, day: today } });
  check('note over 200 characters → 400', longNote.status === 400);
  const list = await api('GET', `/meals?day=${today}`, { token });
  check('list shows both meals, oldest first', list.status === 200 && list.body.meals.length === 2);
  check('Home carries today\'s meals', (await api('GET', homeUrl, { token })).body.meals.length === 2);
  check("second user sees none of them", (await api('GET', `/meals?day=${today}`, { token: token2 })).body.meals.length === 0);
  check("cannot delete another member's meal → 404", (await api('DELETE', `/meals/${m.body.meal.id}`, { token: token2 })).status === 404);
  const delMeal = await api('DELETE', `/meals/${m.body.meal.id}`, { token });
  check('delete the meal → 204', delMeal.status === 204);
  check('its photo is gone from the bucket', (await fetch(photo.url)).status === 404);
  check('its photo record is gone from Postgres', (await db.query('select 1 from uploads where id = $1', [photo.id])).rowCount === 0);
  await api('DELETE', `/meals/${noteOnly.body.meal.id}`, { token });

  console.log('\nDelete account data');
  const gone = await uploadPhoto(token2);
  await api('POST', '/meals', { token: token2, body: { mealType: 'lunch', uploadId: gone.id, eatenAt, day: today } });
  await api('POST', '/water', { token: token2, body: { amountMl: 300, day: today } });
  await api('PUT', '/me/settings', { token: token2, body: { stepGoal: 5000 } });
  await api('POST', '/workout-logs', { token: token2, body: { title: 'Walk', calories: 50, startedAt: new Date(Date.now() - 600_000).toISOString(), durationMin: 10, day: today } });
  const del = await api('DELETE', '/me', { token: token2 });
  check('DELETE /me → ok, both of that member\'s photos removed', del.status === 200 && del.body.files === 2 && del.body.filesNotRemoved === 0, JSON.stringify(del.body));
  const uid2 = (await api('GET', '/auth/me', { token: token2 })).body.user.id;
  const left = await db.query(`select (select count(*) from meals where user_id=$1)::int + (select count(*) from water_logs where user_id=$1)::int + (select count(*) from workout_logs where user_id=$1)::int + (select count(*) from profiles where user_id=$1)::int + (select count(*) from uploads where user_id=$1)::int as n`, [uid2]);
  check('nothing about that member is left in Postgres', left.rows[0].n === 0);
  check('their photos are gone from the bucket', (await fetch(gone.url)).status === 404 && (await fetch(foreign.url)).status === 404);
  check('running it again is harmless', (await api('DELETE', '/me', { token: token2 })).body.files === 0);
  check("the first member's data is untouched", (await api('GET', '/me/settings', { token })).body.settings.stepGoal === 8000);
}

/** Setup answers, weight, workout history, dietitian role, diet plans and consent. */
async function profileAndDiet({ token, token2, userId }) {
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = shiftDay(today, 1);
  const dayAfter = shiftDay(today, 2);
  const full = { goal: 'lose', sex: 'male', birthDate: '1995-04-12', heightCm: 175, weightKg: 82.5, targetWeightKg: 75, activityLevel: 'moderate', dietType: 'vegetarian', allergies: 'Peanuts', medicalNotes: 'Mild asthma', shareWithDietitian: true, day: today };
  const put = (t, body) => api('PUT', '/me/profile', { token: t, body });

  console.log('\nProfile setup');
  const empty = await api('GET', '/me/profile', { token });
  check('before setup: not completed, role member', empty.status === 200 && empty.body.completed === false && empty.body.role === 'member' && empty.body.profile === null);
  check('lose weight but target is higher → 400', (await put(token, { ...full, targetWeightKg: 90 })).status === 400);
  check('gain weight but target is lower → 400', (await put(token, { ...full, goal: 'gain', targetWeightKg: 70 })).status === 400);
  check('maintain with a target 20 kg away → 400', (await put(token, { ...full, goal: 'maintain', targetWeightKg: 62 })).status === 400);
  check('height 50 cm → 400', (await put(token, { ...full, heightCm: 50 })).status === 400);
  check('weight as text → 400', (await put(token, { ...full, weightKg: 'heavy' })).status === 400);
  check('age 5 → 400', (await put(token, { ...full, birthDate: shiftDay(today, -365 * 5) })).status === 400);
  check('unknown activity level → 400', (await put(token, { ...full, activityLevel: 'extreme' })).status === 400);
  check('consent missing → 400', (await put(token, { ...full, shareWithDietitian: undefined })).status === 400);
  check('medical note over 500 characters → 400', (await put(token, { ...full, medicalNotes: 'x'.repeat(501) })).status === 400);
  const saved = await put(token, full);
  check('valid setup → saved, age worked out, starting weight kept', saved.status === 200 && saved.body.completed && saved.body.profile.age >= 30 && saved.body.profile.startWeightKg === 82.5 && saved.body.weightHistory.length === 1, `age ${saved.body?.profile?.age}`);
  const again = await put(token, { ...full, weightKg: 81 });
  check('editing with a new weight: history grows, start weight stays 82.5', again.body.weightHistory.length === 2 && again.body.profile.startWeightKg === 82.5 && again.body.profile.weightKg === 81);
  const w = await api('POST', '/me/weight', { token, body: { weightKg: 80.44, day: today } });
  check('log a weight → rounded to 80.4, newest first', w.status === 201 && w.body.profile.weightKg === 80.4 && w.body.weightHistory[0].weightKg === 80.4 && w.body.weightHistory.length === 3);
  check('weight 10 kg → 400', (await api('POST', '/me/weight', { token, body: { weightKg: 10, day: today } })).status === 400);
  check('weight before setup → 409', (await api('POST', '/me/weight', { token: token2, body: { weightKg: 70, day: today } })).status === 409);
  const second = await put(token2, { ...full, goal: 'gain', weightKg: 60, targetWeightKg: 65, shareWithDietitian: false });
  check('a second member can set up and decline sharing', second.status === 200 && second.body.profile.shareWithDietitian === false);
  check("members' profiles are separate", (await api('GET', '/me/profile', { token })).body.profile.weightKg === 80.4);

  console.log('\nWorkout history');
  const yesterday = shiftDay(today, -1);
  const log2 = await api('POST', '/workout-logs', { token, body: { title: 'Evening run', calories: 300, startedAt: new Date(Date.now() - DAY_MS).toISOString(), durationMin: 40, day: yesterday } });
  check('log a workout for yesterday', log2.status === 201);
  const hist = await api('GET', '/workout-logs/history', { token });
  check('history: newest day first, with totals per day', hist.status === 200 && hist.body.days.length === 2 && hist.body.days[0].day === today && hist.body.days[1].day === yesterday && hist.body.days[1].totalMinutes === 40 && hist.body.days[1].totalCalories === 300, hist.body.days?.map((d) => d.day).join(', '));
  check('first page carries lifetime totals', hist.body.summary?.workouts === 2 && hist.body.summary?.activeDays === 2);
  const page1 = await api('GET', '/workout-logs/history?limit=1', { token });
  check('paging: limit 1 gives today and a cursor', page1.body.days.length === 1 && page1.body.nextBefore === today);
  const page2 = await api('GET', `/workout-logs/history?limit=1&before=${today}`, { token });
  check('next page gives yesterday and no more, no totals', page2.body.days[0]?.day === yesterday && page2.body.nextBefore === null && page2.body.summary === null);
  check("second member's history is empty", (await api('GET', '/workout-logs/history', { token: token2 })).body.days.length === 0);

  console.log('\nDietitian role and plans');
  const dietitianUser = await firebaseSignUp({ email: `l5-smoke-${run}-d@example.com`, password: `Pw-${crypto.randomUUID()}` });
  const dt = dietitianUser.idToken;
  await api('GET', '/auth/me', { token: dt }); // makes the app remember them
  check('a normal member cannot use dietitian tools → 403', (await api('GET', '/dietitian/clients', { token })).status === 403);
  check('the plan of an empty day is empty, sharing is on', (await api('GET', `/diet?day=${today}`, { token })).body.items.length === 0 && (await api('GET', `/diet?day=${today}`, { token })).body.sharing === true);
  await db.query("update members set role = 'dietitian' where user_id = $1", [dietitianUser.localId]);
  check('a dietitian with no assigned clients sees an empty list', (await api('GET', '/dietitian/clients', { token: dt })).body.clients.length === 0);
  check('and cannot open a member who is not assigned to them → 404', (await api('GET', `/dietitian/clients/${userId}`, { token: dt })).status === 404);
  await db.query("insert into client_assignments (member_id, dietitian_id, assigned_by) values ($1, $2, 'test')", [userId, dietitianUser.localId]);
  const dtProfile = (await api('GET', '/me/profile', { token: dt })).body;
  check('after being made a dietitian: role shown, and no member setup is required', dtProfile.role === 'dietitian' && dtProfile.completed === true && dtProfile.profile === null);

  const clients = await api('GET', '/dietitian/clients', { token: dt });
  const mine = clients.body.clients.find((c) => c.id === userId);
  check('client list shows the member who agreed to share', clients.status === 200 && !!mine && mine.goal === 'lose' && mine.weightKg === 80.4 && mine.targetWeightKg === 75, mine?.name);
  check('a member who declined sharing is NOT listed', !clients.body.clients.some((c) => c.id !== userId && c.goal === 'gain'));
  check('search finds by email', (await api('GET', `/dietitian/clients?q=${encodeURIComponent(users[0].email.slice(0, 14))}`, { token: dt })).body.clients.some((c) => c.id === userId));
  check('search with no match → empty', (await api('GET', '/dietitian/clients?q=zzzz-nobody', { token: dt })).body.clients.length === 0);
  const detail = await api('GET', `/dietitian/clients/${userId}`, { token: dt });
  check('client detail: all answers, weight history, workouts', detail.status === 200 && detail.body.profile.allergies === 'Peanuts' && detail.body.profile.medicalNotes === 'Mild asthma' && detail.body.weightHistory.length === 3 && detail.body.recentWorkouts.length === 2);
  const uid2 = (await api('GET', '/auth/me', { token: token2 })).body.user.id;
  check('a member who declined sharing is hidden → 404', (await api('GET', `/dietitian/clients/${uid2}`, { token: dt })).status === 404);
  check('unknown client → 404', (await api('GET', '/dietitian/clients/nobody-here', { token: dt })).status === 404);

  const add = (body, t = dt, id = userId) => api('POST', `/dietitian/clients/${id}/plan`, { token: t, body });
  check('unknown meal slot → 400', (await add({ day: today, mealSlot: 'brunch', title: 'x' })).status === 400);
  check('empty title → 400', (await add({ day: today, mealSlot: 'lunch', title: '  ' })).status === 400);
  check('3000+ calories → 400', (await add({ day: today, mealSlot: 'lunch', title: 'x', calories: 9999 })).status === 400);
  check('a day 3 years away → 400', (await add({ day: shiftDay(today, 1100), mealSlot: 'lunch', title: 'x' })).status === 400);
  check('a normal member cannot post a plan → 403', (await add({ day: today, mealSlot: 'lunch', title: 'x' }, token)).status === 403);
  check('cannot post for a member who declined sharing → 404', (await add({ day: today, mealSlot: 'lunch', title: 'x' }, dt, uid2)).status === 404);
  const lunch = await add({ day: today, mealSlot: 'lunch', title: 'Dal, 2 rotis and salad', details: 'Less oil', calories: 520 });
  const dinner = await add({ day: today, mealSlot: 'dinner', title: 'Paneer bhurji and 1 roti', calories: 450 });
  const breakfast = await add({ day: today, mealSlot: 'breakfast', title: 'Oats with fruit', calories: 320 });
  await add({ day: tomorrow, mealSlot: 'breakfast', title: 'Poha', calories: 300 });
  check('post 3 items for today → 201', [lunch, dinner, breakfast].every((r) => r.status === 201) && lunch.body.item.calories === 520 && lunch.body.item.details === 'Less oil');

  const mineToday = await api('GET', `/diet?day=${today}&weekStart=${today}`, { token });
  check('the member sees them in meal order, none ticked', mineToday.status === 200 && mineToday.body.items.map((i) => i.mealSlot).join() === 'breakfast,lunch,dinner' && mineToday.body.items.every((i) => !i.done) && mineToday.body.summary.total === 3, mineToday.body.items.map((i) => i.mealSlot).join());
  check('week summary: 3 planned today, 1 tomorrow, 7 days', mineToday.body.week.length === 7 && mineToday.body.week[0].total === 3 && mineToday.body.week[1].total === 1);
  const first = mineToday.body.items[0].id;
  check('tick an item → done', (await api('PUT', `/diet/items/${first}/done`, { token })).body.done === true);
  check('ticking again is harmless', (await api('PUT', `/diet/items/${first}/done`, { token })).status === 200);
  const afterTick = (await api('GET', `/diet?day=${today}&weekStart=${today}`, { token })).body;
  check('1 of 3 done, shown in the week too', afterTick.summary.done === 1 && afterTick.week[0].done === 1);
  check("another member cannot tick this member's item → 404", (await api('PUT', `/diet/items/${first}/done`, { token: token2 })).status === 404);
  check('the dietitian sees the tick and 1 of 3 adherence', (await api('GET', `/dietitian/clients/${userId}/plan?day=${today}`, { token: dt })).body.items.find((i) => i.id === first).done === true && (await api('GET', `/dietitian/clients/${userId}`, { token: dt })).body.adherence.done === 1);
  check('client list shows the 7-day progress', (await api('GET', '/dietitian/clients', { token: dt })).body.clients.find((c) => c.id === userId).done7 === 1);
  check('untick → not done', (await api('DELETE', `/diet/items/${first}/done`, { token })).body.done === false);

  const copy = await api('POST', `/dietitian/clients/${userId}/plan/copy`, { token: dt, body: { from: today, to: dayAfter } });
  check('copy today onto the day after tomorrow → 3 items, unticked', copy.status === 201 && copy.body.copied === 3 && copy.body.items.every((i) => !i.done));
  check('copy from an empty day → 409', (await api('POST', `/dietitian/clients/${userId}/plan/copy`, { token: dt, body: { from: shiftDay(today, 9), to: dayAfter } })).status === 409);
  check('copy a day onto itself → 400', (await api('POST', `/dietitian/clients/${userId}/plan/copy`, { token: dt, body: { from: today, to: today } })).status === 400);

  check('a normal member cannot delete a plan item → 403', (await api('DELETE', `/dietitian/plan-items/${first}`, { token })).status === 403);
  check('the dietitian deletes an item → 204', (await api('DELETE', `/dietitian/plan-items/${first}`, { token: dt })).status === 204);
  check('the plan now has 2 items for the member', (await api('GET', `/diet?day=${today}`, { token })).body.items.length === 2);

  console.log('\nConsent can be taken back');
  const revoke = await put(token, { ...full, weightKg: 80.4, shareWithDietitian: false });
  check('member stops sharing', revoke.status === 200 && revoke.body.profile.shareWithDietitian === false);
  check('dietitian can no longer see or edit them → 404', (await api('GET', `/dietitian/clients/${userId}`, { token: dt })).status === 404 && (await add({ day: today, mealSlot: 'lunch', title: 'x' })).status === 404);
  check('they are gone from the client list', !(await api('GET', '/dietitian/clients', { token: dt })).body.clients.some((c) => c.id === userId));
  check('the member is told sharing is off', (await api('GET', `/diet?day=${today}`, { token })).body.sharing === false);
}

const made = { workouts: [], classes: [], categories: [], plan: null, inviteEmails: [] };

/** Admin and dietitian access: roles, invitations, assignment, and the catalog tools. */
async function staffAndAdmin({ token }) {
  const members = require('../models/member.model');
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = shiftDay(today, 1);
  const person = async (tag) => {
    const email = `l5-smoke-${run}-${tag}@example.com`;
    const u = await firebaseSignUp({ email, password: `Pw-${crypto.randomUUID()}` });
    await api('GET', '/auth/me', { token: u.idToken }); // the app remembers them
    return { id: u.localId, token: u.idToken, email };
  };
  const [adm, dA, dB, m1, m2] = [await person('adm'), await person('da'), await person('db'), await person('m1'), await person('m2')];
  const staff = async (u) => (await api('GET', '/staff/me', { token: u.token })).body.staff;
  const profileBody = (extra = {}) => ({ goal: 'lose', sex: 'female', birthDate: '1992-06-01', heightCm: 165, weightKg: 70, targetWeightKg: 62, activityLevel: 'light', dietType: 'vegan', allergies: null, medicalNotes: null, shareWithDietitian: true, day: today, ...extra });

  console.log('\nStaff access');
  const plain = await staff(m1);
  check('a normal member is NOT allowed into the console', plain.role === 'member' && plain.allowed === false);
  check('admin tools are closed to a member → 403', (await api('GET', '/admin/overview', { token: m1.token })).status === 403);
  check('dietitian tools are closed to a member → 403', (await api('GET', '/dietitian/clients', { token: m1.token })).status === 403);
  await members.setRoleByEmail(adm.email, 'admin');
  const asAdmin = await staff(adm);
  check('after being made admin: allowed, role admin', asAdmin.role === 'admin' && asAdmin.allowed === true);
  let refused = false;
  try { await members.setRoleByEmail(dA.email, 'admin'); } catch (e) { refused = e.code === '23505'; }
  check('a SECOND admin is refused by the database', refused);
  check('the admin skips the member setup questions', (await api('GET', '/me/profile', { token: adm.token })).body.completed === true);
  const ov = await api('GET', '/admin/overview', { token: adm.token });
  check('admin overview works and counts members', ov.status === 200 && ov.body.overview.members >= 2 && typeof ov.body.overview.dietitians === 'number', JSON.stringify(ov.body.overview));

  console.log('\nInviting dietitians');
  check('invalid email → 400', (await api('POST', '/admin/dietitians', { token: adm.token, body: { email: 'not-an-email' } })).status === 400);
  const newDoc = `newdoc-${run}@example.com`;
  made.inviteEmails.push(newDoc, dA.email);
  const inv = await api('POST', '/admin/dietitians', { token: adm.token, body: { email: newDoc.toUpperCase() } });
  check('invite someone who has not signed in yet → pending, email lower-cased', inv.status === 201 && inv.body.result === 'invited' && inv.body.email === newDoc);
  let list = (await api('GET', '/admin/dietitians', { token: adm.token })).body;
  check('the pending invitation is listed', list.invites.some((i) => i.email === newDoc));
  const invA = await api('POST', '/admin/dietitians', { token: adm.token, body: { email: dA.email } });
  check('invite someone whose email is NOT verified → stays pending (no promotion)', invA.body.result === 'invited' && (await staff(dA)).role === 'member');
  await members.applyAccessRules({ id: dA.id, email: dA.email, emailVerified: false });
  check('signing in with an unverified email does NOT use the invitation', (await staff(dA)).role === 'member');
  await members.applyAccessRules({ id: dA.id, email: dA.email, emailVerified: true });
  const nowDoc = await staff(dA);
  check('signing in with the verified email makes them a dietitian, allowed', nowDoc.role === 'dietitian' && nowDoc.allowed === true);
  check('the invitation is used up', !(await api('GET', '/admin/dietitians', { token: adm.token })).body.invites.some((i) => i.email === dA.email));
  await db.query('update members set email_verified = true where user_id = $1', [dB.id]);
  const invB = await api('POST', '/admin/dietitians', { token: adm.token, body: { email: dB.email } });
  check('a member with a verified email is promoted at once', invB.body.result === 'promoted' && (await staff(dB)).role === 'dietitian');
  check('inviting an existing dietitian → 409', (await api('POST', '/admin/dietitians', { token: adm.token, body: { email: dB.email } })).status === 409);
  check("inviting the admin's email → 409", (await api('POST', '/admin/dietitians', { token: adm.token, body: { email: adm.email } })).status === 409);
  await members.applyAccessRules({ id: m2.id, email: m2.email, emailVerified: true }, m2.email);
  check('the ADMIN_EMAIL address does nothing while an admin already exists', (await staff(m2)).role === 'member');
  check('a dietitian cannot use admin tools → 403', (await api('GET', '/admin/dietitians', { token: dA.token })).status === 403);
  check('revoke a pending invitation', (await api('DELETE', `/admin/dietitian-invites/${encodeURIComponent(newDoc)}`, { token: adm.token })).status === 204 && (await api('DELETE', `/admin/dietitian-invites/${encodeURIComponent(newDoc)}`, { token: adm.token })).status === 404);

  console.log('\nAssigning members to dietitians');
  await api('PUT', '/me/profile', { token: m1.token, body: profileBody() });
  await api('PUT', '/me/profile', { token: m2.token, body: profileBody({ shareWithDietitian: true }) });
  const tag = `l5-smoke-${run}-m`;
  const unassigned = await api('GET', `/admin/members?filter=unassigned&q=${tag}`, { token: adm.token });
  check('admin lists both new members as unassigned, with setup and sharing shown', unassigned.status === 200 && unassigned.body.total === 2 && unassigned.body.members.every((m) => m.setupDone && m.sharing && m.dietitianId === null));
  check('members list is closed to dietitians → 403', (await api('GET', '/admin/members', { token: dA.token })).status === 403);
  check('assign to someone who is not a dietitian → 400', (await api('PUT', `/admin/members/${m1.id}/assignment`, { token: adm.token, body: { dietitianId: m2.id } })).status === 400);
  check('assign an unknown member → 404', (await api('PUT', '/admin/members/nobody/assignment', { token: adm.token, body: { dietitianId: dA.id } })).status === 404);
  check('assign m1 to dietitian A', (await api('PUT', `/admin/members/${m1.id}/assignment`, { token: adm.token, body: { dietitianId: dA.id } })).status === 200);
  const aClients = (await api('GET', '/dietitian/clients', { token: dA.token })).body.clients;
  check('dietitian A sees ONLY their client', aClients.length === 1 && aClients[0].id === m1.id);
  check("dietitian A cannot open someone else's member → 404", (await api('GET', `/dietitian/clients/${m2.id}`, { token: dA.token })).status === 404);
  check("dietitian A cannot post a plan for someone else's member → 404", (await api('POST', `/dietitian/clients/${m2.id}/plan`, { token: dA.token, body: { day: today, mealSlot: 'lunch', title: 'x' } })).status === 404);
  check('dietitian B (no clients) sees none, and cannot open m1 → 404', (await api('GET', '/dietitian/clients', { token: dB.token })).body.clients.length === 0 && (await api('GET', `/dietitian/clients/${m1.id}`, { token: dB.token })).status === 404);
  const planned = await api('POST', `/dietitian/clients/${m1.id}/plan`, { token: dA.token, body: { day: today, mealSlot: 'lunch', title: 'Khichdi' } });
  check('dietitian A can post for their own client', planned.status === 201);
  check('the ADMIN sees every client who agreed to share', (await api('GET', '/dietitian/clients', { token: adm.token })).body.clients.filter((c) => [m1.id, m2.id].includes(c.id)).length === 2);
  check('the admin can open any such client', (await api('GET', `/dietitian/clients/${m2.id}`, { token: adm.token })).status === 200);
  check('dietitian A cannot delete an item of an unassigned member → 404', (await api('DELETE', `/dietitian/plan-items/${planned.body.item.id}`, { token: dB.token })).status === 404);
  await api('PUT', `/admin/members/${m1.id}/assignment`, { token: adm.token, body: { dietitianId: dB.id } });
  check('reassigning moves access: A loses m1, B gets it', (await api('GET', `/dietitian/clients/${m1.id}`, { token: dA.token })).status === 404 && (await api('GET', `/dietitian/clients/${m1.id}`, { token: dB.token })).status === 200);
  const assigned = await api('GET', `/admin/members?filter=assigned&q=${tag}`, { token: adm.token });
  check('the members list shows who looks after whom', assigned.body.members.length === 1 && assigned.body.members[0].dietitianId === dB.id);
  await api('PUT', `/admin/members/${m1.id}/assignment`, { token: adm.token, body: { dietitianId: null } });
  check('unassign → no dietitian can open them', (await api('GET', `/dietitian/clients/${m1.id}`, { token: dB.token })).status === 404);

  console.log('\nDisabling and removing a dietitian');
  await api('PUT', `/admin/members/${m2.id}/assignment`, { token: adm.token, body: { dietitianId: dA.id } });
  check('disable dietitian A', (await api('PATCH', `/admin/dietitians/${dA.id}`, { token: adm.token, body: { disabled: true } })).body.disabled === true);
  check('a disabled dietitian is locked out (403) and "allowed" is false', (await api('GET', '/dietitian/clients', { token: dA.token })).status === 403 && (await staff(dA)).allowed === false);
  check('a disabled dietitian cannot be assigned new clients → 400', (await api('PUT', `/admin/members/${m1.id}/assignment`, { token: adm.token, body: { dietitianId: dA.id } })).status === 400);
  await api('PATCH', `/admin/dietitians/${dA.id}`, { token: adm.token, body: { disabled: false } });
  check('enable again → back in', (await api('GET', '/dietitian/clients', { token: dA.token })).status === 200);
  list = (await api('GET', '/admin/dietitians', { token: adm.token })).body;
  check('dietitian list shows each one with their client count', list.dietitians.find((d) => d.id === dA.id).clients === 1);
  check('remove dietitian A → 204, back to member', (await api('DELETE', `/admin/dietitians/${dA.id}`, { token: adm.token })).status === 204 && (await staff(dA)).role === 'member');
  check('their clients become unassigned', (await api('GET', `/admin/members?filter=unassigned&q=${tag}`, { token: adm.token })).body.total === 2);
  check('removing someone who is not a dietitian → 404', (await api('DELETE', `/admin/dietitians/${m1.id}`, { token: adm.token })).status === 404);

  console.log('\nCatalog: workouts');
  const wl = await api('GET', '/admin/workouts', { token: adm.token });
  check('admin sees the catalog, categories, levels and icons', wl.status === 200 && wl.body.workouts.length >= 9 && wl.body.categories.length >= 6 && wl.body.icons.includes('dumbbell'));
  check('workout tools are closed to a dietitian → 403', (await api('POST', '/admin/workouts', { token: dB.token, body: {} })).status === 403);
  const wBody = (extra = {}) => ({ title: `Smoke Burn ${run}`, categorySlug: 'hiit', level: 'beginner', durationMin: 25, kcalEstimate: 240, exerciseCount: 6, focus: 'Full body', coach: 'Coach Test', icon: 'flame', isProgram: false, isActive: true, ...extra });
  check('title too short → 400', (await api('POST', '/admin/workouts', { token: adm.token, body: wBody({ title: 'x' }) })).status === 400);
  check('unknown level → 400', (await api('POST', '/admin/workouts', { token: adm.token, body: wBody({ level: 'expert' }) })).status === 400);
  check('unknown category → 400', (await api('POST', '/admin/workouts', { token: adm.token, body: wBody({ categorySlug: 'nope' }) })).status === 400);
  check('0 minutes → 400', (await api('POST', '/admin/workouts', { token: adm.token, body: wBody({ durationMin: 0 }) })).status === 400);
  check('unknown icon → 400', (await api('POST', '/admin/workouts', { token: adm.token, body: wBody({ icon: 'rocket' }) })).status === 400);
  const w1 = await api('POST', '/admin/workouts', { token: adm.token, body: wBody() });
  made.workouts.push(w1.body.workout?.id);
  check('create a workout → 201 with a slug', w1.status === 201 && w1.body.workout.slug === `smoke-burn-${run}` && w1.body.workout.isActive === true, w1.body?.workout?.slug);
  const w2 = await api('POST', '/admin/workouts', { token: adm.token, body: wBody() });
  made.workouts.push(w2.body.workout?.id);
  check('same title again → unique slug (-2)', w2.status === 201 && w2.body.workout.slug === `smoke-burn-${run}-2`);
  check('members see it in the catalog', (await api('GET', '/workouts?q=Smoke%20Burn', { token })).body.workouts.some((w) => w.id === w1.body.workout.id));
  const upd = await api('PUT', `/admin/workouts/${w1.body.workout.id}`, { token: adm.token, body: wBody({ durationMin: 35, kcalEstimate: 330, isProgram: true }) });
  check('edit it → new duration and kcal', upd.status === 200 && upd.body.workout.durationMin === 35 && upd.body.workout.kcalEstimate === 330 && upd.body.workout.isProgram === true);
  check('editing an unknown workout → 404', (await api('PUT', `/admin/workouts/${crypto.randomUUID()}`, { token: adm.token, body: wBody() })).status === 404);
  const cat = await api('POST', '/admin/categories', { token: adm.token, body: { name: `Smoke Zone ${run}` } });
  made.categories.push(cat.body.category?.slug);
  check('create a category → 201 with a slug', cat.status === 201 && cat.body.category.slug.startsWith('smoke-zone'), cat.body?.category?.slug);
  check('a workout can use the new category', (await api('PUT', `/admin/workouts/${w2.body.workout.id}`, { token: adm.token, body: wBody({ categorySlug: cat.body.category.slug }) })).status === 200);
  check('switching a workout off → 204', (await api('DELETE', `/admin/workouts/${w2.body.workout.id}`, { token: adm.token })).status === 204);
  check('members no longer see it, but the admin still does (inactive)', !(await api('GET', '/workouts?q=Smoke%20Burn', { token })).body.workouts.some((w) => w.id === w2.body.workout.id) && (await api('GET', '/admin/workouts', { token: adm.token })).body.workouts.find((w) => w.id === w2.body.workout.id)?.isActive === false);
  check('members cannot log an inactive workout → 404', (await api('POST', '/workout-logs', { token, body: { workoutId: w2.body.workout.id, startedAt: new Date(Date.now() - 600000).toISOString(), durationMin: 10, day: today } })).status === 404);

  console.log('\nCatalog: weekly plan');
  const plan0 = (await api('GET', '/admin/plan', { token: adm.token })).body.plan;
  check('plan has 7 weekdays', plan0.length === 7 && plan0.every((p) => typeof p.weekday === 'number'));
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  made.plan = { weekday: dow, workoutId: plan0[dow].workoutId };
  check('an inactive workout cannot be planned → 400', (await api('PUT', `/admin/plan/${dow}`, { token: adm.token, body: { workoutId: w2.body.workout.id } })).status === 400);
  check('weekday 9 → 400', (await api('PUT', '/admin/plan/9', { token: adm.token, body: { workoutId: w1.body.workout.id } })).status === 400);
  const set = await api('PUT', `/admin/plan/${dow}`, { token: adm.token, body: { workoutId: w1.body.workout.id } });
  check("set today's workout", set.status === 200 && set.body.plan[dow].workoutId === w1.body.workout.id);
  check("members' Home shows it as today's plan", (await api('GET', `/home?today=${today}`, { token })).body.plan?.id === w1.body.workout.id);

  console.log('\nCatalog: class timetable');
  const cBody = (extra = {}) => ({ name: `Smoke Class ${run}`, trainer: 'Coach Test', icon: 'bolt', weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '07:15', durationMin: 40, capacity: 5, isActive: true, ...extra });
  check('class with no weekdays → 400', (await api('POST', '/admin/classes', { token: adm.token, body: cBody({ weekdays: [] }) })).status === 400);
  check('start time 25:00 → 400', (await api('POST', '/admin/classes', { token: adm.token, body: cBody({ startTime: '25:00' }) })).status === 400);
  check('capacity 0 → 400', (await api('POST', '/admin/classes', { token: adm.token, body: cBody({ capacity: 0 }) })).status === 400);
  const c1 = await api('POST', '/admin/classes', { token: adm.token, body: cBody() });
  made.classes.push(c1.body.class?.id);
  check('create a class → 201', c1.status === 201 && c1.body.class.startTime === '07:15' && c1.body.class.capacity === 5);
  check('same name at the same time → 409', (await api('POST', '/admin/classes', { token: adm.token, body: cBody() })).status === 409);
  const seen = (await api('GET', `/classes?date=${tomorrow}`, { token })).body.classes.find((c) => c.id === c1.body.class.id);
  check('members see it on the timetable with 5 places', !!seen && seen.spotsLeft === 5);
  const cu = await api('PUT', `/admin/classes/${c1.body.class.id}`, { token: adm.token, body: cBody({ capacity: 7, trainer: 'Coach New' }) });
  check('edit capacity and trainer', cu.status === 200 && cu.body.class.capacity === 7 && cu.body.class.trainer === 'Coach New');
  check('members see 7 places', (await api('GET', `/classes?date=${tomorrow}`, { token })).body.classes.find((c) => c.id === c1.body.class.id).spotsLeft === 7);
  check('switch the class off → 204', (await api('DELETE', `/admin/classes/${c1.body.class.id}`, { token: adm.token })).status === 204);
  check('it disappears from the members timetable, stays in admin as inactive', !(await api('GET', `/classes?date=${tomorrow}`, { token })).body.classes.some((c) => c.id === c1.body.class.id) && (await api('GET', '/admin/classes', { token: adm.token })).body.classes.find((c) => c.id === c1.body.class.id)?.isActive === false);
  check('booking an inactive class → 404', (await api('POST', `/classes/${c1.body.class.id}/bookings`, { token, body: { date: tomorrow } })).status === 404);
}

const DAY_MS = 86_400_000;
const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const fillerIds = []; // made-up members used to fill a class

async function fitness({ token, token2, userId }) {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = shiftDay(today, -6);
  const homeUrl = `/home?today=${today}&weekStart=${weekStart}`;

  console.log('\nHome and catalog (Postgres)');
  const anon = await api('GET', homeUrl);
  check('home without token → 401', anon.status === 401);
  const home = await api('GET', homeUrl, { token });
  const h = home.body;
  check('GET /home → 200', home.status === 200);
  check("today's plan comes from the database", !!h?.plan?.id && h.plan.durationMin > 0, `${h?.plan?.title}, ${h?.plan?.durationMin} min, ${h?.plan?.kcal} kcal`);
  check('new member starts at zero', h?.stats?.calories === 0 && h.stats.minutes === 0 && h.stats.avgHeartRate === null && h.week.done === 0);
  check('weekly goal defaults to 5', h?.week?.goal === 5 && h.week.percent === 0);
  check('programs and categories listed', h?.programs?.length === 3 && h.categories.length === 6, `${h?.programs?.length} programs, ${h?.categories?.length} categories`);
  check("today's classes listed with free spots, none booked by this new member", h?.classes?.length === 3 && h.classes.every((c) => c.spotsLeft > 0 && c.spotsLeft <= c.capacity && !c.booked), h?.classes?.map((c) => `${c.name} ${c.spotsLeft}/${c.capacity}`).join(', '));
  const oldDay = await api('GET', '/home?today=2020-01-01', { token });
  check('a wrong "today" is refused → 400', oldDay.status === 400, oldDay.body?.error?.code);

  const all = await api('GET', '/workouts', { token });
  check('GET /workouts lists the catalog', all.status === 200 && all.body.workouts.length === 9, `${all.body?.workouts?.length} workouts`);
  const yoga = await api('GET', '/workouts?category=yoga', { token });
  check('filter by category', yoga.body.workouts.length === 2 && yoga.body.workouts.every((w) => w.category === 'yoga'));
  const legs = await api('GET', '/workouts?q=glutes', { token });
  check('search matches muscles', legs.body.workouts.length === 1 && legs.body.workouts[0].slug === 'leg-day-destroyer', legs.body.workouts[0]?.title);
  const wild = await api('GET', '/workouts?q=%25', { token });
  check('a "%" in search is not a wildcard', wild.status === 200 && wild.body.workouts.length === 0);
  const cats = await api('GET', '/workouts/categories', { token });
  check('categories carry real counts', cats.body.categories.find((c) => c.slug === 'strength')?.count === 5, cats.body.categories.map((c) => `${c.name} ${c.count}`).join(', '));

  console.log('\nWorkout tracking (Postgres)');
  const startedAt = new Date(Date.now() - 30 * 60_000).toISOString();
  const half = Math.round(h.plan.durationMin / 2);
  const log = await api('POST', '/workout-logs', { token, body: { workoutId: h.plan.id, startedAt, durationMin: half, day: today } });
  const expectedKcal = Math.round((h.plan.kcal * half) / h.plan.durationMin);
  check('log a catalog workout → 201', log.status === 201 && log.body.log.title === h.plan.title);
  check('calories worked out by the server for the time trained', log.body?.log?.calories === expectedKcal, `${half} of ${h.plan.durationMin} min → ${log.body?.log?.calories} kcal`);
  const custom = await api('POST', '/workout-logs', { token, body: { title: 'Evening walk', calories: 120, startedAt, durationMin: 30, day: today, avgHeartRate: 110 } });
  check('log a custom workout with heart rate → 201', custom.status === 201 && custom.body.log.avgHeartRate === 110);
  const zero = await api('POST', '/workout-logs', { token, body: { workoutId: h.plan.id, startedAt, durationMin: 0, day: today } });
  check('0 minutes → 400', zero.status === 400, zero.body?.error?.code);
  const future = await api('POST', '/workout-logs', { token, body: { workoutId: h.plan.id, startedAt: new Date(Date.now() + DAY_MS).toISOString(), durationMin: 10, day: today } });
  check('start time in the future → 400', future.status === 400, future.body?.error?.code);
  const ghost = await api('POST', '/workout-logs', { token, body: { workoutId: crypto.randomUUID(), startedAt, durationMin: 10, day: today } });
  check('unknown workout → 404', ghost.status === 404, ghost.body?.error?.code);

  const after = (await api('GET', homeUrl, { token })).body;
  check("today's stats add up", after.stats.calories === expectedKcal + 120 && after.stats.minutes === half + 30 && after.stats.avgHeartRate === 110, `${after.stats.calories} kcal, ${after.stats.minutes} min, ${after.stats.avgHeartRate} bpm`);
  check('today counts once towards the week', after.week.done === 1 && after.week.daysTrained[0] === today && after.week.percent === 20, `${after.week.done} of ${after.week.goal} = ${after.week.percent}%`);
  const rows = await db.query('select count(*)::int n from workout_logs where user_id = $1', [userId]);
  check('2 rows in Postgres (workout_logs)', rows.rows[0].n === 2);

  const goal = await api('PUT', '/me/settings', { token, body: { weeklyGoal: 3 } });
  const afterGoal = (await api('GET', homeUrl, { token })).body;
  check('change weekly goal to 3 → progress recalculated', goal.status === 200 && afterGoal.week.goal === 3 && afterGoal.week.percent === 33, `${afterGoal.week.percent}%`);
  const badGoal = await api('PUT', '/me/settings', { token, body: { weeklyGoal: 9 } });
  check('weekly goal of 9 → 400', badGoal.status === 400);

  const other = (await api('GET', homeUrl, { token: token2 })).body;
  check("second user sees none of the first user's activity", other.stats.minutes === 0 && other.week.done === 0 && other.week.goal === 5);
  const steal = await api('DELETE', `/workout-logs/${log.body.log.id}`, { token: token2 });
  check("second user cannot delete the first user's workout → 404", steal.status === 404);
  const del = await api('DELETE', `/workout-logs/${custom.body.log.id}`, { token });
  const history = await api('GET', '/workout-logs', { token });
  check('owner deletes a workout; history shows the rest', del.status === 204 && history.body.logs.length === 1);

  console.log('\nClasses and booking (Postgres)');
  const todayList = await api('GET', '/classes', { token });
  const tomorrow = shiftDay(todayList.body.date, 1);
  const list = await api('GET', `/classes?date=${tomorrow}`, { token });
  const cls = list.body.classes[0];
  check('timetable for tomorrow', list.status === 200 && list.body.classes.length === 3, `${cls?.name} at ${cls?.startsAt}`);
  const gymClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(cls.startsAt));
  check('class time is the gym clock time (06:30 IST)', gymClock === '06:30', gymClock);

  const book = await api('POST', `/classes/${cls.id}/bookings`, { token, body: { date: tomorrow } });
  check('book → booked, one spot fewer', book.status === 200 && book.body.class.booked && book.body.class.spotsLeft === cls.capacity - 1, `${book.body?.class?.spotsLeft}/${cls.capacity} left`);
  const again = await api('POST', `/classes/${cls.id}/bookings`, { token, body: { date: tomorrow } });
  check('booking twice keeps one booking', again.status === 200 && again.body.class.spotsLeft === cls.capacity - 1);
  const seen = (await api('GET', `/classes?date=${tomorrow}`, { token: token2 })).body.classes[0];
  check('second user sees the reduced spots, not booked for them', seen.spotsLeft === cls.capacity - 1 && seen.booked === false);
  const cancel = await api('DELETE', `/classes/${cls.id}/bookings/${tomorrow}`, { token });
  check('cancel → spot returned', cancel.status === 200 && !cancel.body.class.booked && cancel.body.class.spotsLeft === cls.capacity);

  const far = await api('POST', `/classes/${cls.id}/bookings`, { token, body: { date: shiftDay(tomorrow, 30) } });
  check('booking 30 days ahead → 400', far.status === 400, far.body?.error?.code);
  const past = await api('POST', `/classes/${cls.id}/bookings`, { token, body: { date: shiftDay(tomorrow, -2) } });
  check('booking a past day → 400', past.status === 400, past.body?.error?.code);
  const none = await api('POST', `/classes/${crypto.randomUUID()}/bookings`, { token, body: { date: tomorrow } });
  check('unknown class → 404', none.status === 404);
  const started = todayList.body.classes.find((c) => new Date(c.startsAt) <= new Date());
  if (started) {
    const late = await api('POST', `/classes/${started.id}/bookings`, { token, body: { date: todayList.body.date } });
    check('a class that already started cannot be booked → 409', late.status === 409, late.body?.error?.code);
  }

  // Fill the class until one spot is left, then let both users go for it at the same moment.
  for (let i = 0; i < cls.capacity - 1; i += 1) fillerIds.push(`filler-${crypto.randomUUID()}`);
  await db.query('insert into class_bookings (slot_id, class_date, user_id) select $1, $2, unnest($3::text[])', [cls.id, tomorrow, fillerIds]);
  const race = await Promise.all([token, token2].map((t) => api('POST', `/classes/${cls.id}/bookings`, { token: t, body: { date: tomorrow } })));
  const statuses = race.map((r) => r.status).sort();
  const count = await db.query('select count(*)::int n from class_bookings where slot_id = $1 and class_date = $2', [cls.id, tomorrow]);
  check('two people, one last spot: exactly one gets it', statuses[0] === 200 && statuses[1] === 409, `statuses ${statuses.join(' and ')} (${race.find((r) => r.status === 409)?.body?.error?.code})`);
  check('class is never overbooked', count.rows[0].n === cls.capacity, `${count.rows[0].n} bookings for ${cls.capacity} places`);
}

async function cleanup() {
  // Remove only what this run created: its Firebase accounts, their data, and the filler bookings.
  const ids = createdFirebaseUsers.map((u) => u.localId);
  // Catalog and staff things made by the admin tests
  if (made.plan?.workoutId) await db.query('insert into plan_days (weekday, workout_id) values ($1, $2) on conflict (weekday) do update set workout_id = excluded.workout_id', [made.plan.weekday, made.plan.workoutId]);
  for (const id of made.classes.filter(Boolean)) await db.query('delete from class_slots where id = $1', [id]);
  for (const id of made.workouts.filter(Boolean)) await db.query('delete from workouts where id = $1', [id]);
  for (const slug of made.categories.filter(Boolean)) await db.query('delete from workout_categories where slug = $1', [slug]);
  for (const email of made.inviteEmails) await db.query('delete from dietitian_invites where email = lower($1)', [email]);
  await db.query('delete from client_assignments where member_id = any($1) or dietitian_id = any($1)', [ids]);
  await db.query('delete from class_bookings where user_id = any($1)', [[...ids, ...fillerIds]]);
  if (ids.length) {
    for (const t of ['body_profiles', 'weight_logs', 'members']) await db.query(`delete from ${t} where user_id = any($1)`, [ids]);
    await db.query('delete from diet_items where member_id = any($1)', [ids]);
    await db.query('delete from meals where user_id = any($1)', [ids]);
    await db.query('delete from water_logs where user_id = any($1)', [ids]);
    await db.query('delete from workout_logs where user_id = any($1)', [ids]);
    await db.query('delete from profiles where user_id = any($1)', [ids]);
    await db.query('delete from uploads where user_id = any($1)', [ids]);
  }
  let removed = 0;
  for (const u of createdFirebaseUsers) {
    try {
      await firebaseCall('accounts:delete', { idToken: u.idToken });
      removed += 1;
    } catch (err) {
      console.error(`Could not delete Firebase test user ${u.email}: ${err.message}`);
    }
  }
  console.log(`\nCleanup: removed ${removed} Firebase test user(s) and their data`);
}

main()
  .catch((err) => {
    failed += 1;
    console.error('\nTest run crashed:', err);
  })
  .finally(async () => {
    await cleanup().catch((err) => console.error('Cleanup failed:', err.message));
    await db.pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
