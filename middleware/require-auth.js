const auth = require('../services/neon-auth');
const { HttpError } = require('./errors');

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

/** Rejects the request unless it carries a valid session token. Sets req.user and req.token. */
async function requireAuth(req, res, next) {
  const token = bearerToken(req);
  const session = token ? await auth.getSession(token) : null;
  if (!session) throw new HttpError(401, 'UNAUTHORIZED', 'Please log in again.');
  req.user = session.user;
  req.token = token;
  next();
}

module.exports = { requireAuth, bearerToken };
