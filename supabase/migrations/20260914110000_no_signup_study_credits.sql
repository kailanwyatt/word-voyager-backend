-- Promo Study credits are no longer granted on signup. New profiles start at
-- 0; credits come from purchases or service-role promo/admin grants.
-- Existing signup_grant_v1 ledger rows are left in place.

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

  return new;
end;
$$;
