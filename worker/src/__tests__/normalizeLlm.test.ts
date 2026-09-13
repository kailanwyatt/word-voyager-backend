import { describe, expect, it } from 'vitest';
import { llmBandWaveSchema } from '@word-voyage/contracts';
import {
  failValidation,
  normalizeLlmPayload,
  parseLlmJson,
} from '../ai/normalizeLlm';

describe('LLM payload cleanup', () => {
  it('drops invalid answers and extra terms instead of failing the pack', () => {
    const terms = Array.from({ length: 30 }, (_, i) => ({
      term: `Place ${i}`,
      answer: `W${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}RD`,
      definition: 'A sufficiently detailed educational definition.',
      category: 'Landmarks',
      difficulty: 2,
      extra: true,
    }));
    terms[0] = {
      ...terms[0]!,
      answer: 'ST KITTS',
    };
    const cleaned = normalizeLlmPayload({
      title: 'Landmarks of St. Kitts and Nevis',
      description: 'A paid study pack.',
      language: 'en',
      terms,
      tools: [{ name: 'fetch' }],
    });
    expect(cleaned.terms).toHaveLength(24);
    expect(cleaned.terms.some((term) => term.answer.includes(' '))).toBe(false);
    expect(llmBandWaveSchema.safeParse(cleaned).success).toBe(true);
  });

  it('recovers a truncated terms array', () => {
    const parsed = parseLlmJson(
      '{"title":"Pack","description":"A useful study pack about islands.","language":"en","terms":[{"term":"Nevis","answer":"NEVIS","definition":"The smaller island in the federation.","category":"Landmarks","difficulty":1},{"term":"Fort"',
    );
    const cleaned = normalizeLlmPayload(parsed);
    expect(cleaned.terms.map((term) => term.answer)).toEqual(['NEVIS']);
  });

  it('keeps a validation cause string for Railway logs', () => {
    try {
      failValidation('wave_schema', { count: 3 });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('validation_failed');
      expect(String((error as Error).cause)).toContain('wave_schema');
    }
  });
});
