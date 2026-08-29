-- Reclaim jobs left mid-flight when a worker is SIGTERM'd / crashes.
-- Previously only queued|retryable_failure were claimable, so analyzing/
-- validating/building_preview rows stayed stuck forever after lease expiry.

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
  where (
      (
        status in ('queued', 'retryable_failure')
        and (lease_expires_at is null or lease_expires_at < now())
      )
      or (
        status in ('analyzing', 'retrieving', 'validating', 'building_preview')
        and lease_expires_at is not null
        and lease_expires_at < now()
      )
    )
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
    safe_error_code = null,
    finished_at = null,
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

revoke all on function public.claim_generation_job(text) from public, anon, authenticated;
grant execute on function public.claim_generation_job(text) to service_role;
