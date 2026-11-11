/**
 * Alerts for browsers (dietitians using the web console), sent through Firebase Cloud Messaging (HTTP v1).
 *
 * Needs a service-account key in this server's environment (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY).
 * Without it the console still saves everything and the inbox works, but browsers are not alerted.
 * The key never leaves this server; it only signs a short-lived token for Google.
 */
const { SignJWT, importPKCS8 } = require('jose');

const env = require('../config/env');
const db = require('./db');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const configured = () => !!(env.firebaseClientEmail && env.firebasePrivateKey);
/** FCM web tokens are long URL-safe strings. */
const isWebToken = (value) => typeof value === 'string' && /^[A-Za-z0-9_:.-]{100,400}$/.test(value);

let cached = null;
let warned = false;

async function accessToken() {
  if (cached && cached.expires > Date.now()) return cached.token;
  const key = await importPKCS8(env.firebasePrivateKey, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(env.firebaseClientEmail)
    .setSubject(env.firebaseClientEmail)
    .setAudience(TOKEN_URL)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) throw new Error(`Google sign-in for push failed: ${json.error_description || json.error || res.status}`);
  cached = { token: json.access_token, expires: Date.now() + Math.max(60, (json.expires_in || 3600) - 120) * 1000 };
  return cached.token;
}

/** Returns 'ok', 'dead' (the browser unsubscribed: drop the token) or 'failed'. */
async function sendOne(token, { title, body, data }, bearer) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.firebaseProjectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        // Data-only: the console's service worker shows it (so the click can open the right page).
        data: { title, body, ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return 'ok';
  const json = await res.json().catch(() => null);
  const code = json?.error?.details?.find?.((d) => d.errorCode)?.errorCode || json?.error?.status;
  if (res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') return 'dead';
  console.warn(`[web-push] not accepted: ${res.status} ${code ?? json?.error?.message ?? ''}`);
  return 'failed';
}

/** Returns { sent, failed } (never throws). */
async function sendToTokens(tokens, message) {
  const unique = [...new Set(tokens.filter(isWebToken))];
  if (!unique.length) return { sent: 0, failed: 0 };
  if (!configured()) {
    if (!warned) {
      warned = true;
      console.warn('[web-push] browser alerts are off: add the service-account key (npm run firebase:key -- <file.json>).');
    }
    return { sent: 0, failed: unique.length };
  }
  let sent = 0;
  let failed = 0;
  const dead = [];
  try {
    const bearer = await accessToken();
    for (let i = 0; i < unique.length; i += 20) {
      const slice = unique.slice(i, i + 20);
      const results = await Promise.all(slice.map((t) => sendOne(t, message, bearer).catch(() => 'failed')));
      results.forEach((r, index) => {
        if (r === 'ok') sent += 1;
        else {
          failed += 1;
          if (r === 'dead') dead.push(slice[index]);
        }
      });
    }
  } catch (err) {
    console.warn('[web-push]', err.message);
    failed = unique.length - sent;
  }
  if (dead.length) await db.query('delete from push_tokens where token = any($1::text[])', [dead]).catch(() => {});
  return { sent, failed };
}

module.exports = { sendToTokens, isWebToken, configured };
