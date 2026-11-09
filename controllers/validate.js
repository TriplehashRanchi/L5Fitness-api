/** Small input checks shared by the controllers. Each throws an HttpError the app can show. */
const { HttpError } = require('../middleware/errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const isUuid = (value) => typeof value === 'string' && UUID_RE.test(value);

/** A real calendar date written as YYYY-MM-DD (so 2026-02-31 is rejected). */
function readDay(value, name = 'date') {
  if (typeof value === 'string' && DAY_RE.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new HttpError(400, 'INVALID_DATE', `"${name}" must be a date like 2026-01-31.`);
}

const dayToMs = (day) => Date.parse(`${day}T00:00:00Z`);
const addDays = (day, amount) => new Date(dayToMs(day) + amount * DAY_MS).toISOString().slice(0, 10);
/** 0 = Sunday … 6 = Saturday */
const weekdayOf = (day) => new Date(dayToMs(day)).getUTCDay();

/**
 * "Today" comes from the member's phone, because only the phone knows their time zone. It can
 * differ from the server's date by at most a day, so anything further off is refused.
 */
function readToday(value, name = 'today') {
  const day = readDay(value, name);
  if (Math.abs(dayToMs(day) - Date.now()) > 2 * DAY_MS)
    throw new HttpError(400, 'INVALID_DATE', `"${name}" is not today's date. Check the date on your phone.`);
  return day;
}

function readInt(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new HttpError(400, 'INVALID_NUMBER', `"${name}" must be a whole number from ${min} to ${max}.`);
  return value;
}

module.exports = { isUuid, readDay, readToday, readInt, addDays, weekdayOf, dayToMs, DAY_MS };
