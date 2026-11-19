-- 014: remember deleted accounts so a still-valid sign-in token cannot recreate them (tokens live up to 1 hour).
create table deleted_accounts (
  user_id    text primary key,
  deleted_at timestamptz not null default now()
);
