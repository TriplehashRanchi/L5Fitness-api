const db = require('../services/db');

/** `mine` is true for the messages written by the side that is asking ('member' or 'staff'). */
const columns = (side) => `id, body, created_at as "createdAt", read_at as "readAt",
  ${side === 'member' ? "(sender_role = 'member')" : "(sender_role <> 'member')"} as mine`;

/**
 * Messages of one member's thread, oldest first.
 * `after` (a time): only newer ones, for a screen that is already open. Otherwise the latest `limit`.
 */
async function list(memberId, side, { after, limit = 200 } = {}) {
  if (after) {
    // Compared at the millisecond the app was given, so a message is not handed over twice.
    const { rows } = await db.query(
      `select ${columns(side)} from chat_messages
       where member_id = $1 and date_trunc('milliseconds', created_at) > $2
       order by created_at limit $3`, [memberId, after, limit]);
    return rows;
  }
  const { rows } = await db.query(
    `select * from (select ${columns(side)} from chat_messages where member_id = $1
       order by created_at desc limit $2) latest order by "createdAt"`, [memberId, limit]);
  return rows;
}

async function add(memberId, sender, body) {
  const side = sender.role === 'member' ? 'member' : 'staff';
  const { rows } = await db.query(
    `insert into chat_messages (member_id, sender_id, sender_role, body) values ($1, $2, $3, $4)
     returning ${columns(side)}`, [memberId, sender.id, sender.role, body]);
  return rows[0];
}

/** The asking side has now seen everything the other side wrote. Returns how many were new to them. */
async function markRead(memberId, side) {
  const { rowCount } = await db.query(
    `update chat_messages set read_at = now()
     where member_id = $1 and read_at is null and ${side === 'member' ? "sender_role <> 'member'" : "sender_role = 'member'"}`,
    [memberId]);
  return rowCount;
}

/** When the other side last read one of the asker's messages (so open screens can show "seen"). */
async function lastSeen(memberId, side) {
  const { rows } = await db.query(
    `select max(read_at) as at from chat_messages
     where member_id = $1 and ${side === 'member' ? "sender_role = 'member'" : "sender_role <> 'member'"}`, [memberId]);
  return rows[0]?.at ?? null;
}

/** For a dietitian's client list: unread messages from each of their clients (the admin: every client). */
async function unreadByClient(dietitianId) {
  const { rows } = await db.query(
    `select c.member_id as "memberId", count(*)::int as unread, max(c.created_at) as "lastAt"
     from chat_messages c
     where c.sender_role = 'member' and c.read_at is null
       and ($1::text is null or exists (select 1 from client_assignments a
            where a.member_id = c.member_id and a.dietitian_id = $1 and a.accepted_at is not null))
     group by c.member_id`, [dietitianId]);
  return rows;
}

/** How many messages this person sent in the last minute (a simple brake on flooding). */
async function sentLastMinute(senderId) {
  const { rows } = await db.query(
    `select count(*)::int as n from chat_messages where sender_id = $1 and created_at > now() - interval '1 minute'`, [senderId]);
  return rows[0].n;
}

module.exports = { list, add, markRead, lastSeen, unreadByClient, sentLastMinute };
