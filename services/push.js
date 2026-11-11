/**
 * Sends push notifications through Expo's push service (it talks to Google FCM and Apple APNs for us).
 *
 * - Messages go out in batches of 100 (the service's limit).
 * - A token the service says is no longer valid (app uninstalled) is removed.
 * - Delivery receipts are checked about 15 minutes later, as Expo recommends. They are kept in this
 *   process's memory, so a restart simply skips that check; bad tokens are still removed at send time.
 * - Optional EXPO_ACCESS_TOKEN: switch on "enhanced security" in your Expo account and set it here, so
 *   that only this server can send to your app.
 */
const db = require('./db');

const SEND_URL = 'https://exp.host/--/api/v2/push/send';
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const BATCH = 100;
const RECEIPT_DELAY_MS = 15 * 60_000;

const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim() || '';

/** Same shape the phone sends: ExponentPushToken[...] (or the older ExpoPushToken[...]). */
const isExpoToken = (value) => typeof value === 'string' && /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,}\]$/.test(value);

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const first = json?.errors?.[0];
    throw new Error(`push service ${res.status}${first ? `: ${first.code} ${first.message}` : ''}`);
  }
  return json;
}

async function dropTokens(tokens) {
  if (!tokens.length) return;
  await db.query('delete from push_tokens where token = any($1::text[])', [tokens]);
}

/** Looks at delivery receipts later and removes tokens that turned out to be dead. */
function checkReceiptsLater(tickets) {
  if (!tickets.length) return;
  const timer = setTimeout(async () => {
    try {
      const dead = [];
      for (let i = 0; i < tickets.length; i += 1000) {
        const slice = tickets.slice(i, i + 1000);
        const json = await post(RECEIPTS_URL, { ids: slice.map((t) => t.id) });
        for (const t of slice) {
          const receipt = json?.data?.[t.id];
          if (receipt?.status !== 'error') continue;
          const code = receipt.details?.error;
          if (code === 'DeviceNotRegistered') dead.push(t.token);
          else console.warn(`[push] delivery problem: ${code ?? receipt.message}`);
        }
      }
      await dropTokens(dead);
    } catch (err) {
      console.warn('[push] could not check receipts:', err.message);
    }
  }, RECEIPT_DELAY_MS);
  timer.unref();
}

/**
 * Sends one message to many phones. Returns { sent, failed } counts of tokens (never throws).
 * `data` is delivered to the app untouched (we put the screen to open there).
 */
async function sendToTokens(tokens, { title, body, data }) {
  const valid = [...new Set(tokens.filter(isExpoToken))];
  let sent = 0;
  let failed = 0;
  const dead = [];
  const tickets = [];

  for (let i = 0; i < valid.length; i += BATCH) {
    const slice = valid.slice(i, i + BATCH);
    try {
      const json = await post(
        SEND_URL,
        slice.map((to) => ({ to, title, body, data, sound: 'default', priority: 'high', channelId: 'default' }))
      );
      json.data.forEach((ticket, index) => {
        if (ticket.status === 'ok') {
          sent += 1;
          if (ticket.id) tickets.push({ id: ticket.id, token: slice[index] });
        } else {
          failed += 1;
          if (ticket.details?.error === 'DeviceNotRegistered') dead.push(slice[index]);
          else console.warn(`[push] not accepted: ${ticket.details?.error ?? ticket.message}`);
        }
      });
    } catch (err) {
      failed += slice.length;
      console.warn('[push] batch failed:', err.message);
    }
  }
  await dropTokens(dead).catch(() => {});
  checkReceiptsLater(tickets);
  return { sent, failed };
}

module.exports = { sendToTokens, isExpoToken };
