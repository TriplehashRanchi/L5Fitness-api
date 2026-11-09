-- 005: settings, water intake and meal photos.

-- Daily goals a member can change in Settings. weekly_goal already exists.
alter table profiles add column step_goal     int not null default 10000 check (step_goal     between 1000 and 100000);
alter table profiles add column water_goal_ml int not null default 2500  check (water_goal_ml between 500  and 10000);

-- One row per drink the member logs ("+250 ml").
create table water_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  amount_ml  int  not null check (amount_ml between 1 and 2000),
  local_day  date not null,             -- the calendar day on the member's phone
  created_at timestamptz not null default now()
);
create index water_logs_user_day_idx on water_logs (user_id, local_day);

-- A meal, with an optional photo kept in the storage bucket (see the uploads table).
create table meals (
  id        uuid primary key default gen_random_uuid(),
  user_id   text not null,
  meal_type text not null check (meal_type in ('breakfast', 'lunch', 'dinner', 'snack')),
  note      text check (char_length(note) <= 200),
  upload_id uuid unique references uploads (id) on delete set null,
  local_day date not null,
  eaten_at  timestamptz not null,
  created_at timestamptz not null default now()
);
create index meals_user_day_idx on meals (user_id, local_day, eaten_at);
