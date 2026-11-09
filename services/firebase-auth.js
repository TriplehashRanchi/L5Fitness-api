/**
 * Who is calling? Firebase Authentication answers that.
 *
 * The app signs the member in with Firebase (email or Google) and sends Firebase's ID token with
 * every request. This file checks that token is genuine: signed by Google, issued for OUR
 * Firebase project, and not expired. It only needs the project ID and Google's public keys. It
 * needs no password or private key, so none is stored on this server.
 *
 * A token stays valid until it expires (1 hour) even if the account is disabled meanwhile.
 * Checking that live would need Firebase Admin credentials; add them only if that is required.
 */
const { createRemoteJWKSet, jwtVerify } = require('jose');

const env = require('../config/env');

const KEYS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
// Cached and refreshed by `jose` as Google rotates its keys.
const keys = createRemoteJWKSet(new URL(KEYS_URL), { cooldownDuration: 30_000 });

const TOKEN_FORMAT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

const nameFromEmail = (email) => {
  const local = (email || '').split('@')[0] || 'Athlete';
  return local.charAt(0).toUpperCase() + local.slice(1);
};

/** Returns { user } for a genuine token, or null. Never throws for a bad token. */
async function getSession(token) {
  if (typeof token !== 'string' || token.length > 4096 || !TOKEN_FORMAT.test(token)) return null;
  try {
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${env.firebaseProjectId}`,
      audience: env.firebaseProjectId,
      clockTolerance: 30,
    });
    // Firebase user IDs are the token's subject. An empty one means something is wrong.
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return null;
    if (payload.auth_time && payload.auth_time > Date.now() / 1000 + 30) return null;

    return {
      user: {
        id: payload.sub,
        name: payload.name || nameFromEmail(payload.email),
        email: payload.email || '',
        emailVerified: !!payload.email_verified,
        image: payload.picture ?? null,
      },
    };
  } catch (err) {
    // Bad signature, wrong project, expired: all just "not signed in". A key-download problem
    // is the only case worth a log line.
    if (err.code === 'ERR_JWKS_TIMEOUT' || err.name === 'JWKSTimeout' || err.code === 'ERR_JOSE_GENERIC')
      console.error('[auth] could not reach Google for signing keys:', err.message);
    return null;
  }
}

async function ping() {
  const res = await fetch(KEYS_URL, { signal: AbortSignal.timeout(10_000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.keys?.length) throw new Error(`Google signing keys returned ${res.status}`);
}

module.exports = { getSession, ping };
