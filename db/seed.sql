-- Starter content, taken from the sample data the app showed before it had a backend.
-- Safe to run again: existing rows are left untouched, so edits made later are never overwritten.
-- Replace with the gym's real workouts, plan and timetable.

insert into workout_categories (slug, name, sort_order) values
  ('strength', 'Strength', 1),
  ('cardio',   'Cardio',   2),
  ('hiit',     'HIIT',     3),
  ('yoga',     'Yoga',     4),
  ('crossfit', 'CrossFit', 5),
  ('boxing',   'Boxing',   6)
on conflict (slug) do nothing;

insert into workouts
  (slug, title, category_slug, level, duration_min, kcal_estimate, exercise_count, focus, coach, icon, is_program, sort_order)
values
  ('chest-triceps-day', 'Chest & Triceps Day', 'strength', 'intermediate', 52, 480, 8,    'Chest, Triceps',       null,          'dumbbell',   false, 1),
  ('full-body-burn',    'Full Body Burn',      'strength', 'intermediate', 45, 420, null, 'Full body',            'Coach Arjun', 'strength',   true,  2),
  ('morning-cardio',    'Morning Cardio',      'cardio',   'beginner',     30, 280, null, 'Endurance',            'Coach Priya', 'run',        true,  3),
  ('power-yoga',        'Power Yoga',          'yoga',     'all',          40, 220, null, 'Flexibility, Core',    'Coach Neha',  'yoga',       true,  4),
  ('push-day-power',    'Push Day Power',      'strength', 'intermediate', 45, 400, null, 'Chest, Shoulders',     null,          'dumbbell',   false, 5),
  ('leg-day-destroyer', 'Leg Day Destroyer',   'strength', 'advanced',     50, 520, null, 'Quads, Glutes',        null,          'functional', false, 6),
  ('20-min-fat-burn',   '20 Min Fat Burn',     'hiit',     'beginner',     20, 260, null, 'Full body HIIT',       null,          'flame',      false, 7),
  ('core-crusher',      'Core Crusher',        'strength', 'all',          15, 120, null, 'Abs, Obliques',        null,          'core',       false, 8),
  ('morning-mobility',  'Morning Mobility',    'yoga',     'beginner',     25, 90,  null, 'Stretch, Recovery',    null,          'mobility',   false, 9)
on conflict (slug) do nothing;

-- Weekly plan. 0 = Sunday … 6 = Saturday.
insert into plan_days (weekday, workout_id)
select d.weekday, w.id
from (values
  (0, 'morning-mobility'),
  (1, 'chest-triceps-day'),
  (2, 'leg-day-destroyer'),
  (3, '20-min-fat-burn'),
  (4, 'push-day-power'),
  (5, 'full-body-burn'),
  (6, 'power-yoga')
) as d (weekday, slug)
join workouts w on w.slug = d.slug
on conflict (weekday) do nothing;

-- Class timetable, every day, in the gym's time zone.
insert into class_slots (name, trainer, icon, weekdays, start_time, duration_min, capacity) values
  ('HIIT Blast',    'Rahul S.',  'bolt',     '{0,1,2,3,4,5,6}', '06:30', 45, 20),
  ('Strength Lab',  'Arjun K.',  'dumbbell', '{0,1,2,3,4,5,6}', '08:00', 60, 12),
  ('Boxing Basics', 'Vikram R.', 'boxing',   '{0,1,2,3,4,5,6}', '18:30', 50, 16)
on conflict (name, start_time) do nothing;
