const db = require('../services/db');

// ── Phones ────────────────────────────────────────────────────────────────────────────────────

/** Remembers a phone for this member. If the phone was last used by someone else, it moves over. */
async function saveToken({ userId, token, platform, deviceName }) {
  await db.query(
    `insert into push_tokens (token, user_id, platform, device_name) values ($1, $2, $3, $4)
     on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform,
       device_name = excluded.device_name, last_seen_at = now()`,
    [token, userId, platform, deviceName]
  );
}

/** Only removes the token when it still belongs to this member. */
async function removeToken(userId, token) {
  await db.query('delete from push_tokens where token = $1 and user_id = $2', [token, userId]);
}

async function getPreferences(userId) {
  const { rows } = await db.query('select push_enabled as "pushEnabled" from members where user_id = $1', [userId]);
  return rows[0] ?? { pushEnabled: true };
}

async function setPushEnabled(userId, enabled) {
  await db.query('update members set push_enabled = $2 where user_id = $1', [userId, enabled]);
}

async function create({ sender, audience, title, body, screen, userIds }) {
  return db.transaction(async (client) => {
    const { rows } = await client.query(
      `insert into notifications (sender_id, sender_role, sender_name, audience, title, body, screen, recipient_count)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, audience, title, body, screen, recipient_count as "recipientCount", created_at as "createdAt"`,
      [sender.id, sender.role, sender.name, audience, title, body, screen, userIds.length]
    );
    const notification = rows[0];
    if (userIds.length) {
      await client.query(
        `insert into notification_recipients (notification_id, user_id)
         select $1, unnest($2::text[]) on conflict do nothing`,
        [notification.id, userIds]
      );
    }
    return notification;
  });
}

/** The phones and browsers to alert: members who have not muted pushes. */
async function tokensFor(userIds) {
  if (!userIds.length) return [];
  const { rows } = await db.query(
    `select t.token, t.platform from push_tokens t join members m on m.user_id = t.user_id
     where t.user_id = any($1::text[]) and m.push_enabled`,
    [userIds]
  );
  return rows;
}

async function recordResult(id, { sent, failed }) {
  await db.query('update notifications set push_sent = $2, push_failed = $3 where id = $1', [id, sent, failed]);
}

// ── A member's inbox ──────────────────────────────────────────────────────────────────────────

async function inbox(userId, { before, limit = 30 }) {
  const { rows } = await db.query(
    `select n.id, n.title, n.body, n.screen, n.sender_name as "from", n.sender_role as "fromRole",
            n.created_at as "createdAt", (r.read_at is not null) as read
     from notification_recipients r join notifications n on n.id = r.notification_id
     where r.user_id = $1 and ($2::timestamptz is null or n.created_at < $2::timestamptz)
     order by n.created_at desc limit $3`,
    [userId, before ?? null, limit]
  );
  return rows;
}

async function unreadCount(userId) {
  const { rows } = await db.query(
    'select count(*)::int as n from notification_recipients where user_id = $1 and read_at is null',
    [userId]
  );
  return rows[0].n;
}

/** ids = specific messages, or null for "everything". */
async function markRead(userId, ids) {
  await db.query(
    `update notification_recipients set read_at = now()
     where user_id = $1 and read_at is null and ($2::uuid[] is null or notification_id = any($2::uuid[]))`,
    [userId, ids]
  );
}

module.exports = {
  saveToken, removeToken, getPreferences, setPushEnabled,
  create, tokensFor, recordResult,
  inbox, unreadCount, markRead,
};
