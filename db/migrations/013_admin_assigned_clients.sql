-- 013: clients are assigned by the admin and are active at once (no separate acceptance step).
update client_assignments set accepted_at = coalesce(accepted_at, assigned_at) where accepted_at is null;
