/**
 * Live updates over Socket.IO, on the same port as the API.
 *
 * What it carries: chat. Messages are still SAVED through the normal API (POST /chat …), where
 * sign-in, validation and limits already live; this file only tells the people who have the chat
 * open that something happened, so they do not have to ask again:
 *   chat:message  a new message in a thread
 *   chat:read     one side has now read the thread
 *   chat:typing   the other side is writing
 *   chat:new      (to a dietitian and the admin) a client wrote: refresh the unread counts
 *
 * Rooms: every socket is in `user:<id>`. A member is also in `thread:<their id>`. A dietitian or
 * the admin joins `thread:<member id>` by asking (chat:join), and only for a client they may manage.
 *
 * One server process is assumed (rooms are kept in memory). To run several, add the Socket.IO
 * Redis adapter and sticky sessions at the load balancer.
 */
const { Server } = require('socket.io');

const auth = require('./firebase-auth');
const adminSession = require('./admin-session');
const members = require('../models/member.model');
const chat = require('../models/chat.model');

let io = null;

const threadRoom = (memberId) => `thread:${memberId}`;
const userRoom = (userId) => `user:${userId}`;
const ADMINS = 'admins';

/** Who is connecting? The same tokens as the API: the admin's own, or a Firebase sign-in. */
async function identify(token) {
  const admin = await adminSession.verify(token);
  if (admin) return { id: admin.id, name: admin.name, role: 'admin' };
  const session = await auth.getSession(token);
  if (!session) return null;
  const { role, disabled } = await members.accessOf(session.user.id);
  if (disabled) return null;
  return { id: session.user.id, name: session.user.name, role };
}

/** A small brake per socket: at most `max` of one kind of event per `ms`. */
function allow(socket, kind, max, ms) {
  const now = Date.now();
  const seen = (socket.data.seen ??= {});
  const recent = (seen[kind] ?? []).filter((t) => now - t < ms);
  if (recent.length >= max) return false;
  recent.push(now);
  seen[kind] = recent;
  return true;
}

/** Which thread is this socket talking about, if it may? A member: always their own. */
function threadOf(socket, memberId) {
  const { user } = socket.data;
  if (user.role === 'member') return user.id;
  return typeof memberId === 'string' && socket.rooms.has(threadRoom(memberId)) ? memberId : null;
}

function attach(server, { canManage }) {
  io = new Server(server, {
    // The same rule as the API: open CORS is fine, sign-in is a bearer token and never a cookie.
    cors: { origin: '*' },
    // Chat messages are short; nothing big ever comes in over the socket.
    maxHttpBufferSize: 20_000,
  });

  io.use(async (socket, next) => {
    try {
      const user = await identify(socket.handshake.auth?.token);
      if (!user) return next(new Error('UNAUTHORIZED'));
      socket.data.user = user;
      next();
    } catch (err) {
      console.warn('[realtime] sign-in check failed:', err.message);
      next(new Error('UNAVAILABLE'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    const side = user.role === 'member' ? 'member' : 'staff';
    socket.join(userRoom(user.id));
    if (user.role === 'member') socket.join(threadRoom(user.id));
    if (user.role === 'admin') socket.join(ADMINS);

    // A dietitian (or the admin) opens a client's chat.
    socket.on('chat:join', async (memberId, done) => {
      const reply = typeof done === 'function' ? done : () => {};
      try {
        if (side !== 'staff' || !allow(socket, 'join', 30, 60_000)) return reply({ ok: false });
        const ok = !!(await canManage({ staff: { role: user.role }, user: { id: user.id } }, memberId));
        if (ok) socket.join(threadRoom(memberId));
        reply({ ok });
      } catch {
        reply({ ok: false });
      }
    });

    socket.on('chat:leave', (memberId) => {
      if (side === 'staff' && typeof memberId === 'string') socket.leave(threadRoom(memberId));
    });

    // "I have the chat open and have seen what you wrote."
    socket.on('chat:read', async (payload) => {
      try {
        const memberId = threadOf(socket, payload?.memberId);
        if (!memberId || !allow(socket, 'read', 60, 60_000)) return;
        if (await chat.markRead(memberId, side)) read(memberId, side);
      } catch (err) {
        console.warn('[realtime] chat:read failed:', err.message);
      }
    });

    socket.on('chat:typing', (payload) => {
      const memberId = threadOf(socket, payload?.memberId);
      if (!memberId || !allow(socket, 'typing', 40, 60_000)) return;
      socket.to(threadRoom(memberId)).emit('chat:typing', { memberId, from: side, typing: !!payload?.typing });
    });
  });

  return io;
}

/** A message was saved. `dietitianId` is who to nudge when a member wrote. */
function message(memberId, saved, { fromMember, dietitianId }) {
  if (!io) return;
  io.to(threadRoom(memberId)).emit('chat:message', {
    memberId,
    message: { id: saved.id, body: saved.body, createdAt: saved.createdAt, readAt: saved.readAt, fromMember },
  });
  if (fromMember) {
    const rooms = dietitianId ? [userRoom(dietitianId), ADMINS] : [ADMINS];
    io.to(rooms).emit('chat:new', { memberId });
  }
}

/** One side has read the thread up to now. */
function read(memberId, side) {
  io?.to(threadRoom(memberId)).emit('chat:read', { memberId, by: side, at: new Date().toISOString() });
}

/** Stop taking part (used on shutdown). */
const close = () => new Promise((resolve) => (io ? io.close(() => resolve()) : resolve()));

module.exports = { attach, message, read, close };
