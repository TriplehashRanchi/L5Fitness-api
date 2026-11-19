-- 012: dietitian-prescribed daily targets, and steps stored on the server.

-- Daily targets are PRESCRIBED by the client's dietitian. Null = the dietitian has not set one yet
-- (the member's own default from Settings is then shown, but is not binding).
create table client_targets (
  member_id    text primary key references members(user_id) on delete cascade,
  water_ml     int check (water_ml between 500 and 10000),
  steps        int check (steps between 1000 and 100000),
  calories     int check (calories between 800 and 6000),
  protein_g    int check (protein_g between 0 and 500),
  weekly_workouts int check (weekly_workouts between 1 and 7),
  updated_by   text not null,
  updated_at   timestamptz not null default now()
);

-- Steps per day, reported by the phone (Apple Health / Health Connect) so the coach can see them.
create table step_logs (
  user_id    text not null,
  local_day  date not null,
  steps      int not null check (steps between 0 and 200000),
  updated_at timestamptz not null default now(),
  primary key (user_id, local_day)
);

-- Indexes for the coach/admin compliance queries.
create index if not exists diet_items_day_idx on diet_items (plan_day);
create index if not exists client_assignments_accept_idx on client_assignments (dietitian_id, accepted_at);
create index if not exists workout_logs_day_idx on workout_logs (local_day);
