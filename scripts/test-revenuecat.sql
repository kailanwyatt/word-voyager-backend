\set ON_ERROR_STOP on

begin;
do $$
declare
  user_a uuid := gen_random_uuid();
  user_b uuid := gen_random_uuid();
  result jsonb;
begin
  insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, instance_id)
  values
    (user_a, 'authenticated', 'authenticated', 'rc-a@example.com', crypt('pw', gen_salt('bf')),
      now(), '{"provider":"email"}', '{}', now(), now(), '00000000-0000-0000-0000-000000000000'),
    (user_b, 'authenticated', 'authenticated', 'rc-b@example.com', crypt('pw', gen_salt('bf')),
      now(), '{"provider":"email"}', '{}', now(), now(), '00000000-0000-0000-0000-000000000000');

  result := public.ingest_revenuecat_study_purchase(
    'rc-event-1', '1.0', 'NON_RENEWING_PURCHASE', 'appd45aad0dae',
    'wordvoyager.study_pack_1', 'anonymous', user_a::text, array['old-alias'],
    'transaction-1', 'transaction-1', 'APP_STORE', 'SANDBOX',
    1700000000000, 1700000001000, 'USD', 1.99, '{"event":{"id":"rc-event-1"}}'
  );
  if result->>'status' <> 'granted' or public.credit_balance(user_a) <> 1 then
    raise exception 'first verified purchase was not granted exactly once: %', result;
  end if;

  result := public.ingest_revenuecat_study_purchase(
    'rc-event-1', '1.0', 'NON_RENEWING_PURCHASE', 'appd45aad0dae',
    'wordvoyager.study_pack_1', user_a::text, user_a::text, '{}',
    'transaction-1', 'transaction-1', 'APP_STORE', 'SANDBOX',
    1700000000000, 1700000001000, 'USD', 1.99, '{"replayed":true}'
  );
  if result->>'duplicate' <> 'true' or public.credit_balance(user_a) <> 1 then
    raise exception 'replay duplicated credit: %', result;
  end if;

  result := public.ingest_revenuecat_study_purchase(
    'rc-event-wrong-product', '1.0', 'NON_RENEWING_PURCHASE', 'appd45aad0dae',
    'another.product', user_a::text, user_a::text, '{}', null, null,
    'APP_STORE', 'SANDBOX', null, 1700000002000, 'USD', 1.99, '{}'
  );
  if result->>'status' <> 'ignored' or public.credit_balance(user_a) <> 1 then
    raise exception 'wrong product granted credit: %', result;
  end if;

  result := public.ingest_revenuecat_study_purchase(
    'rc-event-ambiguous', '1.0', 'NON_RENEWING_PURCHASE', 'appd45aad0dae',
    'wordvoyager.study_pack_1', user_a::text, user_b::text, '{}', null, null,
    'APP_STORE', 'SANDBOX', null, 1700000003000, 'USD', 1.99, '{}'
  );
  if result->>'status' <> 'identity_ambiguous' or public.credit_balance(user_a) <> 1
    or public.credit_balance(user_b) <> 0 then
    raise exception 'ambiguous identity granted credit: %', result;
  end if;

  if exists (select 1 from public.entitlements where account_id = user_a) then
    raise exception 'consumable incorrectly created a permanent entitlement';
  end if;
  raise notice 'RevenueCat fulfillment checks passed';
end;
$$;
rollback;
