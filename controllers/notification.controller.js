/**
 * Push notifications.
 *   Staff (admin + dietitians):  POST /staff/notifications, GET /staff/notifications, GET /staff/notifications/reach
 *   Everyone signed in:          phone registration, the in-app inbox, and the mute switch
 */
const notifications = require('../models/notification.model');
const members = require('../models/member.model');
const profiles = require('../models/body-profile.model');
const push = require('../services/push');
const webPush = require('../services/web-push');
const { HttpError } = require('../middleware/errors');
const { isUuid } = require('./validate');

// Who each role may write to. A dietitian can only reach their own clients.
const AUDIENCES = {
  admin: ['everyone', 'all_members', 'all_dietitians', 'user'],
  dietitian: ['my_clients', 'user'],
};
const SCREENS = ['inbox', 'home', 'diet', 'logs'];
const HOURLY_LIMIT = { admin: 60, dietitian: 30 };
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const clean = (value) => (typeof value === 'string' ? value.replace(CONTROL_CHARS, '').trim() : '');

function readAudience(req) {
  const source = req.method === 'GET' ? req.query : (req.body ?? {});
  const audience = typeof source.audience === 'string' ? source.audience : '';
  if (!AUDIENCES[req.staff.role].includes(audience))
    throw new HttpError(400, 'INVALID_AUDIENCE', 'You cannot send to that group.');
  let targetId = null;
  if (audience === 'user') {
    targetId = typeof source.userId === 'string' ? source.userId : '';
    if (!targetId || targetId.length > 128) throw new HttpError(400, 'INVALID_USER', 'Choose who to send this to.');
  }
  return { audience, targetId };
}

/** The people a message would go to, after the rules for this sender. */
async function resolveRecipients(req) {
  const { audience, targetId } = readAudience(req);
  if (audience === 'user' && req.staff.role === 'dietitian') {
    // A dietitian may only message a client who is theirs AND has agreed to share (as in the client list).
    const profile = await profiles.get(targetId);
    const mine = profile?.shareWithDietitian && (await members.isAssigned(targetId, req.user.id));
    if (!mine) throw new HttpError(404, 'CLIENT_NOT_FOUND', 'Client not found.');
  }
  const userIds = await notifications.recipientIds({ audience, senderId: req.user.id, targetId });
  return { audience, userIds };
}

/** GET /staff/notifications/reach?audience=...&userId=... : "this will reach 12 people (9 with a phone)". */
async function reach(req, res) {
  const { userIds } = await resolveRecipients(req);
  res.json(await notifications.reach(userIds));
}

/** POST /staff/notifications { audience, userId?, title, body, screen? } */
async function send(req, res) {
  const body = req.body ?? {};
  const title = clean(body.title);
  const text = clean(body.body);
  if (title.length < 1 || title.length > 60) throw new HttpError(400, 'INVALID_TITLE', 'The title must be 1 to 60 characters.');
  if (text.length < 1 || text.length > 240) throw new HttpError(400, 'INVALID_MESSAGE', 'The message must be 1 to 240 characters.');
  const screen = body.screen === undefined ? 'inbox' : body.screen;
  if (!SCREENS.includes(screen)) throw new HttpError(400, 'INVALID_SCREEN', 'Unknown screen.');

  const { audience, userIds } = await resolveRecipients(req);
  if (!userIds.length) throw new HttpError(409, 'NO_RECIPIENTS', 'There is nobody to send this to yet.');

  if ((await notifications.sentLastHour(req.user.id)) >= HOURLY_LIMIT[req.staff.role])
    throw new HttpError(429, 'TOO_MANY_NOTIFICATIONS', 'You have sent a lot of notifications in the last hour. Please wait a little.');

  const notification = await notifications.create({
    sender: { id: req.user.id, role: req.staff.role, name: clean(req.user.name) || (req.staff.role === 'admin' ? 'Admin' : 'Your dietitian') },
    audience, title, body: text, screen, userIds,
  });

  // The inbox entries are saved, so answer now; ringing the phones can take a while for a big group.
  const devices = await notifications.tokensFor(userIds);
  const data = { notificationId: notification.id, screen };
  const phones = devices.filter((d) => d.platform !== 'web').map((d) => d.token);
  const browsers = devices.filter((d) => d.platform === 'web').map((d) => d.token);
  Promise.all([
    push.sendToTokens(phones, { title, body: text, data }),
    webPush.sendToTokens(browsers, { title, body: text, data }),
  ])
    .then(([a, b]) => notifications.recordResult(notification.id, { sent: a.sent + b.sent, failed: a.failed + b.failed }))
    .catch((err) => console.warn('[push] send failed:', err.message));

  res.status(201).json({ notification, devices: devices.length });
}

/** GET /staff/notifications: what this person sent before. */
async function sent(req, res) {
  res.json({ notifications: await notifications.sentBy(req.user.id) });
}

// ── Any signed-in person ──────────────────────────────────────────────────────────────────────

/** POST /me/push-token { token, platform: 'ios' | 'android' | 'web', deviceName? } */
async function registerToken(req, res) {
  const { token, platform, deviceName } = req.body ?? {};
  if (!['ios', 'android', 'web'].includes(platform)) throw new HttpError(400, 'INVALID_PLATFORM', 'Unknown platform.');
  const valid = platform === 'web' ? webPush.isWebToken(token) : push.isExpoToken(token);
  if (!valid) throw new HttpError(400, 'INVALID_TOKEN', 'That is not a valid push token.');
  await notifications.saveToken({
    userId: req.user.id,
    token,
    platform,
    deviceName: typeof deviceName === 'string' ? clean(deviceName).slice(0, 80) || null : null,
  });
  res.status(204).end();
}

/** POST /me/push-token/remove { token }: called when the person logs out on this phone. */
async function removeToken(req, res) {
  const token = req.body?.token;
  if (typeof token === 'string' && token.length < 400) await notifications.removeToken(req.user.id, token);
  res.status(204).end();
}

/** GET /notifications?before=ISO: the inbox, newest first, with the number still unread. */
async function inbox(req, res) {
  let before;
  if (req.query.before) {
    before = new Date(String(req.query.before));
    if (Number.isNaN(before.getTime())) throw new HttpError(400, 'INVALID_DATE', '"before" is not a date.');
  }
  const [items, unread, prefs] = await Promise.all([
    notifications.inbox(req.user.id, { before: before?.toISOString(), limit: 30 }),
    notifications.unreadCount(req.user.id),
    notifications.getPreferences(req.user.id),
  ]);
  res.json({ notifications: items, unread, pushEnabled: prefs.pushEnabled });
}

/** POST /notifications/read { ids?: [uuid] } : no ids means everything. */
async function markRead(req, res) {
  let ids = null;
  if (req.body?.ids !== undefined) {
    if (!Array.isArray(req.body.ids) || req.body.ids.length > 100 || !req.body.ids.every(isUuid))
      throw new HttpError(400, 'INVALID_IDS', 'Send up to 100 notification ids.');
    ids = req.body.ids;
  }
  await notifications.markRead(req.user.id, ids);
  res.status(204).end();
}

/** PUT /me/notification-settings { pushEnabled } */
async function setPreferences(req, res) {
  if (typeof req.body?.pushEnabled !== 'boolean') throw new HttpError(400, 'INVALID_SETTING', '"pushEnabled" must be true or false.');
  await notifications.setPushEnabled(req.user.id, req.body.pushEnabled);
  res.json({ pushEnabled: req.body.pushEnabled });
}

module.exports = { reach, send, sent, registerToken, removeToken, inbox, markRead, setPreferences };
