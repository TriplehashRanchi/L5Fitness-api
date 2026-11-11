-- 010: browser (web) push for dietitians using the console. Their token is a Firebase Cloud Messaging
-- token instead of an Expo token, so the platform list gains 'web'.
alter table push_tokens drop constraint push_tokens_platform_check;
alter table push_tokens add constraint push_tokens_platform_check check (platform in ('ios', 'android', 'web'));
