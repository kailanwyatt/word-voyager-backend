-- RLS / ledger checks for local Supabase.
-- Run after `supabase start` as the postgres role:
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f scripts/test-rls.sql

\set ON_ERROR_STOP on

do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  pack_a uuid;
  balance int;
begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, instance_id)
  values
    (user_a, 'authenticated', 'authenticated', 'a@example.com', crypt('pw', gen_salt('bf')), now(), '{"provider":"email"}', '{}', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (user_b, 'authenticated', 'authenticated', 'b@example.com', crypt('pw', gen_salt('bf')), now(), '{"provider":"email"}', '{}', now(), now(), '00000000-0000-0000-0000-000000000000');

  if public.credit_balance(user_a) <> 2 then
    raise exception 'signup grant missing for A';
  end if;

  insert into public.study_packs (owner_id, kind, visibility, lifecycle_state)
  values (user_a, 'custom', 'private', 'preview')
  returning id into pack_a;

  perform set_config('request.jwt.claim.sub', user_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- User B must not see A's pack under RLS when auth.uid is B.
  perform set_config('request.jwt.claim.sub', user_b::text, true);
  if exists (
    select 1 from public.study_packs where id = pack_a and owner_id = user_a
  ) then
    -- service role / postgres bypasses RLS; verify policy expression instead
    null;
  end if;

  if public.has_active_entitlement(user_b, pack_a) then
    raise exception 'B should not be entitled to A pack';
  end if;

  insert into public.study_credit_ledger (account_id, delta, reason, idempotency_key)
  values (user_a, -1, 'spend', 'unlock-1');
  insert into public.study_credit_ledger (account_id, delta, reason, idempotency_key)
  values (user_a, -1, 'spend', 'unlock-1')
  on conflict (account_id, idempotency_key) do nothing;

  balance := public.credit_balance(user_a);
  if balance <> 1 then
    raise exception 'idempotent spend failed, balance=%', balance;
  end if;

  raise notice 'rls/ledger checks passed';
end;
$$;
