import { corsHeaders, errorResponse, jsonResponse } from '../_shared/http.ts';
import {
  AuthError,
  requireUserId,
  serviceClient,
  userClient,
} from '../_shared/supabase.ts';
import {
  createInputRequestSchema,
  createJobRequestSchema,
  PREVIEW_SAMPLES_CACHE_DAYS,
  PREVIEW_SAMPLES_COOLDOWN_MS,
  PREVIEW_SAMPLES_DAILY_LIMIT,
  previewSamplesRequestSchema,
  unlockRequestSchema,
} from '../_shared/schemas.ts';
import {
  generatePreviewSamples,
  parseCachedPreviewPayload,
} from '../_shared/previewLlm.ts';

const ACTIVE_JOB_STATUSES = [
  'queued',
  'analyzing',
  'retrieving',
  'validating',
  'building_preview',
];

function developmentCreditGrantsEnabled(): boolean {
  if (Deno.env.get('ALLOW_DEV_GRANTS') !== 'true') return false;
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return false;
  try {
    const hostname = new URL(supabaseUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = routePath(url);
  try {
    const userId = await requireUserId(req);
    await ensureProfile(userId);
    const response = await routeRequest(req, path, userId);
    console.log(
      JSON.stringify({
        method: req.method,
        path,
        status: response.status,
        userId: userId.slice(0, 8),
      }),
    );
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      console.log(
        JSON.stringify({
          method: req.method,
          path,
          status: 401,
          error: 'auth_required',
        }),
      );
      return errorResponse(401, 'auth_required', 'Sign in to continue');
    }
    console.error('study-api unhandled', error);
    return errorResponse(500, 'job_failed', 'Request failed');
  }
});

async function routeRequest(
  req: Request,
  path: string,
  userId: string,
): Promise<Response> {
  if (req.method === 'GET' && path === '/bootstrap') {
    return await handleBootstrap(userId);
  }
  if (req.method === 'POST' && path === '/inputs') {
    return await handleCreateInput(userId, await req.json());
  }
  if (req.method === 'POST' && path === '/generation-jobs') {
    return await handleCreateJob(userId, await req.json());
  }
  if (req.method === 'POST' && path === '/preview-samples') {
    return await handlePreviewSamples(userId, await req.json());
  }

  const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    return await handleGetJob(userId, jobMatch[1]!);
  }
  const jobAction = path.match(/^\/jobs\/([^/]+)\/(retry|cancel)$/);
  if (req.method === 'POST' && jobAction) {
    return await handleJobAction(userId, jobAction[1]!, jobAction[2]!);
  }

  if (req.method === 'GET' && path === '/packs') {
    return await handleListPacks(userId);
  }
  const packMatch = path.match(/^\/packs\/([^/]+)$/);
  if (req.method === 'GET' && packMatch) {
    return await handleGetPack(userId, packMatch[1]!, false);
  }
  const manifestMatch = path.match(
    /^\/packs\/([^/]+)\/versions\/([^/]+)\/manifest$/,
  );
  if (req.method === 'GET' && manifestMatch) {
    return await handleGetPack(userId, manifestMatch[1]!, true);
  }
  const unlockMatch = path.match(/^\/packs\/([^/]+)\/unlock-with-credit$/);
  if (req.method === 'POST' && unlockMatch) {
    return await handleUnlock(req, userId, unlockMatch[1]!);
  }
  if (req.method === 'POST' && path === '/credits/dev-grant') {
    return await handleDevGrant(userId);
  }

  return errorResponse(404, 'not_found', 'Unknown route');
}

function routePath(url: URL): string {
  const raw = url.pathname;
  const marker = '/study-api';
  const idx = raw.indexOf(marker);
  const rest = idx >= 0 ? raw.slice(idx + marker.length) : raw;
  const trimmed = rest.replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : trimmed;
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.toLowerCase().trim());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function ensureProfile(userId: string): Promise<void> {
  const admin = serviceClient();
  await admin.from('profiles').upsert({ id: userId }, { onConflict: 'id' });
}

async function handleBootstrap(userId: string): Promise<Response> {
  const admin = serviceClient();
  const { data: ledger } = await admin
    .from('study_credit_ledger')
    .select('delta')
    .eq('account_id', userId);
  const creditBalance = (ledger ?? []).reduce(
    (sum: number, row: { delta: number }) => sum + row.delta,
    0,
  );
  const { data: ents } = await admin
    .from('entitlements')
    .select('pack_id, source_type, granted_at, revoked_at')
    .eq('account_id', userId)
    .is('revoked_at', null);

  const allowDevGrants = developmentCreditGrantsEnabled();
  return jsonResponse({
    serverTime: new Date().toISOString(),
    creditBalance,
    flags: {
      studyCreate: true,
      studyPurchase: true,
      allowDevGrants,
    },
    entitlements: (ents ?? []).map(
      (row: { pack_id: string; source_type: string; granted_at: string }) => ({
        packId: row.pack_id,
        access: 'purchased',
        source: mapEntitlementSource(row.source_type),
        grantedAt: row.granted_at,
      }),
    ),
  });
}

function mapEntitlementSource(
  source: string,
): 'direct_purchase' | 'study_credit' | 'creator_purchase' | 'admin' {
  if (source === 'direct_purchase') return 'direct_purchase';
  if (source === 'admin' || source === 'promo' || source === 'free') return 'admin';
  if (source === 'creator_paid_shared') return 'creator_purchase';
  return 'study_credit';
}

async function handleCreateInput(
  userId: string,
  body: unknown,
): Promise<Response> {
  const parsed = createInputRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(422, 'validation_failed', 'Invalid study input');
  }
  const input = parsed.data;
  const admin = serviceClient();
  const hash = await sha256Hex(input.topic);
  const retention = new Date();
  retention.setDate(retention.getDate() + 30);

  const { data, error } = await admin
    .from('study_inputs')
    .insert({
      owner_id: userId,
      kind: input.kind,
      normalized_topic_hash: hash,
      topic_text: input.topic,
      notes_text: input.notes ?? null,
      language: input.language ?? 'en',
      level: input.level ?? null,
      learning_goal: input.learningGoal ?? null,
      retention_expires_at: retention.toISOString(),
      moderation_state: 'pending',
    })
    .select('id, kind, created_at')
    .single();

  if (error || !data) {
    return errorResponse(500, 'job_failed', 'Could not store input');
  }
  return jsonResponse({ id: data.id, kind: data.kind, createdAt: data.created_at }, 201);
}

type PreviewRow = {
  samples: unknown;
  billed_at: string;
  created_at: string;
};

const PREVIEW_CACHE_VERSION = 'preview:v5';

async function billedPreviewCount(
  admin: ReturnType<typeof serviceClient>,
  userId: string,
  sinceIso: string,
): Promise<number> {
  const { count } = await admin
    .from('study_preview_samples')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .gte('billed_at', sinceIso);
  return count ?? 0;
}

async function handlePreviewSamples(
  userId: string,
  body: unknown,
): Promise<Response> {
  const parsed = previewSamplesRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(422, 'validation_failed', 'Invalid preview request');
  }
  const input = parsed.data;
  const admin = serviceClient();
  const hash = await sha256Hex(
    [
      PREVIEW_CACHE_VERSION,
      input.topic,
      input.focus ?? '',
      (input.notes ?? '').slice(0, 400),
    ].join('\n'),
  );
  const cacheMs = PREVIEW_SAMPLES_CACHE_DAYS * 24 * 60 * 60 * 1000;
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: cached } = await admin
    .from('study_preview_samples')
    .select('samples, billed_at, created_at')
    .eq('owner_id', userId)
    .eq('topic_hash', hash)
    .maybeSingle();
  const cachedRow = cached as PreviewRow | null;
  const cachedPayload = cachedRow
    ? parseCachedPreviewPayload(cachedRow.samples)
    : { samples: [] as { term: string; definition: string }[] };
  const cacheFresh =
    cachedPayload.samples.length > 0 &&
    cachedRow != null &&
    Date.now() - new Date(cachedRow.created_at).getTime() < cacheMs;

  const used = await billedPreviewCount(admin, userId, dayAgo);
  const remaining = Math.max(0, PREVIEW_SAMPLES_DAILY_LIMIT - used);

  if (cacheFresh && cachedRow) {
    return jsonResponse({
      samples: cachedPayload.samples,
      message: cachedPayload.message,
      cover: cachedPayload.cover,
      cached: true,
      remainingToday: remaining,
    });
  }

  const { data: latest } = await admin
    .from('study_preview_samples')
    .select('billed_at')
    .eq('owner_id', userId)
    .order('billed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest?.billed_at) {
    const elapsed = Date.now() - new Date(latest.billed_at).getTime();
    if (elapsed < PREVIEW_SAMPLES_COOLDOWN_MS) {
      return errorResponse(
        429,
        'rate_limited',
        'Please wait a moment before requesting another preview',
      );
    }
  }

  if (used >= PREVIEW_SAMPLES_DAILY_LIMIT) {
    return errorResponse(
      429,
      'quota_exceeded',
      'Daily sample preview limit reached',
    );
  }

  let preview;
  try {
    preview = await generatePreviewSamples(input);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'job_failed';
    if (code === 'moderation_rejected') {
      return errorResponse(
        422,
        'moderation_rejected',
        'This topic wasn’t approved. Try a different classroom topic.',
      );
    }
    if (code === 'provider_unavailable') {
      return errorResponse(
        503,
        'provider_unavailable',
        'Study is busy right now. Please try again in a moment.',
      );
    }
    return errorResponse(
      422,
      'validation_failed',
      'We couldn’t preview that topic. Add a bit more detail and try again.',
    );
  }

  const now = new Date().toISOString();
  const { error } = await admin.from('study_preview_samples').upsert(
    {
      owner_id: userId,
      topic_hash: hash,
      samples: {
        samples: preview.samples,
        message: preview.message,
        cover: preview.cover,
      },
      billed_at: now,
      created_at: now,
    },
    { onConflict: 'owner_id,topic_hash' },
  );
  if (error) {
    return errorResponse(500, 'job_failed', 'Could not save preview');
  }

  return jsonResponse({
    samples: preview.samples,
    message: preview.message,
    cover: preview.cover,
    cached: false,
    remainingToday: Math.max(0, remaining - 1),
  });
}

async function handleCreateJob(
  userId: string,
  body: unknown,
): Promise<Response> {
  const parsed = createJobRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(422, 'validation_failed', 'Invalid generation request');
  }
  const admin = serviceClient();

  const { data: existing } = await admin
    .from('generation_jobs')
    .select('*')
    .eq('owner_id', userId)
    .eq('idempotency_key', parsed.data.idempotencyKey)
    .maybeSingle();
  if (existing) {
    return jsonResponse(jobDto(existing, 'topic'));
  }

  const { data: input } = await admin
    .from('study_inputs')
    .select('id, owner_id, kind')
    .eq('id', parsed.data.inputId)
    .maybeSingle();
  if (!input || input.owner_id !== userId) {
    return errorResponse(404, 'not_found', 'Input not found');
  }

  const { count: activeCount } = await admin
    .from('generation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .in('status', ACTIVE_JOB_STATUSES);
  if ((activeCount ?? 0) >= 1) {
    return errorResponse(429, 'quota_exceeded', 'A generation is already running');
  }

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: dayCount } = await admin
    .from('generation_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', userId)
    .gte('created_at', dayAgo);
  if ((dayCount ?? 0) >= 3) {
    return errorResponse(429, 'quota_exceeded', 'Daily generation limit reached');
  }

  const { data: pack, error: packError } = await admin
    .from('study_packs')
    .insert({
      owner_id: userId,
      kind: 'custom',
      visibility: 'private',
      input_kind: input.kind,
      lifecycle_state: 'generating',
    })
    .select('id')
    .single();
  if (packError || !pack) {
    return errorResponse(500, 'job_failed', 'Could not create pack');
  }

  const { data: job, error: jobError } = await admin
    .from('generation_jobs')
    .insert({
      owner_id: userId,
      input_id: input.id,
      pack_id: pack.id,
      status: 'queued',
      idempotency_key: parsed.data.idempotencyKey,
    })
    .select('*')
    .single();
  if (jobError || !job) {
    return errorResponse(500, 'job_failed', 'Could not enqueue job');
  }

  await admin.from('generation_job_events').insert({
    job_id: job.id,
    sequence: 0,
    state: 'queued',
    safe_detail: 'enqueued',
  });

  return jsonResponse(jobDto(job, input.kind), 201);
}

async function handleGetJob(userId: string, jobId: string): Promise<Response> {
  const admin = serviceClient();
  const { data: job } = await admin
    .from('generation_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (!job || job.owner_id !== userId) {
    return errorResponse(404, 'not_found', 'Job not found');
  }
  const { data: input } = await admin
    .from('study_inputs')
    .select('kind')
    .eq('id', job.input_id)
    .maybeSingle();
  return jsonResponse(jobDto(job, input?.kind ?? 'topic'));
}

async function handleJobAction(
  userId: string,
  jobId: string,
  action: string,
): Promise<Response> {
  const admin = serviceClient();
  const { data: job } = await admin
    .from('generation_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (!job || job.owner_id !== userId) {
    return errorResponse(404, 'not_found', 'Job not found');
  }
  if (action === 'cancel') {
    if (!['queued', 'retryable_failure'].includes(job.status)) {
      return errorResponse(409, 'state_conflict', 'Job cannot be cancelled');
    }
    await admin
      .from('generation_jobs')
      .update({
        status: 'cancelled',
        finished_at: new Date().toISOString(),
        lease_owner: null,
        lease_expires_at: null,
      })
      .eq('id', jobId);
    return jsonResponse({ ok: true });
  }
  if (job.status !== 'retryable_failure') {
    return errorResponse(409, 'state_conflict', 'Job cannot be retried');
  }
  await admin
    .from('generation_jobs')
    .update({
      status: 'queued',
      next_attempt_at: new Date().toISOString(),
      lease_owner: null,
      lease_expires_at: null,
      safe_error_code: null,
    })
    .eq('id', jobId);
  return jsonResponse({ ok: true });
}

async function handleListPacks(userId: string): Promise<Response> {
  const admin = serviceClient();
  const { data: packs } = await admin
    .from('study_packs')
    .select('id, title, lifecycle_state, created_at, current_version_id')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  return jsonResponse({ packs: packs ?? [] });
}

async function handleGetPack(
  userId: string,
  packId: string,
  asManifest: boolean,
): Promise<Response> {
  const assembled = await assemblePack(userId, packId);
  if (!assembled) {
    return errorResponse(404, 'not_found', 'Pack not found');
  }
  if (asManifest) {
    return jsonResponse({
      schemaVersion: 1,
      redacted: assembled.redacted,
      pack: assembled.pack,
      puzzles: assembled.puzzles,
    });
  }
  return jsonResponse({
    pack: assembled.pack,
    puzzles: assembled.puzzles,
    access: assembled.access,
    redacted: assembled.redacted,
  });
}

async function handleUnlock(
  req: Request,
  _userId: string,
  packId: string,
): Promise<Response> {
  const parsed = unlockRequestSchema.safeParse(await req.json());
  if (!parsed.success) {
    return errorResponse(422, 'validation_failed', 'Idempotency key required');
  }
  const scoped = userClient(req);
  const { data, error } = await scoped.rpc('unlock_pack_with_credit', {
    p_pack_id: packId,
    p_idempotency_key: parsed.data.idempotencyKey,
  });
  if (error) {
    const code = mapRpcError(error.message);
    const status =
      code === 'insufficient_credits'
        ? 409
        : code === 'auth_required'
          ? 401
          : code === 'not_found'
            ? 404
            : code === 'not_entitled'
              ? 403
              : 409;
    return errorResponse(status, code, 'Unlock failed');
  }
  return jsonResponse(data);
}

async function handleDevGrant(userId: string): Promise<Response> {
  if (!developmentCreditGrantsEnabled()) {
    return errorResponse(403, 'not_entitled', 'Dev grants are disabled');
  }
  const admin = serviceClient();
  const key = `dev_grant_${crypto.randomUUID()}`;
  await admin.from('study_credit_ledger').insert({
    account_id: userId,
    delta: 1,
    reason: 'admin',
    idempotency_key: key,
  });
  const { data: ledger } = await admin
    .from('study_credit_ledger')
    .select('delta')
    .eq('account_id', userId);
  const creditBalance = (ledger ?? []).reduce(
    (sum: number, row: { delta: number }) => sum + row.delta,
    0,
  );
  return jsonResponse({ creditBalance });
}

function mapRpcError(message: string): string {
  if (message.includes('auth_required')) return 'auth_required';
  if (message.includes('not_found')) return 'not_found';
  if (message.includes('not_entitled')) return 'not_entitled';
  if (message.includes('insufficient_credits')) return 'insufficient_credits';
  if (message.includes('idempotency_required')) return 'idempotency_required';
  if (message.includes('state_conflict')) return 'state_conflict';
  return 'state_conflict';
}

function jobDto(job: Record<string, unknown>, inputKind: string) {
  return {
    id: job.id,
    packId: job.pack_id ?? undefined,
    accountId: job.owner_id,
    inputKind,
    status: job.status,
    idempotencyKey: job.idempotency_key,
    safeErrorCode: job.safe_error_code ?? undefined,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

async function assemblePack(userId: string, packId: string) {
  const admin = serviceClient();
  const { data: packRow } = await admin
    .from('study_packs')
    .select('*')
    .eq('id', packId)
    .maybeSingle();
  if (!packRow || packRow.owner_id !== userId) return null;
  if (!packRow.current_version_id) {
    return {
      pack: {
        id: packRow.id,
        schemaVersion: 1,
        contentVersion: 0,
        title: packRow.title ?? 'Generating…',
        language: 'en',
        inputKind: packRow.input_kind ?? 'topic',
        generationStatus: 'queued',
        terms: [],
        lessons: [],
        sources: [],
        ownerId: userId,
        createdAt: packRow.created_at,
        updatedAt: packRow.created_at,
      },
      puzzles: {},
      access: 'preview' as const,
      redacted: true,
    };
  }

  const { data: version } = await admin
    .from('study_pack_versions')
    .select('*')
    .eq('id', packRow.current_version_id)
    .single();
  const { data: terms } = await admin
    .from('study_terms')
    .select('*')
    .eq('pack_version_id', packRow.current_version_id)
    .order('sort_order');
  const { data: sources } = await admin
    .from('study_sources')
    .select('*')
    .eq('pack_version_id', packRow.current_version_id);
  const { data: lessons } = await admin
    .from('study_lessons')
    .select('*')
    .eq('pack_version_id', packRow.current_version_id)
    .order('ordinal');
  const lessonIds = (lessons ?? []).map((l: { id: string }) => l.id);
  const { data: lessonTerms } = lessonIds.length
    ? await admin
        .from('study_lesson_terms')
        .select('*')
        .in('lesson_id', lessonIds)
    : { data: [] };
  const { data: puzzles } = lessonIds.length
    ? await admin.from('study_puzzles').select('*').in('lesson_id', lessonIds)
    : { data: [] };

  const { data: entitlement } = await admin
    .from('entitlements')
    .select('id')
    .eq('account_id', userId)
    .eq('pack_id', packId)
    .is('revoked_at', null)
    .maybeSingle();
  const entitled = Boolean(entitlement);

  const termsByLesson = new Map<string, string[]>();
  for (const row of lessonTerms ?? []) {
    const list = termsByLesson.get(row.lesson_id) ?? [];
    list.push(row.term_id);
    termsByLesson.set(row.lesson_id, list);
  }

  const puzzleByLesson = new Map<string, Record<string, unknown>>();
  for (const row of puzzles ?? []) {
    puzzleByLesson.set(row.lesson_id, row.layout as Record<string, unknown>);
  }

  const allLessonRows = lessons ?? [];
  const difficultyByTermId = new Map<string, number>();
  for (const term of terms ?? []) {
    difficultyByTermId.set(term.id, Number(term.difficulty) || 2);
  }
  const lessonDifficulty = (termIds: string[]): number => {
    if (termIds.length === 0) return 2;
    const mean =
      termIds.reduce((sum, id) => sum + (difficultyByTermId.get(id) ?? 2), 0) /
      termIds.length;
    return Math.max(1, Math.min(5, Math.round(mean)));
  };

  const mappedLessons = allLessonRows.map((l: Record<string, unknown>) => {
    const open = entitled || Boolean(l.is_preview);
    const ids = termsByLesson.get(l.id as string) ?? [];
    return {
      id: l.id,
      packId,
      title: l.title,
      category: l.category_id ?? undefined,
      order: l.ordinal,
      termIds: open ? ids : [],
      supportedModes: l.supported_modes ?? ['discover', 'recall', 'review'],
      puzzleContentId: `study_${packId}_${l.id}`,
      isPreview: l.is_preview,
      difficulty: lessonDifficulty(ids),
      locked: !open,
    };
  });

  const allowedTermIds = new Set<string>();
  for (const lesson of mappedLessons) {
    if (!lesson.locked) {
      for (const id of lesson.termIds) allowedTermIds.add(id);
    }
  }

  const mappedTerms = (terms ?? [])
    .filter((t: { id: string }) => entitled || allowedTermIds.has(t.id))
    .map((t: Record<string, unknown>) => ({
      id: t.id,
      packId,
      term: t.display_term,
      answer: t.normalized_answer,
      definition: t.definition,
      explanation: t.explanation ?? undefined,
      fact: t.fact ?? undefined,
      category: t.category_id ?? 'General',
      difficulty: t.difficulty,
      sourceIds: (sources ?? []).map((s: { id: string }) => s.id),
    }));

  const mappedPuzzles: Record<string, unknown> = {};
  for (const lesson of mappedLessons) {
    if (lesson.locked) continue;
    const layout = puzzleByLesson.get(lesson.id as string);
    if (layout) mappedPuzzles[lesson.puzzleContentId] = layout;
  }

  const mappedSources = (sources ?? []).map((s: Record<string, unknown>) => ({
    id: s.id,
    title: s.title,
    publisher: s.publisher ?? undefined,
    url: undefined,
    locator: s.locator ?? undefined,
    sourceType: s.type,
    validationStatus: s.validation_state,
  }));

  const allTerms = terms ?? [];
  const bandCounts = { easy: 0, medium: 0, hard: 0 };
  for (const term of allTerms) {
    const difficulty = Number(term.difficulty) || 2;
    if (difficulty <= 2) bandCounts.easy += 1;
    else if (difficulty <= 3) bandCounts.medium += 1;
    else bandCounts.hard += 1;
  }
  const stats = {
    wordCount: allTerms.length,
    puzzleCount: allLessonRows.length,
    miniGameWordCount: allTerms.filter((t: { normalized_answer?: string }) => {
      const word = String(t.normalized_answer ?? '').replace(/[^A-Za-z]/g, '');
      return word.length >= 3 && word.length <= 12;
    }).length,
    easyWordCount: bandCounts.easy,
    mediumWordCount: bandCounts.medium,
    hardWordCount: bandCounts.hard,
  };

  return {
    pack: {
      id: packId,
      schemaVersion: version?.schema_version ?? 1,
      contentVersion: version?.version ?? 1,
      title: version?.title ?? packRow.title ?? 'Study Pack',
      description: version?.description ?? undefined,
      language: version?.language ?? 'en',
      level: version?.level ?? undefined,
      learningGoal: version?.learning_goal ?? undefined,
      inputKind: packRow.input_kind ?? 'topic',
      generationStatus: entitled ? 'complete' : 'preview_ready',
      terms: mappedTerms,
      lessons: mappedLessons,
      stats,
      sources: mappedSources,
      ownerId: userId,
      createdAt: packRow.created_at,
      updatedAt: version?.created_at ?? packRow.created_at,
    },
    puzzles: mappedPuzzles,
    access: entitled ? ('purchased' as const) : ('preview' as const),
    redacted: !entitled,
  };
}
