-- 007: admin and dietitian roles for the web console, invitations, and client assignment.

-- members.role now also allows 'admin'. A partial unique index means there can only ever be ONE admin.
alter table members drop constraint members_role_check;
alter table members add constraint members_role_check check (role in ('member', 'dietitian', 'admin'));
create unique index members_single_admin on members (role) where role = 'admin';

-- Whether the sign-in provider says this email is verified (Google emails are). Invitations and the
-- admin address only apply to VERIFIED emails, so nobody can claim an address they do not own.
alter table members add column email_verified boolean not null default false;
-- A disabled dietitian keeps their record but cannot use the console.
alter table members add column disabled boolean not null default false;

-- The admin invites a dietitian by email. It is used up the first time that person signs in with
-- that (verified) email.
create table dietitian_invites (
  email      text primary key check (email = lower(email)),
  invited_by text not null,
  created_at timestamptz not null default now()
);

-- Which dietitian looks after which member (at most one each).
create table client_assignments (
  member_id    text primary key,
  dietitian_id text not null,
  assigned_by  text not null,
  assigned_at  timestamptz not null default now()
);
create index client_assignments_dietitian_idx on client_assignments (dietitian_id);
