import { z } from 'zod';

export const API_VERSION = 'v1';
export const STUDY_PACK_SCHEMA_VERSION = 1;
export const PUZZLE_ENGINE_VERSION = 'crossword-1';
export const RECIPE_VERSION = 'study-ai-1';
export const VALIDATOR_VERSION = 'study-term-1';

export const ERROR_CODES = [
  'auth_required',
  'not_entitled',
  'state_conflict',
  'validation_failed',
  'quota_exceeded',
  'not_found',
  'moderation_rejected',
  'unplayable_terms',
  'provider_unavailable',
  'job_failed',
  'insufficient_credits',
  'idempotency_required',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorEnvelopeSchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES),
      message: z.string().max(200),
    }),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function errorEnvelope(code: ErrorCode, message: string): ErrorEnvelope {
  return { error: { code, message: message.slice(0, 200) } };
}

export const generationStatusSchema = z.enum([
  'queued',
  'analyzing',
  'retrieving',
  'validating',
  'building_preview',
  'preview_ready',
  'complete',
  'retryable_failure',
  'terminal_failure',
  'cancelled',
]);

export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const studyInputKindSchema = z.enum(['topic', 'pasted_notes']);

export const createInputRequestSchema = z
  .object({
    kind: studyInputKindSchema,
    topic: z.string().min(3).max(500),
    notes: z.string().max(10_000).optional(),
    language: z.string().min(2).max(8).default('en'),
    level: z.string().max(40).optional(),
    learningGoal: z.string().max(300).optional(),
  })
  .strict();

export const createJobRequestSchema = z
  .object({
    inputId: z.string().uuid(),
    idempotencyKey: z.string().min(8).max(80),
  })
  .strict();

export const unlockRequestSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(80),
  })
  .strict();

export const llmTermSchema = z
  .object({
    term: z.string().min(1).max(40),
    answer: z.string().regex(/^[A-Za-z]{3,8}$/),
    definition: z.string().min(8).max(240),
    explanation: z.string().max(400).optional(),
    category: z.string().min(1).max(40),
    difficulty: z.number().int().min(1).max(5),
  })
  .strict();

export const llmPackSchema = z
  .object({
    title: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    language: z.enum(['en']).default('en'),
    terms: z.array(llmTermSchema).min(8).max(40),
  })
  .strict();

export type LlmPack = z.infer<typeof llmPackSchema>;
export type LlmTerm = z.infer<typeof llmTermSchema>;

export const puzzleAnswerSchema = z
  .object({
    word: z.string(),
    row: z.number().int(),
    column: z.number().int(),
    direction: z.enum(['horizontal', 'vertical']),
  })
  .strict();

export const puzzleDefinitionSchema = z
  .object({
    id: z.number().int(),
    worldId: z.string(),
    regionId: z.string(),
    letters: z.array(z.string()),
    answers: z.array(puzzleAnswerSchema),
    difficulty: z.number(),
    starReward: z.number(),
    coinReward: z.number(),
    bonusWords: z.array(z.string()),
    contentKind: z.literal('study_lesson').optional(),
    studyLessonId: z.string().optional(),
    studyPackId: z.string().optional(),
  })
  .strict();

export const studySourceSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    publisher: z.string().optional(),
    url: z.string().url().optional(),
    locator: z.string().optional(),
    accessedAt: z.string().optional(),
    sourceType: z.enum(['user_material', 'retrieved', 'editorial']),
    validationStatus: z.enum(['verified', 'unverified', 'unavailable']),
  })
  .strict();

export const studyTermSchema = z
  .object({
    id: z.string(),
    packId: z.string(),
    term: z.string(),
    answer: z.string(),
    definition: z.string(),
    explanation: z.string().optional(),
    fact: z.string().optional(),
    category: z.string(),
    difficulty: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    sourceIds: z.array(z.string()),
  })
  .strict();

export const studyLessonSchema = z
  .object({
    id: z.string(),
    packId: z.string(),
    title: z.string(),
    category: z.string().optional(),
    order: z.number().int().nonnegative(),
    termIds: z.array(z.string()),
    supportedModes: z.array(z.enum(['discover', 'recall', 'review'])),
    puzzleContentId: z.string(),
    isPreview: z.boolean(),
  })
  .strict();

export const studyPackContentSchema = z
  .object({
    id: z.string(),
    schemaVersion: z.number().int(),
    contentVersion: z.number().int(),
    title: z.string(),
    description: z.string().optional(),
    language: z.string(),
    level: z.string().optional(),
    learningGoal: z.string().optional(),
    inputKind: z.enum(['topic', 'pasted_notes', 'upload']),
    generationStatus: generationStatusSchema,
    terms: z.array(studyTermSchema),
    lessons: z.array(studyLessonSchema),
    sources: z.array(studySourceSchema),
    ownerId: z.string(),
    shareCode: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export const packManifestSchema = z
  .object({
    schemaVersion: z.literal(STUDY_PACK_SCHEMA_VERSION),
    redacted: z.boolean(),
    pack: studyPackContentSchema,
    puzzles: z.record(z.string(), puzzleDefinitionSchema),
  })
  .strict();

export type PackManifest = z.infer<typeof packManifestSchema>;

export const jobDtoSchema = z
  .object({
    id: z.string().uuid(),
    packId: z.string().uuid().optional(),
    accountId: z.string().uuid(),
    inputKind: studyInputKindSchema,
    status: generationStatusSchema,
    idempotencyKey: z.string(),
    safeErrorCode: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();

export type JobDto = z.infer<typeof jobDtoSchema>;

export const bootstrapDtoSchema = z
  .object({
    serverTime: z.string(),
    creditBalance: z.number().int(),
    flags: z.object({
      studyCreate: z.boolean(),
      studyPurchase: z.boolean(),
      allowDevGrants: z.boolean(),
    }),
    entitlements: z.array(
      z
        .object({
          packId: z.string().uuid(),
          access: z.enum(['preview', 'purchased', 'creator_paid_shared']),
          source: z.enum([
            'direct_purchase',
            'study_credit',
            'creator_purchase',
            'admin',
          ]),
          grantedAt: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type BootstrapDto = z.infer<typeof bootstrapDtoSchema>;
