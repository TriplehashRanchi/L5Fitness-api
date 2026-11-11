-- 009: push notifications. Phones register a token; the admin and dietitians send messages; every
-- message is also kept as an in-app inbox entry so nobody misses one (switched-off phone, denied
-- permission, expired token).

-- One row per phone (Expo push token). The token is unique: if another person signs in on the same
-- phone, the row simply moves to them.
create table push_tokens (
  token        text primary key,
  user_id      text not null references members (user_id) on delete cascade,
  platform     text not null check (platform in ('ios', 'android')),
  device_name  text,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index push_tokens_user_idx on push_tokens (user_id);

-- A member can mute pushes (the inbox still fills up).
alter table members add column push_enabled boolean not null default true;

-- One row per message that was sent from the console.
create table notifications (
  id              uuid primary key default gen_random_uuid(),
  sender_id       text not null,           -- the admin ('local-admin') or a dietitian's user id
  sender_role     text not null check (sender_role in ('admin', 'dietitian')),
  sender_name     text not null,
  audience        text not null check (audience in ('everyone', 'all_members', 'all_dietitians', 'my_clients', 'user')),
  title           text not null check (char_length(title) between 1 and 60),
  body            text not null check (char_length(body) between 1 and 240),
  screen          text not null default 'inbox' check (screen in ('inbox', 'home', 'diet', 'logs')),
  recipient_count int  not null default 0,
  push_sent       int  not null default 0, -- accepted by the push service
  push_failed     int  not null default 0,
  created_at      timestamptz not null default now()
);
create index notifications_sender_idx on notifications (sender_id, created_at desc);

-- Who got it, and whether they have read it: this is each member's inbox.
create table notification_recipients (
  notification_id uuid not null references notifications (id) on delete cascade,
  user_id         text not null references members (user_id) on delete cascade,
  read_at         timestamptz,
  primary key (notification_id, user_id)
);
create index notification_recipients_user_idx on notification_recipients (user_id, notification_id);
