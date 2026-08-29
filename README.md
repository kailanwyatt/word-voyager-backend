# Word Voyage Study backend (local Supabase, then remote)

Local-first backend for AI Study Packs. Same Postgres schema, RLS, Auth, Storage, Edge Functions, and Node worker you will later point at a hosted Supabase project. No WordPress.

## Prerequisites

- Docker Desktop running
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) (`brew install supabase/tap/supabase` or `npx supabase`)
- Node 20+
- An OpenAI API key for the worker (never put this in the Expo app)

## Local default URLs and keys

These are the published local demo keys used by `supabase start`:

| Service | URL |
| --- | --- |
| API | http://127.0.0.1:54321 |
| Studio | http://127.0.0.1:54323 |
| DB | postgresql://postgres:postgres@127.0.0.1:54322/postgres |
| Inbucket (email) | http://127.0.0.1:54324 |

Anon key:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
```

Service role (worker only, never Expo):

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
```

## Start the stack

```bash
cd /Users/kurt/Documents/mobile-apps/word-voyage-backend
npm install
npx supabase start -x studio,postgres-meta
```

Migrations apply on first start. Use `npx supabase db reset` only when you want a clean database.

If Docker recently ran out of disk (`exit 139`, `exec format error`, or `input/output error` on Studio / postgres-meta), keep the `-x` flags. Postgres, Auth, Kong, REST, Storage, and Edge Functions still start. To bring Studio back later: quit Docker Desktop, restart it, then `npx supabase stop --no-backup && npx supabase start`.

If `docker pull` hangs on `public.ecr.aws`, use an empty Docker config so the Desktop credential helper is skipped:

```bash
mkdir -p /tmp/docker-nocreds
echo '{"auths":{}}' > /tmp/docker-nocreds/config.json
export DOCKER_CONFIG=/tmp/docker-nocreds
npx supabase start -x studio,postgres-meta
```

Serve the Study API (from this repo):

```bash
ALLOW_DEV_GRANTS=true supabase functions serve study-api --no-verify-jwt=false --env-file supabase/.env.example
```

If Studio already proxies functions after `supabase start`, you can skip `functions serve` and call `http://127.0.0.1:54321/functions/v1/study-api/...`.

Run the worker (from this backend repo):

```bash
cp worker/.env.example worker/.env
```

Then open `worker/.env` and set `OPENAI_API_KEY=sk-...` on its own line. Do not pass the key as a `cp` argument.

```bash
npm run worker
```

The worker reads `worker/.env` even if you start it from the repo root. Local Supabase URL and service-role key are filled in for you if those lines are missing.

## Expo app env

In `word-adventure/.env`:

```
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
EXPO_PUBLIC_STUDY_API_URL=http://127.0.0.1:54321/functions/v1/study-api
```

iOS Simulator can use `127.0.0.1`. Android emulator: replace the host with `10.0.2.2`. A physical device needs your machine's LAN IP.

Anonymous sign-in happens automatically the first time Study talks to the backend. New accounts receive 2 Study Credits via `handle_new_user`.

## API

All routes are under `/functions/v1/study-api` and require a user JWT.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/bootstrap` | credits, entitlements, flags |
| POST | `/inputs` | topic / pasted notes |
| POST | `/generation-jobs` | enqueue (idempotency required) |
| GET | `/jobs/:id` | poll status |
| POST | `/jobs/:id/retry` | retry failed |
| POST | `/jobs/:id/cancel` | cancel queued |
| GET | `/packs` | list mine |
| GET | `/packs/:id` | entitlement-aware pack |
| GET | `/packs/:id/versions/:version/manifest` | signed-shape manifest JSON |
| POST | `/packs/:id/unlock-with-credit` | debit 1 credit, grant access |
| POST | `/credits/dev-grant` | local-only +1 (ALLOW_DEV_GRANTS=true) |

Preview generation is free. Unlock costs 1 credit in a single Postgres transaction (`unlock_pack_with_credit`). Terminal generation failure does not debit.

## Tests

```bash
npm test
# with local DB up:
psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f scripts/test-rls.sql
```

## Remote cutover (later)

1. Create a hosted Supabase project
2. `supabase link --project-ref <ref>`
3. `supabase db push`
4. Deploy `study-api`; run this worker on Fly/Railway/a VM (not Edge)
5. Change Expo `EXPO_PUBLIC_*` URLs/keys
6. Keep the service role and `OPENAI_API_KEY` off the device
