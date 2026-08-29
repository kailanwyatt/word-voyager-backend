import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import ws from 'ws';
import {
  PUZZLE_ENGINE_VERSION,
  RECIPE_VERSION,
  STUDY_PACK_SCHEMA_VERSION,
  VALIDATOR_VERSION,
} from '@word-voyage/contracts';
import { createProvider, type LlmProvider } from './ai/provider';
import { supabaseServiceRoleKey, supabaseUrl } from './loadEnv';
import { groupTermsIntoLessons, validateLlmTerms } from './puzzle/buildPack';

const WORKER_ID = `worker-${process.pid}`;

type JobRow = {
  id: string;
  owner_id: string;
  input_id: string;
  pack_id: string | null;
  attempt_count: number;
  status: string;
};

export function adminClient(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    // Node <22 has no global WebSocket; supabase-js Realtime requires one at construct time.
    realtime: { transport: ws as unknown as typeof WebSocket },
  });
}

export async function processNextJob(
  client: SupabaseClient,
  provider?: LlmProvider,
): Promise<boolean> {
  const { data: job, error } = await client
    .rpc('claim_generation_job', { p_worker_id: WORKER_ID })
    .maybeSingle();
  if (error) {
    if (error.code === 'PGRST116') return false;
    if (isUnreachable(error)) {
      throw new Error(
        'Cannot reach local Supabase at http://127.0.0.1:54321. Start Docker Desktop, then from word-voyage-backend run: npx supabase start',
      );
    }
    throw new Error(error.message || 'claim_generation_job failed');
  }
  if (!job || !(job as JobRow).id) return false;
  await runJob(client, job as JobRow, provider);
  return true;
}

function isUnreachable(error: { message?: string; details?: string }): boolean {
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('econnrefused') ||
    text.includes('network') ||
    text.includes("couldn't connect") ||
    text.includes('failed to fetch')
  );
}

async function runJob(
  client: SupabaseClient,
  job: JobRow,
  provider?: LlmProvider,
): Promise<void> {
  try {
    const { data: input, error: inputError } = await client
      .from('study_inputs')
      .select('*')
      .eq('id', job.input_id)
      .single();
    if (inputError || !input) {
      // eslint-disable-next-line no-console
      console.error(
        '[study-worker] missing study_inputs',
        job.id,
        job.input_id,
        inputError?.message,
      );
      await fail(client, job, 'terminal_failure', 'validation_failed', {
        detail: 'Could not load study input for this job',
      });
      return;
    }

    const { data: existingPack } = job.pack_id
      ? await client
          .from('study_packs')
          .select('current_version_id')
          .eq('id', job.pack_id)
          .maybeSingle()
      : { data: null };
    if (existingPack?.current_version_id) {
      await client
        .from('generation_jobs')
        .update({
          status: 'preview_ready',
          finished_at: new Date().toISOString(),
          lease_owner: null,
          lease_expires_at: null,
          safe_error_code: null,
        })
        .eq('id', job.id);
      return;
    }

    const llm = provider ?? createProvider();
    const moderateText = [input.topic_text, input.notes_text]
      .filter(Boolean)
      .join('\n');
    const moderation = await llm.moderate(moderateText);
    if (!moderation.allowed) {
      await client
        .from('study_inputs')
        .update({ moderation_state: 'rejected' })
        .eq('id', input.id);
      await fail(client, job, 'terminal_failure', 'moderation_rejected');
      return;
    }
    await client
      .from('study_inputs')
      .update({ moderation_state: 'approved' })
      .eq('id', input.id);

    await setStatus(client, job.id, 'validating');
    const generated = await llm.generatePack({
      kind: input.kind,
      topic: input.topic_text ?? '',
      notes: input.notes_text,
      level: input.level,
      learningGoal: input.learning_goal,
    });
    const terms = validateLlmTerms(generated.terms);
    if (terms.length < 4) {
      await fail(client, job, 'terminal_failure', 'unplayable_terms');
      return;
    }

    await setStatus(client, job.id, 'building_preview');
    const packId = job.pack_id;
    if (!packId) {
      await fail(client, job, 'terminal_failure', 'job_failed');
      return;
    }

    const lessons = groupTermsIntoLessons(packId, terms, hashSeed(job.id));
    if (lessons.length < 1) {
      await fail(client, job, 'terminal_failure', 'unplayable_terms');
      return;
    }

    await persistPack(client, {
      job,
      input,
      title: generated.title,
      description: generated.description,
      terms: lessons.flatMap((lesson) => lesson.terms),
      lessons,
    });

    await client
      .from('generation_jobs')
      .update({
        status: 'preview_ready',
        finished_at: new Date().toISOString(),
        lease_owner: null,
        lease_expires_at: null,
        safe_error_code: null,
      })
      .eq('id', job.id);
    await client.from('generation_job_events').insert({
      job_id: job.id,
      sequence: job.attempt_count + 10,
      state: 'preview_ready',
      safe_detail: 'pack ready',
    });
    await client
      .from('study_inputs')
      .update({
        topic_text: null,
        notes_text: null,
        retention_expires_at: new Date().toISOString(),
      })
      .eq('id', job.input_id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      message === 'provider_unavailable'
        ? 'provider_unavailable'
        : message === 'validation_failed'
          ? 'validation_failed'
          : 'job_failed';
    // eslint-disable-next-line no-console
    console.error('[study-worker] job error', {
      jobId: job.id,
      attempt: job.attempt_count,
      code,
      message,
      cause:
        error instanceof Error && error.cause
          ? String(error.cause)
          : undefined,
    });
    const retryable =
      code === 'provider_unavailable' ||
      code === 'job_failed' ||
      code === 'validation_failed';
    const attempts = job.attempt_count;
    if (retryable && attempts < 3) {
      await fail(client, job, 'retryable_failure', code, {
        detail: message.slice(0, 180),
      });
    } else {
      await fail(client, job, 'terminal_failure', code, {
        detail: message.slice(0, 180),
      });
    }
  }
}

async function persistPack(
  client: SupabaseClient,
  args: {
    job: JobRow;
    input: {
      kind: string;
      topic_text: string | null;
    };
    title: string;
    description: string;
    terms: ReturnType<typeof validateLlmTerms>;
    lessons: ReturnType<typeof groupTermsIntoLessons>;
  },
): Promise<void> {
  const packId = args.job.pack_id!;
  const uniqueTerms = uniqueByAnswer(args.terms);
  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        title: args.title,
        terms: uniqueTerms.map((t) => t.answer),
        lessons: args.lessons.map((l) => l.puzzle.answers),
      }),
    )
    .digest('hex');

  const { data: version, error: versionError } = await client
    .from('study_pack_versions')
    .insert({
      pack_id: packId,
      version: 1,
      schema_version: STUDY_PACK_SCHEMA_VERSION,
      recipe_version: RECIPE_VERSION,
      validator_version: VALIDATOR_VERSION,
      puzzle_engine_version: PUZZLE_ENGINE_VERSION,
      language: 'en',
      title: args.title,
      description: args.description,
      content_hash: contentHash,
      review_state: 'generated',
      published_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (versionError || !version) {
    throw new Error('job_failed');
  }

  const sourceType =
    args.input.kind === 'pasted_notes' ? 'user_material' : 'retrieved';
  const { data: source, error: sourceError } = await client
    .from('study_sources')
    .insert({
      pack_version_id: version.id,
      type: sourceType,
      title:
        args.input.kind === 'pasted_notes'
          ? 'Pasted study notes'
          : 'Model-proposed topic terms',
      validation_state: 'unverified',
    })
    .select('id')
    .single();
  if (sourceError || !source) {
    throw new Error('job_failed');
  }

  const termIdByKey = new Map<string, string>();
  for (const [index, term] of uniqueTerms.entries()) {
    const { data: row, error } = await client
      .from('study_terms')
      .insert({
        pack_version_id: version.id,
        stable_key: term.stableKey,
        display_term: term.term,
        normalized_answer: term.answer,
        definition: term.definition,
        explanation: term.explanation ?? null,
        category_id: term.category,
        difficulty: term.difficulty,
        validation_state: 'accepted',
        sort_order: index,
      })
      .select('id')
      .single();
    if (error || !row) throw new Error('job_failed');
    termIdByKey.set(term.stableKey, row.id);
  }

  for (const lesson of args.lessons) {
    const { data: lessonRow, error: lessonError } = await client
      .from('study_lessons')
      .insert({
        pack_version_id: version.id,
        title: lesson.title,
        category_id: lesson.category ?? null,
        ordinal: lesson.order,
        is_preview: lesson.isPreview,
        supported_modes: ['discover', 'recall', 'review'],
      })
      .select('id')
      .single();
    if (lessonError || !lessonRow) throw new Error('job_failed');

    const lessonTermRows = lesson.terms.flatMap((term, ordinal) => {
      const termId = termIdByKey.get(term.stableKey);
      if (!termId) return [];
      return [
        {
          lesson_id: lessonRow.id,
          term_id: termId,
          ordinal,
          role: 'primary',
        },
      ];
    });
    if (lessonTermRows.length) {
      await client.from('study_lesson_terms').insert(lessonTermRows);
    }

    await client.from('study_puzzles').insert({
      lesson_id: lessonRow.id,
      mode: 'discover',
      puzzle_version: 1,
      letters: lesson.puzzle.letters,
      answers: lesson.puzzle.answers,
      layout: {
        ...lesson.puzzle,
        studyLessonId: lessonRow.id,
        studyPackId: packId,
      },
      quality_score: lesson.puzzle.answers.length,
      generator_seed: lesson.order,
    });
  }

  await client
    .from('study_packs')
    .update({
      current_version_id: version.id,
      title: args.title,
      lifecycle_state: 'preview',
    })
    .eq('id', packId);

}

function uniqueByAnswer(
  terms: ReturnType<typeof validateLlmTerms>,
): ReturnType<typeof validateLlmTerms> {
  const seen = new Set<string>();
  const out = [];
  for (const term of terms) {
    if (seen.has(term.answer)) continue;
    seen.add(term.answer);
    out.push(term);
  }
  return out;
}

async function setStatus(
  client: SupabaseClient,
  jobId: string,
  status: string,
): Promise<void> {
  await client
    .from('generation_jobs')
    .update({
      status,
      lease_expires_at: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
    })
    .eq('id', jobId);
}

async function fail(
  client: SupabaseClient,
  job: JobRow,
  status: 'retryable_failure' | 'terminal_failure',
  code: string,
  opts?: { detail?: string },
): Promise<void> {
  const nextAttempt =
    status === 'retryable_failure'
      ? new Date(Date.now() + Math.min(60_000, 5_000 * 2 ** job.attempt_count)).toISOString()
      : null;
  await client
    .from('generation_jobs')
    .update({
      status,
      safe_error_code: code,
      next_attempt_at: nextAttempt,
      finished_at: status === 'terminal_failure' ? new Date().toISOString() : null,
      lease_owner: null,
      lease_expires_at: null,
    })
    .eq('id', job.id);
  await client.from('generation_job_events').insert({
    job_id: job.id,
    sequence: job.attempt_count + 100,
    state: status,
    safe_detail: (opts?.detail ?? code).slice(0, 200),
  });
  if (status === 'terminal_failure' && job.pack_id) {
    await client
      .from('study_packs')
      .update({ lifecycle_state: 'failed' })
      .eq('id', job.pack_id);
  }
}

function hashSeed(text: string): number {
  return createHash('sha256').update(text).digest().readUInt32BE(0);
}
