/**
 * Sign-in for the one admin of the web console, with the email and password in this server's .env.
 *
 * Everyone else (members and dietitians) signs in with Firebase. The admin does not need a Google
 * or Firebase account: after a correct email and password the API hands out its own signed token,
 * valid for 12 hours, which the console sends like any other bearer token.
 */
const crypto = require('node:crypto');
const { SignJWT, jwtVerify } = require('jose');

const env = require('../config/env');

const ISSUER = 'l5fitness-api';
const AUDIENCE = 'console-admin';
const SESSION_HOURS = 12;
const MIN_PRODUCTION_PASSWORD = 12;

/** The id used for the admin everywhere (diet plans they write, assignments they make). */
const ADMIN_ID = 'local-admin';

const key = env.adminSessionSecret.length >= 32 ? new TextEncoder().encode(env.adminSessionSecret) : null;

/** Why admin login is unavailable right now, or null when it works. */
function unavailableReason() {
  if (!env.adminEmail || !env.adminPassword) return 'ADMIN_EMAIL and ADMIN_PASSWORD are not set.';
  if (!key) return 'ADMIN_SESSION_SECRET is missing or shorter than 32 characters.';
  if (env.isProduction && env.adminPassword.length < MIN_PRODUCTION_PASSWORD)
    return `ADMIN_PASSWORD must be at least ${MIN_PRODUCTION_PASSWORD} characters when NODE_ENV=production.`;
  return null;
}

/** Says out loud, once at start-up, what an operator needs to know. */
function reportStatus() {
  const reason = unavailableReason();
  if (reason) {
    console.warn(`[admin] Admin password login is OFF: ${reason}`);
    return;
  }
  console.log(`[admin] Admin password login is on for ${env.adminEmail}`);
  if (env.adminPassword.length < MIN_PRODUCTION_PASSWORD)
    console.warn(
      `[security] ADMIN_PASSWORD is shorter than ${MIN_PRODUCTION_PASSWORD} characters. That is fine on your own computer, ` +
        'but change it before the console is on the internet (it is refused outright when NODE_ENV=production).'
    );
}

/** Compares two texts without leaking, through timing, how much of them matched. */
function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Returns a signed token for a correct email and password, otherwise null. */
async function login(email, password) {
  if (unavailableReason()) return null;
  // Both are always compared, so a wrong email and a wrong password take the same time.
  const emailOk = same(String(email).trim().toLowerCase(), env.adminEmail);
  const passwordOk = same(password, env.adminPassword);
  if (!(emailOk && passwordOk)) return null;
  return new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(ADMIN_ID)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key);
}

/** Returns the admin as a request user, or null when the token is not a valid admin session. */
async function verify(token) {
  if (!key || typeof token !== 'string' || token.length > 2048) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE });
    if (payload.sub !== ADMIN_ID || payload.role !== 'admin') return null;
    return { id: ADMIN_ID, name: 'Admin', email: env.adminEmail, image: null, emailVerified: true, localAdmin: true };
  } catch {
    return null;
  }
}

module.exports = { ADMIN_ID, SESSION_HOURS, login, verify, reportStatus, unavailableReason };
