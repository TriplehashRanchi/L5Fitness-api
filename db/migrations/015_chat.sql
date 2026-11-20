-- 015: chat between a member and their dietitian. One thread per member: it belongs to the member and
-- is answered by whoever is their dietitian at the time (or the admin).

create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  member_id   text not null references members (user_id) on delete cascade,  -- whose thread this is
  sender_id   text not null,
  sender_role text not null check (sender_role in ('member', 'dietitian', 'admin')),
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now(),
  read_at     timestamptz   -- when the other side first saw it
);
create index chat_messages_thread_idx on chat_messages (member_id, created_at desc);
create index chat_messages_unread_idx on chat_messages (member_id, sender_role) where read_at is null;

-- A member's message alerts their dietitian, so a member can now be the sender of a notification.
alter table notifications drop constraint notifications_sender_role_check;
alter table notifications add constraint notifications_sender_role_check
  check (sender_role in ('admin', 'dietitian', 'member'));
