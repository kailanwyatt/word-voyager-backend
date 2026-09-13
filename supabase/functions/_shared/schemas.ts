import { z } from 'npm:zod@3.24.2';

export const createInputRequestSchema = z
  .object({
    kind: z.enum(['topic', 'pasted_notes']),
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

export const previewSamplesRequestSchema = z
  .object({
    topic: z.string().min(3).max(500),
    notes: z.string().max(10_000).optional(),
    focus: z.string().max(300).optional(),
  })
  .strict();

export const PREVIEW_SAMPLES_DAILY_LIMIT = 6;
export const PREVIEW_SAMPLES_CACHE_DAYS = 7;
export const PREVIEW_SAMPLES_COOLDOWN_MS = 8_000;
