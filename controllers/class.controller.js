const classes = require('../models/class.model');
const { HttpError } = require('../middleware/errors');
const { isUuid, readDay } = require('./validate');

function readSlotId(req) {
  if (!isUuid(req.params.id)) throw new HttpError(404, 'CLASS_NOT_FOUND', 'Class not found.');
  return req.params.id;
}

/** GET /classes?date=YYYY-MM-DD — the timetable for one day (default: today at the gym). */
async function list(req, res) {
  const date = req.query.date ? readDay(req.query.date) : await classes.gymToday();
  res.json({ date, classes: await classes.listForDate(date, req.user.id) });
}

/** POST /classes/:id/bookings { date } — safe to repeat: booking twice keeps one booking. */
async function book(req, res) {
  const date = readDay(req.body?.date);
  res.json({ class: await classes.book(readSlotId(req), date, req.user.id) });
}

/** DELETE /classes/:id/bookings/:date */
async function cancel(req, res) {
  const date = readDay(req.params.date);
  res.json({ class: await classes.cancel(readSlotId(req), date, req.user.id) });
}

module.exports = { list, book, cancel };
