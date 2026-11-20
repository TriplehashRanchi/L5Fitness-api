/**
 * Every notification is sent from here, by itself, when something happens: nobody writes them by hand.
 * To a member: a dietitian was assigned, the diet plan, exercise plan or targets changed.
 * To a dietitian: the admin assigned them clients. Either way: a new chat message. Never throws.
 */
const notifications = require('../models/notification.model');
const push = require('./push');
const webPush = require('./web-push');

// One alert per person and kind in this time, so adding 10 meals in a row sends one alert, not ten.
const QUIET_MS = 30 * 60_000;
const lastPing = new Map();

/** True the first time in a while for this key; false while it is still quiet time. */
function due(key) {
  const now = Date.now();
  if (now - (lastPing.get(key) ?? 0) < QUIET_MS) return false;
  lastPing.set(key, now);
  if (lastPing.size > 5000) lastPing.delete(lastPing.keys().next().value);
  return true;
}

async function tell(userId, { title, body, screen, sender }) {
  try {
    const notification = await notifications.create({ sender, audience: 'user', title, body, screen, userIds: [userId] });
    const devices = await notifications.tokensFor([userId]);
    const data = { notificationId: notification.id, screen };
    const phones = devices.filter((d) => d.platform !== 'web').map((d) => d.token);
    const browsers = devices.filter((d) => d.platform === 'web').map((d) => d.token);
    const [a, b] = await Promise.all([
      push.sendToTokens(phones, { title, body, data }),
      webPush.sendToTokens(browsers, { title, body, data }),
    ]);
    await notifications.recordResult(notification.id, { sent: a.sent + b.sent, failed: a.failed + b.failed });
  } catch (err) {
    console.warn('[notify] could not tell member:', err.message);
  }
}

/** Fire and forget: never slows or fails the request that triggered it. */
const assigned = (memberId, dietitianName, actor) =>
  void tell(memberId, {
    title: 'Your dietitian is ready',
    body: `${dietitianName || 'Your dietitian'} will now send your diet and exercise plans.`,
    screen: 'home',
    sender: { id: actor.id, role: actor.role, name: actor.name },
  });

const fromDietitian = (dietitian) => ({ id: dietitian.id, role: 'dietitian', name: dietitian.name || 'Your dietitian' });
const fromAdmin = (admin) => ({ id: admin.id, role: 'admin', name: 'Admin' });

/** The dietitian added or copied meals. */
function dietUpdated(memberId, dietitian) {
  if (!due(`diet:${memberId}`)) return;
  void tell(memberId, {
    title: 'Your diet plan was updated',
    body: 'Your dietitian added new meals. Open the app to see your plan.',
    // Home shows the day's meals; the member's Diet tab is now their chat.
    screen: 'home',
    sender: fromDietitian(dietitian),
  });
}

/** The dietitian saved an exercise plan for a day. */
function trainingUpdated(memberId, dietitian, title) {
  if (!due(`training:${memberId}`)) return;
  void tell(memberId, {
    title: 'New exercise plan',
    body: `${title ? `"${title.slice(0, 80)}" is` : 'A workout is'} ready for you. Open the app to start it.`,
    screen: 'home',
    sender: fromDietitian(dietitian),
  });
}

/** The dietitian changed the daily targets (water, steps, calories…). */
function targetsUpdated(memberId, dietitian) {
  if (!due(`targets:${memberId}`)) return;
  void tell(memberId, {
    title: 'Your daily targets changed',
    body: 'Your dietitian set new targets for you. Open the app to see them.',
    screen: 'home',
    sender: fromDietitian(dietitian),
  });
}

/** To a dietitian: the admin gave them clients. `name` is used when it is one person. */
function clientsAssigned(dietitianId, count, name, admin) {
  if (!count) return;
  void tell(dietitianId, {
    title: count === 1 ? 'New client' : `${count} new clients`,
    body: count === 1
      ? `${name || 'A new client'} was assigned to you. You can set their plan now.`
      : `${count} clients were assigned to you. You can set their plans now.`,
    screen: 'home',
    sender: fromAdmin(admin),
  });
}

const preview = (text) => (text.length > 120 ? `${text.slice(0, 117)}…` : text);

// A chat alert at most once every two minutes per thread and direction: the first message of a burst
// tells them, the rest are waiting in the chat when they open it.
const CHAT_QUIET_MS = 2 * 60_000;
const lastChatPing = new Map();
function chatDue(key) {
  const now = Date.now();
  if (now - (lastChatPing.get(key) ?? 0) < CHAT_QUIET_MS) return false;
  lastChatPing.set(key, now);
  if (lastChatPing.size > 5000) lastChatPing.delete(lastChatPing.keys().next().value);
  return true;
}

/** To a member: their dietitian wrote in the chat. Opens the Diet tab, which is the chat. */
function chatFromDietitian(memberId, dietitian, text) {
  if (!chatDue(`to-member:${memberId}`)) return;
  void tell(memberId, {
    title: `${(dietitian.name || 'Your dietitian').slice(0, 40)} sent a message`,
    body: preview(text),
    screen: 'diet',
    sender: fromDietitian(dietitian),
  });
}

/** To a dietitian: one of their clients wrote in the chat. */
function chatFromMember(dietitianId, member, text) {
  if (!dietitianId || !chatDue(`to-dietitian:${member.id}`)) return;
  void tell(dietitianId, {
    title: `${(member.name || 'A client').slice(0, 40)} sent a message`,
    body: preview(text),
    screen: 'diet',
    sender: { id: member.id, role: 'member', name: member.name || 'A client' },
  });
}

module.exports = { assigned, dietUpdated, trainingUpdated, targetsUpdated, clientsAssigned, chatFromDietitian, chatFromMember };
