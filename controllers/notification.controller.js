/**
 * Push notifications, for everyone signed in: phone or browser registration, the inbox, and the mute switch.
 * Nobody sends a notification by hand: the API sends them itself (services/notify-member.js).
 */
const notifications = require('../models/notification.model');
const push = require('../services/push');
const webPush = require('../services/web-push');
const { HttpError } = require('../middleware/errors');
const { isUuid } = require('./validate');

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const clean = (value) => (typeof value === 'string' ? value.replace(CONTROL_CHARS, '').trim() : '');

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

module.exports = { registerToken, removeToken, inbox, markRead, setPreferences };
