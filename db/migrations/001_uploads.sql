-- 001: files a member uploads (photos). Users and sessions are NOT here: Neon Auth owns them
-- in the `neon_auth` schema.

create table if not exists uploads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,                     -- neon_auth."user".id
  object_key   text not null unique,              -- where the file lives in the bucket
  content_type text not null,
  size_bytes   bigint not null check (size_bytes > 0),
  status       text not null default 'pending' check (status in ('pending', 'ready')),
  created_at   timestamptz not null default now()
);

create index if not exists uploads_user_created_idx on uploads (user_id, created_at desc);
