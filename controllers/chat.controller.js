/** Chat between a member and their dietitian. One thread per member. */
const chat = require('../models/chat.model');
const coaching = require('../models/coaching.model');
const members = require('../models/member.model');
const { requireClient } = require('./diet.controller');
const { HttpError } = require('../middleware/errors');
const notifyMember = require('../services/notify-member');
const realtime = require('../services/realtime');

const MAX_LENGTH = 2000;
const MAX_PER_MINUTE = 20;

function readBody(value) {
  const body = typeof value === 'string' ? value.trim() : '';
  if (!body) throw new HttpError(400, 'EMPTY_MESSAGE', 'Write a message first.');
  if (body.length > MAX_LENGTH) throw new HttpError(400, 'MESSAGE_TOO_LONG', `A message can be up to ${MAX_LENGTH} characters.`);
  return body;
}

/** `after` is the time of the newest message the app already has. */
function readAfter(value) {
  if (value === undefined || value === '') return undefined;
  const at = typeof value === 'string' ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) throw new HttpError(400, 'INVALID_DATE', '"after" must be a date and time.');
  return at.toISOString();
}

async function brake(senderId) {
  if ((await chat.sentLastMinute(senderId)) >= MAX_PER_MINUTE)
    throw new HttpError(429, 'TOO_MANY_MESSAGES', 'You are sending messages very quickly. Wait a moment and try again.');
}

/** What an open chat screen needs: the messages, and when the other side last read one of mine. */
async function thread(memberId, side, after) {
  // Opening (or refreshing) the chat is what marks the other side's messages as read.
  if (await chat.markRead(memberId, side)) realtime.read(memberId, side);
  const [messages, seenAt] = await Promise.all([chat.list(memberId, side, { after }), chat.lastSeen(memberId, side)]);
  return { messages, seenAt };
}

// ── Member ────────────────────────────────────────────────────────────────────────────────────

/** GET /chat?after= */
async function myChat(req, res) {
  const care = await coaching.status(req.user.id);
  if (care.status !== 'accepted') return res.json({ coaching: care, dietitian: null, messages: [], seenAt: null });
  const dietitian = await members.get(care.dietitianId);
  res.json({
    coaching: care,
    dietitian: { name: care.dietitianName || 'Your dietitian', image: dietitian?.image ?? null },
    ...(await thread(req.user.id, 'member', readAfter(req.query.after))),
  });
}

/** POST /chat { body } */
async function sendMine(req, res) {
  const body = readBody(req.body?.body);
  const care = await coaching.status(req.user.id);
  if (care.status !== 'accepted')
    throw new HttpError(403, 'ACCEPTANCE_REQUIRED', 'You can chat once a dietitian has been assigned to you.');
  await brake(req.user.id);
  const message = await chat.add(req.user.id, { id: req.user.id, role: 'member' }, body);
  realtime.message(req.user.id, message, { fromMember: true, dietitianId: care.dietitianId });
  notifyMember.chatFromMember(care.dietitianId, { id: req.user.id, name: req.user.name }, body);
  res.status(201).json({ message });
}

// ── Dietitian ─────────────────────────────────────────────────────────────────────────────────

/** GET /dietitian/clients/:id/chat?after= */
async function clientChat(req, res) {
  const { id } = await requireClient(req);
  res.json(await thread(id, 'staff', readAfter(req.query.after)));
}

/** POST /dietitian/clients/:id/chat { body } */
async function sendToClient(req, res) {
  const body = readBody(req.body?.body);
  const { id } = await requireClient(req);
  await brake(req.user.id);
  const message = await chat.add(id, { id: req.user.id, role: req.staff.role }, body);
  realtime.message(id, message, { fromMember: false });
  notifyMember.chatFromDietitian(id, req.user, body);
  res.status(201).json({ message });
}

/** GET /dietitian/chat/unread: how many unread messages each client has sent. */
async function unread(req, res) {
  res.json({ clients: await chat.unreadByClient(req.staff.role === 'dietitian' ? req.user.id : null) });
}

module.exports = { myChat, sendMine, clientChat, sendToClient, unread };
