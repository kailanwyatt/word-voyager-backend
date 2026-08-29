-- Study backend foundation: profiles, jobs, packs, credits, entitlements, RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  locale text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Inputs
-- ---------------------------------------------------------------------------
create table public.study_inputs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('topic', 'pasted_notes')),
  normalized_topic_hash text,
  topic_text text,
  notes_text text,
  language text not null default 'en',
  level text,
  learning_goal text,
  retention_expires_at timestamptz,
  moderation_state text not null default 'pending'
    check (moderation_state in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index study_inputs_owner_idx on public.study_inputs (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Packs (declared before jobs so jobs can FK pack_id)
-- ---------------------------------------------------------------------------
create table public.study_packs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references public.profiles (id) on delete set null,
  kind text not null default 'custom' check (kind in ('custom', 'published')),
  visibility text not null default 'private'
    check (visibility in ('private', 'unlisted', 'public')),
  current_version_id uuid,
  title text,
  input_kind text check (input_kind in ('topic', 'pasted_notes')),
  lifecycle_state text not null default 'generating'
    check (lifecycle_state in ('generating', 'preview', 'unlocked', 'failed', 'archived')),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.study_pack_versions (
  id uuid primary key default gen_random_uuid(),
  pack_id uuid not null references public.study_packs (id) on delete cascade,
  version int not null default 1,
  schema_version int not null default 1,
  recipe_version text not null,
  validator_version text not null,
  puzzle_engine_version text not null,
  language text not null default 'en',
  title text not null,
  description text,
  level text,
  learning_goal text,
  content_hash text not null,
  review_state text not null default 'generated'
    check (review_state in ('generated', 'approved', 'rejected')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (pack_id, version)
);

alter table public.study_packs
  add constraint study_packs_current_version_fk
  foreign key (current_version_id) references public.study_pack_versions (id);

create table public.study_terms (
  id uuid primary key default gen_random_uuid(),
  pack_version_id uuid not null references public.study_pack_versions (id) on delete cascade,
  stable_key text not null,
  display_term text not null,
  normalized_answer text not null,
  definition text not null,
  explanation text,
  fact text,
  category_id text,
  difficulty int not null check (difficulty between 1 and 5),
  confidence numeric,
  validation_state text not null default 'accepted'
    check (validation_state in ('accepted', 'rejected')),
  sort_order int not null default 0
);

create table public.study_sources (
  id uuid primary key default gen_random_uuid(),
  pack_version_id uuid not null references public.study_pack_versions (id) on delete cascade,
  type text not null check (type in ('user_material', 'retrieved', 'editorial')),
  title text not null,
  publisher text,
  canonical_url text,
  locator text,
  accessed_at timestamptz,
  validation_state text not null default 'unverified'
    check (validation_state in ('verified', 'unverified', 'unavailable')),
  content_fingerprint text
);

create table public.study_lessons (
  id uuid primary key default gen_random_uuid(),
  pack_version_id uuid not null references public.study_pack_versions (id) on delete cascade,
  title text not null,
  category_id text,
  ordinal int not null,
  is_preview boolean not null default false,
  supported_modes text[] not null default array['discover', 'recall', 'review']::text[],
  difficulty_band int
);

create table public.study_lesson_terms (
  lesson_id uuid not null references public.study_lessons (id) on delete cascade,
  term_id uuid not null references public.study_terms (id) on delete cascade,
  ordinal int not null default 0,
  role text not null default 'primary'
    check (role in ('primary', 'reinforcement', 'due')),
  primary key (lesson_id, term_id)
);

create table public.study_puzzles (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.study_lessons (id) on delete cascade,
  mode text not null default 'discover',
  puzzle_version int not null default 1,
  letters jsonb not null,
  answers jsonb not null,
  layout jsonb not null,
  quality_score int,
  generator_seed int,
  validation_hash text,
  unique (lesson_id, mode, puzzle_version)
);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  input_id uuid not null references public.study_inputs (id) on delete restrict,
  pack_id uuid references public.study_packs (id) on delete set null,
  recipe_version text not null default 'study-ai-1',
  status text not null default 'queued' check (status in (
    'queued',
    'analyzing',
    'retrieving',
    'validating',
    'building_preview',
    'preview_ready',
    'complete',
    'retryable_failure',
    'terminal_failure',
    'cancelled'
  )),
  attempt_count int not null default 0,
  idempotency_key text not null,
  lease_owner text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz,
  safe_error_code text,
  cost_bucket text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)
);

create index generation_jobs_claim_idx
  on public.generation_jobs (status, next_attempt_at, created_at);

create table public.generation_job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.generation_jobs (id) on delete cascade,
  sequence int not null,
  state text not null,
  safe_detail text,
  created_at timestamptz not null default now(),
  unique (job_id, sequence)
);

-- ---------------------------------------------------------------------------
-- Credits + entitlements
-- ---------------------------------------------------------------------------
create table public.study_credit_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.profiles (id) on delete cascade,
  delta int not null check (delta <> 0),
  reason text not null check (reason in (
    'purchase', 'spend', 'refund', 'promo', 'admin', 'expiry'
  )),
  reference_type text,
  reference_id uuid,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (account_id, idempotency_key)
);

create table public.entitlements (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.profiles (id) on delete cascade,
  pack_id uuid not null references public.study_packs (id) on delete cascade,
  pack_version_floor int,
  access_level text not null default 'full' check (access_level = 'full'),
  source_type text not null check (source_type in (
    'direct_purchase',
    'study_credit',
    'free',
    'achievement',
    'event',
    'promo',
    'creator_paid_shared',
    'admin'
  )),
  source_id text not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb,
  unique (account_id, pack_id, source_type, source_id)
);

create index entitlements_account_idx on public.entitlements (account_id)
  where revoked_at is null;

create table public.entitlement_events (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.entitlements (id) on delete cascade,
  event_type text not null check (event_type in ('grant', 'revoke', 'restore', 'expire')),
  reason text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values
  ('study-private-inputs', 'study-private-inputs', false, 10485760),
  ('study-pack-manifests', 'study-pack-manifests', false, 20971520)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger generation_jobs_touch
  before update on public.generation_jobs
  for each row execute function public.touch_updated_at();

create or replace function public.credit_balance(p_account uuid)
returns int
language sql
stable
as $$
  select coalesce(sum(delta), 0)::int
  from public.study_credit_ledger
  where account_id = p_account;
$$;

create or replace function public.has_active_entitlement(p_account uuid, p_pack uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.entitlements e
    where e.account_id = p_account
      and e.pack_id = p_pack
      and e.revoked_at is null
      and (e.expires_at is null or e.expires_at > now())
  );
$$;

-- New user: profile + 2 promo credits (local/default grant).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;

  insert into public.study_credit_ledger (account_id, delta, reason, idempotency_key)
  values (new.id, 2, 'promo', 'signup_grant_v1')
  on conflict (account_id, idempotency_key) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Claim the next job with SKIP LOCKED.
create or replace function public.claim_generation_job(p_worker_id text)
returns public.generation_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.generation_jobs;
begin
  select *
  into claimed
  from public.generation_jobs
  where status in ('queued', 'retryable_failure')
    and (lease_expires_at is null or lease_expires_at < now())
    and (next_attempt_at is null or next_attempt_at <= now())
  order by created_at
  for update skip locked
  limit 1;

  if claimed.id is null then
    return null;
  end if;

  update public.generation_jobs
  set
    lease_owner = p_worker_id,
    lease_expires_at = now() + interval '3 minutes',
    status = 'analyzing',
    started_at = coalesce(started_at, now()),
    attempt_count = attempt_count + 1,
    updated_at = now()
  where id = claimed.id
  returning * into claimed;

  insert into public.generation_job_events (job_id, sequence, state, safe_detail)
  values (
    claimed.id,
    claimed.attempt_count,
    'analyzing',
    'lease claimed'
  );

  return claimed;
end;
$$;

-- Transactional unlock: debit 1 credit and grant entitlement.
create or replace function public.unlock_pack_with_credit(
  p_pack_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  pack public.study_packs;
  existing public.entitlements;
  balance int;
  new_ent public.entitlements;
begin
  if uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;

  if p_idempotency_key is null or length(p_idempotency_key) < 8 then
    raise exception 'idempotency_required' using errcode = 'P0001';
  end if;

  select * into pack from public.study_packs where id = p_pack_id for update;
  if pack.id is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if pack.owner_id is distinct from uid then
    raise exception 'not_entitled' using errcode = 'P0001';
  end if;
  if pack.lifecycle_state not in ('preview', 'unlocked') then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;

  select * into existing
  from public.entitlements
  where account_id = uid
    and pack_id = p_pack_id
    and revoked_at is null
  for update;

  if existing.id is not null then
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'entitlementId', existing.id,
      'creditBalance', public.credit_balance(uid)
    );
  end if;

  -- Idempotent replay of the same spend key.
  if exists (
    select 1 from public.study_credit_ledger
    where account_id = uid and idempotency_key = p_idempotency_key
  ) then
    select * into existing
    from public.entitlements
    where account_id = uid and pack_id = p_pack_id
    order by granted_at desc
    limit 1;
    return jsonb_build_object(
      'ok', true,
      'already', true,
      'entitlementId', existing.id,
      'creditBalance', public.credit_balance(uid)
    );
  end if;

  balance := public.credit_balance(uid);
  if balance < 1 then
    raise exception 'insufficient_credits' using errcode = 'P0001';
  end if;

  insert into public.study_credit_ledger (
    account_id, delta, reason, reference_type, reference_id, idempotency_key
  ) values (
    uid, -1, 'spend', 'pack', p_pack_id, p_idempotency_key
  );

  insert into public.entitlements (
    account_id, pack_id, access_level, source_type, source_id
  ) values (
    uid, p_pack_id, 'full', 'study_credit', p_idempotency_key
  )
  returning * into new_ent;

  insert into public.entitlement_events (entitlement_id, event_type, reason)
  values (new_ent.id, 'grant', 'study_credit');

  update public.study_packs
  set lifecycle_state = 'unlocked'
  where id = p_pack_id;

  update public.generation_jobs
  set status = 'complete', finished_at = now()
  where pack_id = p_pack_id
    and status = 'preview_ready';

  return jsonb_build_object(
    'ok', true,
    'already', false,
    'entitlementId', new_ent.id,
    'creditBalance', public.credit_balance(uid)
  );
end;
$$;

revoke all on function public.unlock_pack_with_credit(uuid, text) from public;
grant execute on function public.unlock_pack_with_credit(uuid, text) to authenticated, anon;

revoke all on function public.claim_generation_job(text) from public, anon, authenticated;
grant execute on function public.claim_generation_job(text) to service_role;

-- Dev-only credit grant (gated in Edge Function; still restricted to caller).
create or replace function public.dev_grant_study_credit(p_amount int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  key text;
begin
  if uid is null then
    raise exception 'auth_required' using errcode = 'P0001';
  end if;
  if p_amount is null or p_amount < 1 or p_amount > 5 then
    raise exception 'validation_failed' using errcode = 'P0001';
  end if;
  key := 'dev_grant_' || replace(gen_random_uuid()::text, '-', '');
  insert into public.study_credit_ledger (account_id, delta, reason, idempotency_key)
  values (uid, p_amount, 'admin', key);
  return public.credit_balance(uid);
end;
$$;

grant execute on function public.dev_grant_study_credit(int) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.study_inputs enable row level security;
alter table public.study_packs enable row level security;
alter table public.study_pack_versions enable row level security;
alter table public.study_terms enable row level security;
alter table public.study_sources enable row level security;
alter table public.study_lessons enable row level security;
alter table public.study_lesson_terms enable row level security;
alter table public.study_puzzles enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.generation_job_events enable row level security;
alter table public.study_credit_ledger enable row level security;
alter table public.entitlements enable row level security;
alter table public.entitlement_events enable row level security;

create policy profiles_self on public.profiles
  for select using (id = auth.uid());
create policy profiles_self_update on public.profiles
  for update using (id = auth.uid());

create policy inputs_owner on public.study_inputs
  for all using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy packs_owner on public.study_packs
  for select using (
    owner_id = auth.uid()
    or public.has_active_entitlement(auth.uid(), id)
  );

create policy versions_owner on public.study_pack_versions
  for select using (
    exists (
      select 1 from public.study_packs p
      where p.id = pack_id
        and (p.owner_id = auth.uid() or public.has_active_entitlement(auth.uid(), p.id))
    )
  );

create policy terms_via_pack on public.study_terms
  for select using (
    exists (
      select 1
      from public.study_pack_versions v
      join public.study_packs p on p.id = v.pack_id
      where v.id = pack_version_id
        and (p.owner_id = auth.uid() or public.has_active_entitlement(auth.uid(), p.id))
    )
  );

create policy sources_via_pack on public.study_sources
  for select using (
    exists (
      select 1
      from public.study_pack_versions v
      join public.study_packs p on p.id = v.pack_id
      where v.id = pack_version_id
        and (p.owner_id = auth.uid() or public.has_active_entitlement(auth.uid(), p.id))
    )
  );

create policy lessons_via_pack on public.study_lessons
  for select using (
    exists (
      select 1
      from public.study_pack_versions v
      join public.study_packs p on p.id = v.pack_id
      where v.id = pack_version_id
        and (p.owner_id = auth.uid() or public.has_active_entitlement(auth.uid(), p.id))
    )
  );

create policy lesson_terms_via_pack on public.study_lesson_terms
  for select using (
    exists (
      select 1
      from public.study_lessons l
      join public.study_pack_versions v on v.id = l.pack_version_id
      join public.study_packs p on p.id = v.pack_id
      where l.id = lesson_id
        and (p.owner_id = auth.uid() or public.has_active_entitlement(auth.uid(), p.id))
    )
  );

create policy puzzles_via_pack on public.study_puzzles
  for select using (
    exists (
      select 1
      from public.study_lessons l
      join public.study_pack_versions v on v.id = l.pack_version_id
      join public.study_packs p on p.id = v.pack_id
      where l.id = lesson_id
        and (p.owner_id = auth.uid() or public.has_active_entitlement(auth.uid(), p.id))
    )
  );

create policy jobs_owner on public.generation_jobs
  for select using (owner_id = auth.uid());

create policy job_events_owner on public.generation_job_events
  for select using (
    exists (
      select 1 from public.generation_jobs j
      where j.id = job_id and j.owner_id = auth.uid()
    )
  );

create policy ledger_self on public.study_credit_ledger
  for select using (account_id = auth.uid());

create policy entitlements_self on public.entitlements
  for select using (account_id = auth.uid());

create policy entitlement_events_self on public.entitlement_events
  for select using (
    exists (
      select 1 from public.entitlements e
      where e.id = entitlement_id and e.account_id = auth.uid()
    )
  );

create policy storage_manifests_owner on storage.objects
  for select using (
    bucket_id = 'study-pack-manifests'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy storage_inputs_owner on storage.objects
  for select using (
    bucket_id = 'study-private-inputs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
