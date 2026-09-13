-- Cheap Create Pack sample-word cache + per-account AI quota.
-- Service role only (no user policies); clients go through study-api.

create table public.study_preview_samples (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  topic_hash text not null,
  samples jsonb not null,
  billed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (owner_id, topic_hash)
);

create index study_preview_samples_owner_billed_idx
  on public.study_preview_samples (owner_id, billed_at desc);

alter table public.study_preview_samples enable row level security;
