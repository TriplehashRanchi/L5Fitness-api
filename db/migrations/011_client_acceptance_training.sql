-- Acceptance is explicit, including for clients assigned before this release.
alter table client_assignments add column accepted_at timestamptz;

create table client_training_plans (
  id uuid primary key default gen_random_uuid(),
  member_id text not null references members(user_id) on delete cascade,
  plan_day date not null,
  title text not null check (char_length(title) between 1 and 80),
  duration_min int not null check (duration_min between 1 and 600),
  kcal_estimate int not null default 0 check (kcal_estimate between 0 and 5000),
  instructions text not null check (char_length(instructions) between 1 and 4000),
  created_by text not null,
  updated_at timestamptz not null default now(),
  unique (member_id, plan_day)
);
