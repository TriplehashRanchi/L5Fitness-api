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

// ── Who a message goes to ─────────────────────────────────────────────────────────────────────

/**
 * The people a message is for. `admin` can reach everybody; a dietitian only their own clients who
 * agreed to share their details (the same rule as the client list). Disabled staff never receive.
 */
async function recipientIds({ audience, senderId, targetId }) {
  switch (audience) {
    case 'everyone':
      return pick("select user_id from members where role in ('member','dietitian') and not disabled");
    case 'all_members':
      return pick("select user_id from members where role = 'member'");
    case 'all_dietitians':
      return pick("select user_id from members where role = 'dietitian' and not disabled");
    case 'my_clients':
      return pick(
        `select a.member_id from client_assignments a
           join body_profiles b on b.user_id = a.member_id and b.share_with_dietitian
         where a.dietitian_id = $1`,
        [senderId]
      );
    case 'user':
      return pick("select user_id from members where user_id = $1 and role <> 'admin' and not disabled", [targetId]);
    default:
      return [];
  }
}

async function pick(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows.map((r) => Object.values(r)[0]);
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────

/** Saves the message and puts it in each recipient's inbox, in one step. */
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

/** How many messages this sender sent in the last hour (to stop accidents and spam). */
async function sentLastHour(senderId) {
  const { rows } = await db.query(
    "select count(*)::int as n from notifications where sender_id = $1 and created_at > now() - interval '1 hour'",
    [senderId]
  );
  return rows[0].n;
}

/** What the sender sent before, newest first. */
async function sentBy(senderId, limit = 30) {
  const { rows } = await db.query(
    `select n.id, n.audience, n.title, n.body, n.screen, n.recipient_count as "recipientCount",
            n.push_sent as "pushSent", n.push_failed as "pushFailed", n.created_at as "createdAt",
            (select count(*)::int from notification_recipients r where r.notification_id = n.id and r.read_at is not null) as "readCount",
            (select m.name from notification_recipients r join members m on m.user_id = r.user_id
               where r.notification_id = n.id and n.audience = 'user' limit 1) as "toName"
     from notifications n where n.sender_id = $1 order by n.created_at desc limit $2`,
    [senderId, limit]
  );
  return rows;
}

/** Counts for the composer: how many people and phones a message would reach right now. */
async function reach(userIds) {
  const phones = userIds.length
    ? (
        await db.query(
          `select count(distinct t.user_id)::int as n from push_tokens t join members m on m.user_id = t.user_id
           where t.user_id = any($1::text[]) and m.push_enabled`,
          [userIds]
        )
      ).rows[0].n
    : 0;
  return { people: userIds.length, withPhone: phones };
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
  recipientIds, create, tokensFor, recordResult, sentLastHour, sentBy, reach,
  inbox, unreadCount, markRead,
};
