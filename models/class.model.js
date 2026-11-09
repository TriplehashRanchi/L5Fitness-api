const db = require('../services/db');
const env = require('../config/env');
const { HttpError } = require('../middleware/errors');

/** How far ahead a class can be booked. */
const BOOKING_WINDOW_DAYS = 7;

/**
 * One class on one date. $1 = date, $2 = gym time zone, $3 = the member asking.
 * startsAt is an exact moment: the timetable's wall-clock time in the gym's zone on that date.
 */
const CLASS_ON_DATE = `
  select s.id, s.name, s.trainer, s.icon,
         s.duration_min as "durationMin", s.capacity,
         $1::date::text as "date",
         (($1::date + s.start_time) at time zone $2::text) as "startsAt",
         greatest(s.capacity - (select count(*) from class_bookings b
                                where b.slot_id = s.id and b.class_date = $1::date), 0)::int as "spotsLeft",
         exists (select 1 from class_bookings b
                 where b.slot_id = s.id and b.class_date = $1::date and b.user_id = $3) as "booked"
  from class_slots s
  where s.is_active and extract(dow from $1::date)::int = any (s.weekdays)`;

/** Today's date at the gym, as 'YYYY-MM-DD'. */
async function gymToday() {
  const { rows } = await db.query('select (now() at time zone $1::text)::date::text as day', [env.gymTimeZone]);
  return rows[0].day;
}

async function listForDate(date, userId) {
  const { rows } = await db.query(`${CLASS_ON_DATE} order by s.start_time`, [date, env.gymTimeZone, userId]);
  return rows;
}

async function findOnDate(runner, slotId, date, userId) {
  const { rows } = await runner.query(`${CLASS_ON_DATE} and s.id = $4`, [date, env.gymTimeZone, userId, slotId]);
  return rows[0] ?? null;
}

async function book(slotId, date, userId) {
  return db.transaction(async (client) => {
    // Lock the timetable row first. Two people going for the last spot now queue up here, and
    // the second one sees the first booking when it counts. Without this both could get in.
    const lock = await client.query('select id from class_slots where id = $1 and is_active for update', [slotId]);
    if (!lock.rowCount) throw new HttpError(404, 'CLASS_NOT_FOUND', 'Class not found.');

    const window = await client.query(
      `select $1::date between (now() at time zone $2::text)::date
                           and (now() at time zone $2::text)::date + $3::int as ok`,
      [date, env.gymTimeZone, BOOKING_WINDOW_DAYS]
    );
    if (!window.rows[0].ok)
      throw new HttpError(400, 'OUTSIDE_BOOKING_WINDOW', `Classes can be booked up to ${BOOKING_WINDOW_DAYS} days ahead.`);

    const cls = await findOnDate(client, slotId, date, userId);
    if (!cls) throw new HttpError(404, 'CLASS_NOT_FOUND', 'This class does not run on that day.');
    if (cls.booked) return cls; // already booked: nothing to do
    if (new Date(cls.startsAt) <= new Date())
      throw new HttpError(409, 'CLASS_STARTED', 'This class has already started.');
    if (cls.spotsLeft <= 0) throw new HttpError(409, 'CLASS_FULL', 'This class is full.');

    await client.query('insert into class_bookings (slot_id, class_date, user_id) values ($1, $2, $3)', [
      slotId,
      date,
      userId,
    ]);
    return findOnDate(client, slotId, date, userId);
  });
}

async function cancel(slotId, date, userId) {
  const cls = await findOnDate(db, slotId, date, userId);
  if (!cls) throw new HttpError(404, 'CLASS_NOT_FOUND', 'Class not found.');
  if (!cls.booked) return cls;
  if (new Date(cls.startsAt) <= new Date())
    throw new HttpError(409, 'CLASS_STARTED', 'This class has already started, so the booking cannot be cancelled.');

  await db.query('delete from class_bookings where slot_id = $1 and class_date = $2 and user_id = $3', [
    slotId,
    date,
    userId,
  ]);
  return findOnDate(db, slotId, date, userId);
}

module.exports = { gymToday, listForDate, book, cancel, BOOKING_WINDOW_DAYS };
