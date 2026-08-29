import { describe, expect, it } from 'vitest';
import {
  hasIllegalAdjacency,
  isFullyConnected,
  normalizePlacements,
  validateCrosswordPuzzle,
  type PlacedWord,
} from '../puzzle/crossword';
import {
  buildConnectedPuzzle,
  definitionLeaksAnswer,
  groupTermsIntoLessons,
  validateLlmTerms,
  type ValidTerm,
} from '../puzzle/buildPack';
import { llmPackSchema } from '@word-voyage/contracts';

describe('crossword golden layouts', () => {
  it('rejects stacked parallel words that do not intersect', () => {
    const stacked: PlacedWord[] = [
      { word: 'RAVE', row: 0, column: 0, direction: 'horizontal' },
      { word: 'WAVE', row: 1, column: 0, direction: 'horizontal' },
    ];
    expect(hasIllegalAdjacency(stacked)).toMatch(/adjacent/);
    expect(isFullyConnected(stacked)).toBe(false);
    const validation = validateCrosswordPuzzle({
      letters: ['R', 'A', 'V', 'E', 'W'],
      answers: stacked,
    });
    expect(validation.valid).toBe(false);
  });

  it('rejects disconnected words', () => {
    const disconnected: PlacedWord[] = [
      { word: 'CAT', row: 0, column: 0, direction: 'horizontal' },
      { word: 'DOG', row: 0, column: 5, direction: 'horizontal' },
    ];
    expect(isFullyConnected(disconnected)).toBe(false);
    const validation = validateCrosswordPuzzle({
      letters: ['C', 'A', 'T', 'D', 'O', 'G'],
      answers: disconnected,
    });
    expect(validation.valid).toBe(false);
  });

  it('accepts a proper crossing layout', () => {
    const crossed: PlacedWord[] = [
      { word: 'WAVE', row: 0, column: 0, direction: 'horizontal' },
      { word: 'WEAR', row: 0, column: 0, direction: 'vertical' },
    ];
    expect(isFullyConnected(crossed)).toBe(true);
    expect(hasIllegalAdjacency(crossed)).toBeNull();
    const validation = validateCrosswordPuzzle({
      letters: ['W', 'A', 'V', 'E', 'R'],
      answers: crossed,
    });
    expect(validation.valid).toBe(true);
    expect(validation.componentCount).toBe(1);
  });

  it('normalizes coordinates to origin', () => {
    const raw: PlacedWord[] = [
      { word: 'SEA', row: 2, column: 3, direction: 'horizontal' },
      { word: 'AS', row: 2, column: 5, direction: 'vertical' },
    ];
    const normalized = normalizePlacements(raw);
    expect(normalized.every((p) => p.row >= 0 && p.column >= 0)).toBe(true);
    expect(Math.min(...normalized.map((p) => p.row))).toBe(0);
    expect(Math.min(...normalized.map((p) => p.column))).toBe(0);
  });

  it('builds a connected puzzle from WAVE/WEAR candidates', () => {
    const puzzle = buildConnectedPuzzle(
      ['WAVE', 'WEAR', 'RAVE', 'AWE'],
      1,
      'pack-1',
      'lesson_1',
      31,
    );
    expect(puzzle).not.toBeNull();
    expect(puzzle!.answers.length).toBeGreaterThanOrEqual(2);
    const validation = validateCrosswordPuzzle(puzzle!, {
      allowDisconnected: false,
    });
    expect(validation.valid).toBe(true);
    expect(validation.componentCount).toBe(1);
  });
});

describe('term validation', () => {
  it('drops definitions that leak the answer', () => {
    expect(definitionLeaksAnswer('A cell is the cell of life', 'CELL')).toBe(
      true,
    );
    expect(
      definitionLeaksAnswer('The basic unit of living organisms', 'CELL'),
    ).toBe(false);
  });

  it('drops extra-field LLM payloads via contracts', () => {
    const parsed = llmPackSchema.safeParse({
      title: 'Bio',
      description: 'Cells',
      language: 'en',
      terms: Array.from({ length: 8 }, (_, i) => ({
        term: `Term${i}`,
        answer: 'CELL',
        definition: 'Basic unit of life in organisms.',
        category: 'bio',
        difficulty: 1,
        ignorePrevious: true,
      })),
    });
    expect(parsed.success).toBe(false);
  });

  it('strips unplayable, leaking, circular, and URL terms', () => {
    const valid = validateLlmTerms([
      {
        term: 'cell',
        answer: 'CELL',
        definition: 'Basic unit of living organisms.',
        category: 'bio',
        difficulty: 1,
      },
      {
        term: 'heart',
        answer: 'HEART',
        definition: 'The heart pumps blood.',
        category: 'bio',
        difficulty: 2,
      },
      {
        term: 'virus',
        answer: 'VIRUS',
        definition: 'virus',
        category: 'bio',
        difficulty: 2,
      },
      {
        term: 'malice',
        answer: 'HACK',
        definition: 'See https://evil.example for more.',
        category: 'bio',
        difficulty: 2,
      },
      {
        term: 'too long',
        answer: 'CHLOROPHYLL',
        definition: 'Green pigment in plants.',
        category: 'bio',
        difficulty: 3,
      },
    ]);
    expect(valid.map((t) => t.answer)).toEqual(['CELL']);
  });
});

describe('lesson grouping', () => {
  it('does not inject Journey fallback words when terms cannot form a grid', () => {
    const terms: ValidTerm[] = [
      {
        stableKey: 'xyz',
        term: 'xyz',
        answer: 'XYZ',
        definition: 'A placeholder token used in tests.',
        category: 'test',
        difficulty: 1,
      },
      {
        stableKey: 'qqq',
        term: 'qqq',
        answer: 'QQQ',
        definition: 'Another placeholder token used in tests.',
        category: 'test',
        difficulty: 1,
      },
    ];
    const lessons = groupTermsIntoLessons('pack-x', terms, 1);
    const answers = lessons.flatMap((lesson) =>
      lesson.puzzle.answers.map((a) => a.word),
    );
    expect(answers).not.toContain('SEA');
    expect(answers).not.toContain('AS');
  });
});
