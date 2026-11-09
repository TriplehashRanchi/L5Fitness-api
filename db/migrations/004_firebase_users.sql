-- 004: members are now identified by their Firebase user ID (28 letters and digits), not by a
-- Neon Auth UUID. Existing columns keep their data; the type is just widened to text.
alter table uploads        alter column user_id type text using user_id::text;
alter table profiles       alter column user_id type text using user_id::text;
alter table workout_logs   alter column user_id type text using user_id::text;
alter table class_bookings alter column user_id type text using user_id::text;

-- The browser-based Google handoff from the Neon Auth login is no longer used.
drop table if exists oauth_handoffs;
