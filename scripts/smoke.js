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

  console.log('\nAuth (Neon Auth)');
  const anon = await api('GET', '/auth/me');
  check('no token → 401', anon.status === 401, anon.body?.error?.code);
  const junk = await api('GET', '/auth/me', { token: 'not-a-real-token-0123456789abcdef' });
  check('made-up token → 401', junk.status === 401, junk.body?.error?.code);

  const [one, two] = users;
  const reg = await api('POST', '/auth/register', { body: one });
  check('register → 201 with token and user', reg.status === 201 && !!reg.body?.token && reg.body?.user?.email === one.email, `user ${reg.body?.user?.id}`);
  const dup = await api('POST', '/auth/register', { body: one });
  check('register same email again → 409', dup.status === 409, dup.body?.error?.code);
  const weak = await api('POST', '/auth/register', { body: { ...two, password: 'short' } });
  check('register with short password → 400', weak.status === 400, weak.body?.error?.code);
  const wrong = await api('POST', '/auth/login', { body: { email: one.email, password: 'definitely-wrong-1' } });
  check('login with wrong password → 401', wrong.status === 401, wrong.body?.error?.code);
  const login = await api('POST', '/auth/login', { body: { email: one.email, password: one.password } });
  check('login → 200 with token', login.status === 200 && !!login.body?.token);
  const token = login.body.token;
  const me = await api('GET', '/auth/me', { token });
  check('GET /auth/me returns the signed-in user', me.status === 200 && me.body?.user?.id === reg.body.user.id, me.body?.user?.email);

  const reg2 = await api('POST', '/auth/register', { body: two });
  const token2 = reg2.body?.token;
  check('second user registered', reg2.status === 201 && !!token2);

  const inDb = await db.query('select id, email from neon_auth."user" where email = $1', [one.email]);
  check('user row exists in Postgres (neon_auth.user)', inDb.rows[0]?.id === reg.body.user.id);
  const sessions = await db.query('select count(*)::int n from neon_auth.session where "userId" = $1', [reg.body.user.id]);
  check('session rows exist in Postgres (neon_auth.session)', sessions.rows[0].n >= 2, `${sessions.rows[0].n} sessions`);

  await fitness({ token, token2, userId: reg.body.user.id });

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

  console.log('\nSign out');
  const out = await api('POST', '/auth/logout', { token });
  check('logout → 204', out.status === 204);
  const after = await api('GET', '/auth/me', { token });
  check('the token no longer works → 401', after.status === 401);
  await api('POST', '/auth/logout', { token: token2 });
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
  check("today's classes listed with free spots", h?.classes?.length === 3 && h.classes.every((c) => c.spotsLeft === c.capacity && !c.booked), h?.classes?.map((c) => `${c.name} ${c.spotsLeft}/${c.capacity}`).join(', '));
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

  const goal = await api('PUT', '/me/goal', { token, body: { weeklyGoal: 3 } });
  const afterGoal = (await api('GET', homeUrl, { token })).body;
  check('change weekly goal to 3 → progress recalculated', goal.status === 200 && afterGoal.week.goal === 3 && afterGoal.week.percent === 33, `${afterGoal.week.percent}%`);
  const badGoal = await api('PUT', '/me/goal', { token, body: { weeklyGoal: 9 } });
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
  for (let i = 0; i < cls.capacity - 1; i += 1) fillerIds.push(crypto.randomUUID());
  await db.query('insert into class_bookings (slot_id, class_date, user_id) select $1, $2, unnest($3::uuid[])', [cls.id, tomorrow, fillerIds]);
  const race = await Promise.all([token, token2].map((t) => api('POST', `/classes/${cls.id}/bookings`, { token: t, body: { date: tomorrow } })));
  const statuses = race.map((r) => r.status).sort();
  const count = await db.query('select count(*)::int n from class_bookings where slot_id = $1 and class_date = $2', [cls.id, tomorrow]);
  check('two people, one last spot: exactly one gets it', statuses[0] === 200 && statuses[1] === 409, `statuses ${statuses.join(' and ')} (${race.find((r) => r.status === 409)?.body?.error?.code})`);
  check('class is never overbooked', count.rows[0].n === cls.capacity, `${count.rows[0].n} bookings for ${cls.capacity} places`);
}

async function cleanup() {
  // Remove only the users this run created.
  const emails = users.map((u) => u.email);
  const found = await db.query('select id from neon_auth."user" where email = any($1)', [emails]);
  const ids = found.rows.map((r) => r.id);
  await db.query('delete from class_bookings where user_id = any($1)', [[...ids, ...fillerIds]]);
  if (ids.length) {
    await db.query('delete from workout_logs where user_id = any($1)', [ids]);
    await db.query('delete from profiles where user_id = any($1)', [ids]);
    await db.query('delete from uploads where user_id = any($1)', [ids]);
    await db.query('delete from neon_auth.session where "userId" = any($1)', [ids]);
    await db.query('delete from neon_auth.account where "userId" = any($1)', [ids]);
    await db.query('delete from neon_auth."user" where id = any($1)', [ids]);
  }
  console.log(`\nCleanup: removed ${ids.length} test user(s)`);
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
