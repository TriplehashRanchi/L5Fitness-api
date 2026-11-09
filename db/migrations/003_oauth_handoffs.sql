-- 003: one row per "Continue with Google" attempt, kept for a few minutes.
--
-- Sign-in happens in the phone's browser, but the app needs the result. This row links the two:
--   id            travels through the browser (so it is NOT a secret)
--   pickup_hash   hash of a secret only the app that started the attempt knows; the app shows
--                 that secret to collect the session, so another app cannot take it
create table oauth_handoffs (
  id               uuid primary key,
  pickup_hash      text not null unique,
  provider         text not null,
  challenge_cookie text not null,          -- Neon Auth's challenge for this attempt
  app_redirect     text not null,          -- where to send the browser when done (back to the app)
  session_token    text,                   -- filled in when sign-in succeeded, deleted on pickup
  failed           boolean not null default false,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);

create index oauth_handoffs_expires_idx on oauth_handoffs (expires_at);
