import './loadEnv';
import { adminClient, processNextJob } from './pipeline';

const POLL_MS = Number(process.env.WORKER_POLL_MS ?? 1500);

async function main() {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      'Missing OPENAI_API_KEY. Put it in worker/.env (copy worker/.env.example first).',
    );
  }
  const client = adminClient();
  // eslint-disable-next-line no-console
  console.log('[study-worker] polling for generation jobs');
  for (;;) {
    try {
      const worked = await processNextJob(client);
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
