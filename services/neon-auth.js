/**
 * Neon Auth (managed Better Auth) client for this server.
 *
 * Neon hosts the auth server and keeps users and sessions in the `neon_auth` schema of our
 * database. Its own SDK is built for browsers (cookies), so the mobile app does not call it
 * directly. Instead the app calls this API, and this API calls Neon Auth's REST endpoints.
 *
 * Token: on sign-in Neon Auth sets a signed session cookie. We hand that cookie's value to the
 * app as an opaque bearer token. On later requests we send it back to Neon Auth to check it, so
 * a signed-out or expired session stops working straight away. It is valid for 7 days.
 */
const crypto = require('node:crypto');

const env = require('../config/env');
const { HttpError } = require('../middleware/errors');

const SESSION_COOKIE = '__Secure-neon-auth.session_token';
const TOKEN_FORMAT = /^[A-Za-z0-9._~%+/=-]{20,512}$/; // also keeps `;` out of the Cookie header

/** Short cache so a burst of requests does not mean one Neon Auth round trip each. */
const CACHE_TTL = 30_000;
const CACHE_MAX = 5_000;
const cache = new Map();
const cacheKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function call(method, path, { body, token } = {}) {
  let res;
  try {
    res = await fetch(env.authBaseUrl + path, {
      method,
      headers: {
        origin: env.authOrigin,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    console.error('[auth] Neon Auth unreachable:', err.message);
    throw new HttpError(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Try again.');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body: leave data as null
  }
  return { res, data };
}

function sessionTokenFrom(res) {
  for (const cookie of res.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const eq = pair.indexOf('=');
    if (pair.slice(0, eq).trim() === SESSION_COOKIE) return pair.slice(eq + 1).trim();
  }
  return null;
}

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  emailVerified: !!u.emailVerified,
  image: u.image ?? null,
});

/** Turns a Neon Auth error into one with a message that is safe to show in the app. */
function authFailure(res, data) {
  const code = data?.code || 'AUTH_ERROR';
  if (code === 'INVALID_EMAIL_OR_PASSWORD')
    return new HttpError(401, code, 'Incorrect email or password.');
  if (code.startsWith('USER_ALREADY_EXISTS'))
    return new HttpError(409, 'USER_ALREADY_EXISTS', 'An account with this email already exists. Log in instead.');
  if (res.status === 429)
    return new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts. Wait a minute and try again.');
  if (res.status >= 500) {
    console.error('[auth] Neon Auth error', res.status, code);
    return new HttpError(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Try again.');
  }
  if (res.status === 403) {
    // Almost always: AUTH_ORIGIN is not on the Neon Auth trusted-domain list.
    console.error('[auth] Neon Auth refused the request:', code, data?.message);
    return new HttpError(503, 'AUTH_MISCONFIGURED', 'Sign-in is temporarily unavailable. Try again.');
  }
  return new HttpError(400, code, data?.message || 'Could not complete the request.');
}

async function startSession(path, body) {
  const { res, data } = await call('POST', path, { body });
  if (!res.ok) throw authFailure(res, data);
  const token = sessionTokenFrom(res);
  if (!token || !data?.user) {
    // e.g. email verification is switched on, so no session is created at sign-up
    throw new HttpError(403, 'NO_SESSION', 'Account created. Verify your email, then log in.');
  }
  return { token, user: publicUser(data.user) };
}

const signUp = ({ name, email, password }) => startSession('/sign-up/email', { name, email, password });
const signIn = ({ email, password }) => startSession('/sign-in/email', { email, password });

/** Returns { user, expiresAt } for a valid token, or null. */
async function getSession(token) {
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return null;

  const key = cacheKey(token);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.session;

  const { res, data } = await call('GET', '/get-session', { token });
  if (!res.ok) throw authFailure(res, data);
  if (!data?.user || !data?.session) {
    cache.delete(key);
    return null;
  }

  const session = { user: publicUser(data.user), expiresAt: data.session.expiresAt };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { session, until: Date.now() + CACHE_TTL });
  return session;
}

async function signOut(token) {
  if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return;
  cache.delete(cacheKey(token));
  await call('POST', '/sign-out', { token, body: {} });
}

async function ping() {
  const { res, data } = await call('GET', '/ok');
  if (!res.ok || data?.ok !== true) throw new Error(`Neon Auth health check returned ${res.status}`);
}

module.exports = { signUp, signIn, signOut, getSession, ping };
