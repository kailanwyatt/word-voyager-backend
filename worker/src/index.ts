import './loadEnv';
import { startHealthServer } from './healthServer';
import { adminClient, processNextJob } from './pipeline';
import { supabaseUrl } from './loadEnv';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1500);
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 5);

async function main() {
  assertHostedSupabaseConfig();
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      'Missing OPENAI_API_KEY. Put it in worker/.env (copy worker/.env.example first).',
    );
  }

  const health = startHealthServer();
  const client = adminClient();
  let stopping = false;

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    // eslint-disable-next-line no-console
    console.log(`[study-worker] received ${signal}, shutting down`);
    health.close(() => {
      process.exit(0);
    });
    // Force-exit if close hangs (Railway drain window).
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // eslint-disable-next-line no-console
  console.log('[study-worker] polling for generation jobs');
  for (;;) {
    if (stopping) break;
    try {
      const worked = await processNextJob(client, undefined, { maxAttempts: MAX_ATTEMPTS });
      if (!worked) {
        await sleep(POLL_MS);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[study-worker] loop error', formatLoopError(error));
      await sleep(POLL_MS);
    }
  }
}

function assertHostedSupabaseConfig(): void {
  const onRailway = Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID,
  );
  if (!onRailway) return;
  const url = supabaseUrl();
  if (/127\.0\.0\.1|localhost/i.test(url)) {
    throw new Error(
      'SUPABASE_URL points at localhost on Railway. Set hosted SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
}

function formatLoopError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? error.cause.message
        : error.cause
          ? String(error.cause)
          : '';
    return cause ? `${error.message} (${cause})` : error.message;
  }
  if (error && typeof error === 'object') {
    const row = error as {
      message?: string;
      code?: string;
      details?: string;
      hint?: string;
    };
    const parts = [row.message, row.code, row.details, row.hint].filter(Boolean);
    if (parts.length) return parts.join(' — ');
    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown';
    }
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
