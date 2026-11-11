const auth = require('../services/firebase-auth');
const adminSession = require('../services/admin-session');
const members = require('../models/member.model');
const { HttpError } = require('./errors');

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/** When each member's name/email/photo was last written to the members table. */
const seen = new Map();
const REFRESH_MS = 10 * 60_000;

async function rememberMember(user) {
  const signature = `${user.name}|${user.email}|${user.image}`;
  const prev = seen.get(user.id);
  if (prev && prev.signature === signature && Date.now() - prev.at < REFRESH_MS) return;
  await members.touch(user);
  await members.applyAccessRules(user);
  seen.set(user.id, { signature, at: Date.now() });
  if (seen.size > 5000) seen.delete(seen.keys().next().value);
}

/** Forget a member (used when their account is deleted) so they are written afresh if they return. */
const forget = (userId) => seen.delete(userId);

/** Rejects the request unless it carries a genuine Firebase ID token. Sets req.user. */
async function requireAuth(req, res, next) {
  const token = bearerToken(req);
  // The console admin's own token (signed with a secret only this server has).
  const admin = await adminSession.verify(token);
  if (admin) {
    req.user = admin;
    return next();
  }
  const session = await auth.getSession(token);
  if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Please log in again.');
  req.user = session.user;
  await rememberMember(session.user);
  next();
}

/** For dietitians (who have not been disabled) and the admin. Sets req.staff = { role }. */
async function requireDietitian(req, res, next) {
  const { role, disabled } = await members.accessOf(req.user.id);
  if (!['dietitian', 'admin'].includes(role) || disabled)
    throw new HttpError(403, 'FORBIDDEN', 'This is only for dietitians.');
  req.staff = { role };
  next();
}

/** For the admin only. */
async function requireAdmin(req, res, next) {
  const { role, disabled } = await members.accessOf(req.user.id);
  if (role !== 'admin' || disabled) throw new HttpError(403, 'FORBIDDEN', 'This is only for the admin.');
  req.staff = { role };
  next();
}

module.exports = { requireAuth, requireDietitian, requireAdmin, bearerToken, forget };
