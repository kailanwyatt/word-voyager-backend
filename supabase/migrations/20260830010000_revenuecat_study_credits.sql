create table public.revenuecat_webhook_events (
  event_id text primary key,
  api_version text not null,
  event_type text not null,
  app_id text,
  product_id text,
  app_user_id text,
  original_app_user_id text,
  aliases text[] not null default '{}',
  account_id uuid references public.profiles (id) on delete set null,
  transaction_id text,
  original_transaction_id text,
  store text,
  environment text,
  purchased_at timestamptz,
  event_timestamp timestamptz not null,
  currency text,
  price numeric,
  status text not null check (status in ('granted', 'ignored', 'identity_not_found', 'identity_ambiguous')),
  status_detail text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz not null default now()
);

create index revenuecat_transaction_idx on public.revenuecat_webhook_events (transaction_id)
  where transaction_id is not null;
create index revenuecat_account_idx on public.revenuecat_webhook_events (account_id, received_at desc)
  where account_id is not null;

alter table public.revenuecat_webhook_events enable row level security;

create or replace function public.ingest_revenuecat_study_purchase(
  p_event_id text, p_api_version text, p_event_type text, p_app_id text,
  p_product_id text, p_app_user_id text, p_original_app_user_id text,
  p_aliases text[], p_transaction_id text, p_original_transaction_id text,
  p_store text, p_environment text, p_purchased_at_ms bigint,
  p_event_timestamp_ms bigint, p_currency text, p_price numeric, p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate_ids text[];
  resolved_accounts uuid[];
  resolved_account uuid;
  result_status text;
  result_detail text;
  inserted_event_id text;
begin
  if p_event_id is null or length(p_event_id) = 0 or p_event_timestamp_ms is null then
    raise exception 'invalid_event' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct value), '{}') into candidate_ids
  from unnest(array_remove(array_cat(
    array[p_app_user_id, p_original_app_user_id], coalesce(p_aliases, '{}')
  ), null)) value;

  select coalesce(array_agg(p.id), '{}') into resolved_accounts
  from public.profiles p where p.id::text = any(candidate_ids);

  if p_app_id is distinct from 'appd45aad0dae' then
    result_status := 'ignored'; result_detail := 'unexpected_app';
  elsif p_event_type is distinct from 'NON_RENEWING_PURCHASE' then
    result_status := 'ignored'; result_detail := 'unsupported_event_type';
  elsif p_product_id is distinct from 'wordvoyager.study_pack_1' then
    result_status := 'ignored'; result_detail := 'unsupported_product';
  elsif cardinality(resolved_accounts) = 0 then
    result_status := 'identity_not_found';
    result_detail := 'no_profile_matches_revenuecat_identity';
  elsif cardinality(resolved_accounts) > 1 then
    result_status := 'identity_ambiguous';
    result_detail := 'multiple_profiles_match_revenuecat_identity';
  else
    resolved_account := resolved_accounts[1];
    result_status := 'granted'; result_detail := 'one_study_credit';
  end if;

  insert into public.revenuecat_webhook_events (
    event_id, api_version, event_type, app_id, product_id, app_user_id,
    original_app_user_id, aliases, account_id, transaction_id,
    original_transaction_id, store, environment, purchased_at,
    event_timestamp, currency, price, status, status_detail, payload
  ) values (
    p_event_id, p_api_version, p_event_type, p_app_id, p_product_id,
    p_app_user_id, p_original_app_user_id, coalesce(p_aliases, '{}'),
    resolved_account, p_transaction_id, p_original_transaction_id, p_store,
    p_environment,
    case when p_purchased_at_ms is null then null else to_timestamp(p_purchased_at_ms / 1000.0) end,
    to_timestamp(p_event_timestamp_ms / 1000.0), p_currency, p_price,
    result_status, result_detail, p_payload
  ) on conflict (event_id) do nothing returning event_id into inserted_event_id;

  if inserted_event_id is null then
    select status, account_id into result_status, resolved_account
    from public.revenuecat_webhook_events where event_id = p_event_id;
    return jsonb_build_object('ok', true, 'duplicate', true,
      'status', result_status, 'accountId', resolved_account);
  end if;

  if result_status = 'granted' then
    insert into public.study_credit_ledger (
      account_id, delta, reason, reference_type, idempotency_key
    ) values (
      resolved_account, 1, 'purchase', 'revenuecat_event',
      'revenuecat:' || p_event_id
    );
  end if;

  return jsonb_build_object('ok', true, 'duplicate', false,
    'status', result_status, 'accountId', resolved_account);
end;
$$;

revoke all on table public.revenuecat_webhook_events from public, anon, authenticated;
grant all on table public.revenuecat_webhook_events to service_role;
revoke all on function public.ingest_revenuecat_study_purchase(
  text, text, text, text, text, text, text, text[], text, text, text, text,
  bigint, bigint, text, numeric, jsonb
) from public, anon, authenticated;
grant execute on function public.ingest_revenuecat_study_purchase(
  text, text, text, text, text, text, text, text[], text, text, text, text,
  bigint, bigint, text, numeric, jsonb
) to service_role;

create or replace function public.grant_study_credits_server(
  p_account_id uuid, p_amount int, p_reason text, p_idempotency_key text
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_amount is null or p_amount < 1 or p_amount > 100 then
    raise exception 'validation_failed' using errcode = 'P0001';
  end if;
  if p_reason not in ('promo', 'admin') then
    raise exception 'invalid_grant_reason' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'idempotency_required' using errcode = 'P0001';
  end if;
  insert into public.study_credit_ledger (
    account_id, delta, reason, reference_type, idempotency_key
  ) values (
    p_account_id, p_amount, p_reason, 'server_grant', p_idempotency_key
  ) on conflict (account_id, idempotency_key) do nothing;
  return public.credit_balance(p_account_id);
end;
$$;

revoke all on function public.grant_study_credits_server(uuid, int, text, text)
  from public, anon, authenticated;
grant execute on function public.grant_study_credits_server(uuid, int, text, text)
  to service_role;

-- The direct development RPC was previously client-callable.
revoke all on function public.dev_grant_study_credit(int)
  from public, anon, authenticated;
grant execute on function public.dev_grant_study_credit(int) to service_role;
