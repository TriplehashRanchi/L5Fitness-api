-- 006: member profile (asked after login), weight history, dietitian role, diet plans.

-- Everyone who has used the app. The sign-in itself lives in Firebase; this keeps the name, email
-- and role we need to list clients for a dietitian. role: 'member' (default) or 'dietitian'.
create table members (
  user_id      text primary key,
  name         text not null default '',
  email        text not null default '',
  image        text,
  role         text not null default 'member' check (role in ('member', 'dietitian')),
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index members_email_idx on members (lower(email));

-- What a dietitian needs to build a plan. Filled in the setup screen right after the first login.
create table body_profiles (
  user_id             text primary key,
  goal                text not null check (goal in ('lose', 'maintain', 'gain')),
  sex                 text not null check (sex in ('female', 'male', 'other')),
  birth_date          date not null,
  height_cm           numeric(4,1) not null check (height_cm between 100 and 250),
  weight_kg           numeric(4,1) not null check (weight_kg between 25 and 300),   -- latest weight
  target_weight_kg    numeric(4,1) not null check (target_weight_kg between 25 and 300),
  start_weight_kg     numeric(4,1) not null check (start_weight_kg between 25 and 300), -- when they began
  activity_level      text not null check (activity_level in ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  diet_type           text not null check (diet_type in ('vegetarian', 'non_vegetarian', 'eggetarian', 'vegan')),
  allergies           text check (char_length(allergies) <= 300),
  medical_notes       text check (char_length(medical_notes) <= 500),
  share_with_dietitian boolean not null default true,   -- the member's consent
  completed_at        timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create table weight_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null,
  weight_kg  numeric(4,1) not null check (weight_kg between 25 and 300),
  local_day  date not null,
  created_at timestamptz not null default now()
);
create index weight_logs_user_idx on weight_logs (user_id, local_day desc, created_at desc);

-- One line of a member's diet plan for one day, written by a dietitian.
create table diet_items (
  id         uuid primary key default gen_random_uuid(),
  member_id  text not null,
  plan_day   date not null,
  meal_slot  text not null check (meal_slot in ('breakfast', 'lunch', 'snack', 'dinner', 'supplement')),
  title      text not null check (char_length(title) between 1 and 100),
  details    text check (char_length(details) <= 300),
  calories   int check (calories between 0 and 3000),
  sort_order int not null default 0,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index diet_items_member_day_idx on diet_items (member_id, plan_day);

-- A tick: the member did this item. Removing the row un-ticks it.
create table diet_completions (
  item_id      uuid primary key references diet_items (id) on delete cascade,
  member_id    text not null,
  completed_at timestamptz not null default now()
);
create index diet_completions_member_idx on diet_completions (member_id, completed_at);
