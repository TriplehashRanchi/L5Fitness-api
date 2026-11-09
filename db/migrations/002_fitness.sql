-- 002: fitness tracking. Catalog (what the gym offers), tracking (what a member did), classes.
-- Every user_id below is neon_auth."user".id.

-- ── Catalog ────────────────────────────────────────────────────────────────────────────────

create table workout_categories (
  slug       text primary key,
  name       text not null,
  sort_order int  not null default 0
);

create table workouts (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  title          text not null,
  category_slug  text not null references workout_categories (slug),
  level          text not null check (level in ('beginner', 'intermediate', 'advanced', 'all')),
  duration_min   int  not null check (duration_min between 1 and 600),
  kcal_estimate  int  not null check (kcal_estimate >= 0),  -- for the full duration
  exercise_count int  check (exercise_count > 0),
  focus          text,                                       -- e.g. "Chest, Shoulders"
  coach          text,
  icon           text not null default 'dumbbell',           -- the app maps this key to an icon
  is_program     boolean not null default false,             -- shown under "Programs" on Home
  is_active      boolean not null default true,              -- false hides it without deleting history
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now()
);

create index workouts_category_idx on workouts (category_slug) where is_active;

-- The gym's default plan: one workout per weekday. 0 = Sunday … 6 = Saturday.
create table plan_days (
  weekday    smallint primary key check (weekday between 0 and 6),
  workout_id uuid not null references workouts (id)
);

-- ── Tracking ───────────────────────────────────────────────────────────────────────────────

create table profiles (
  user_id     uuid primary key,
  weekly_goal smallint not null default 5 check (weekly_goal between 1 and 7),  -- workouts per week
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table workout_logs (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null,
  workout_id     uuid references workouts (id) on delete set null,
  title          text not null,                -- copied, so history survives catalog changes
  started_at     timestamptz not null,
  duration_min   int not null check (duration_min between 1 and 600),
  calories       int not null check (calories >= 0),
  avg_heart_rate smallint check (avg_heart_rate between 30 and 230),  -- null: no heart-rate device
  -- The calendar day on the member's phone when they trained. Stored instead of worked out
  -- from started_at, so "today" and streaks stay right in any time zone.
  local_day      date not null,
  created_at     timestamptz not null default now()
);

create index workout_logs_user_day_idx on workout_logs (user_id, local_day);

-- ── Classes ────────────────────────────────────────────────────────────────────────────────

-- The weekly timetable. One row = one recurring class, in the gym's own time zone.
create table class_slots (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  trainer      text not null,
  icon         text not null default 'bolt',
  weekdays     smallint[] not null check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]),
  start_time   time not null,
  duration_min int  not null check (duration_min between 5 and 300),
  capacity     int  not null check (capacity > 0),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (name, start_time)
);

-- A member's place in one class on one date.
create table class_bookings (
  id         uuid primary key default gen_random_uuid(),
  slot_id    uuid not null references class_slots (id) on delete cascade,
  class_date date not null,
  user_id    uuid not null,
  created_at timestamptz not null default now(),
  unique (slot_id, class_date, user_id)        -- a member cannot book the same class twice
);

create index class_bookings_user_idx on class_bookings (user_id, class_date);
