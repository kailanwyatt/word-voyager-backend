import { describe, expect, it } from 'vitest';
import {
  canonicalizeLlmTerms,
  expandClippedDisplay,
  resolveStudyAnswer,
} from '../ai/termQuality';
import { validateLlmTerms } from '../puzzle/buildPack';
import type { LlmTerm } from '@word-voyage/contracts';

function llmTerm(
  term: string,
  answer: string,
  definition = 'A sufficiently detailed educational definition.',
): LlmTerm {
  return {
    term,
    answer,
    definition,
    category: 'Topic',
    difficulty: 2,
  };
}

describe('paid study answer quality', () => {
  it('repairs truncated prefixes into the complete display word', () => {
    expect(resolveStudyAnswer('chlorophyll', 'CHLOROPHY')?.answer).toBe(
      'CHLOROPHYLL',
    );
    expect(resolveStudyAnswer('ribosome', 'RIBOSOM')?.answer).toBe('RIBOSOME');
    expect(resolveStudyAnswer('Basseterre', 'BASSETER')?.answer).toBe(
      'BASSETERRE',
    );
    expect(resolveStudyAnswer('Cayon Beach', 'CAYONBEA')?.answer).toBe('CAYON');
    expect(resolveStudyAnswer('Turtle Beach', 'TURTLEBCH')?.answer).toBe(
      'TURTLE',
    );
    expect(resolveStudyAnswer('Central Park', 'CENTRALP')?.answer).toBe(
      'CENTRAL',
    );
    expect(resolveStudyAnswer('whole note', 'WHOLEN')?.answer).toBe('WHOLE');
  });

  it('keeps a complete token or complete multi-word glue with no letters dropped', () => {
    expect(resolveStudyAnswer('chlorophyll', 'CHLOROPHYLL')?.answer).toBe(
      'CHLOROPHYLL',
    );
    expect(resolveStudyAnswer('T cell', 'CELL')?.answer).toBe('CELL');
    expect(resolveStudyAnswer('White blood cell', 'CELL')?.answer).toBe('CELL');
    expect(resolveStudyAnswer('New York', 'NEWYORK')?.answer).toBe('NEWYORK');
    expect(resolveStudyAnswer('New York', 'YORK')?.answer).toBe('YORK');
    expect(resolveStudyAnswer('Old Road', 'OLDROAD')?.answer).toBe('OLDROAD');
    expect(resolveStudyAnswer('beach', 'BEACH')?.answer).toBe('BEACH');
  });

  it('unwraps a short particle glued onto one real word', () => {
    expect(resolveStudyAnswer('T cell', 'TCELL')?.answer).toBe('CELL');
    expect(resolveStudyAnswer('St. Kitts', 'STKITTS')?.answer).toBe('KITTS');
  });

  it('does not rewrite a complete token using a longer definition word', () => {
    expect(
      resolveStudyAnswer(
        'cell',
        'CELL',
        'Cellular respiration happens in mitochondria.',
      )?.answer,
    ).toBe('CELL');
  });

  it('restores a clipped token when the definition has the complete capitalized form', () => {
    const display = expandClippedDisplay(
      'Mount Liam',
      'The highest peak is Mount Liamuiga on St. Kitts.',
    );
    expect(display).toMatch(/Liamuiga/i);
    expect(
      resolveStudyAnswer(
        'Mount Liam',
        'MOUNTLIAM',
        'The highest peak is Mount Liamuiga on St. Kitts.',
      )?.answer,
    ).toBe('LIAMUIGA');
  });

  it('drops meta crossword filler only when that filler is the whole term', () => {
    expect(resolveStudyAnswer('study', 'STUDY')).toBeNull();
    expect(resolveStudyAnswer('quiz', 'QUIZ')).toBeNull();
    expect(resolveStudyAnswer('whole note', 'NOTE')?.answer).toBe('NOTE');
    expect(resolveStudyAnswer('surface area', 'AREA')?.answer).toBe('AREA');
  });

  it('collapses the same label listed twice with a stub duplicate', () => {
    const terms = canonicalizeLlmTerms([
      llmTerm('chlorophyll', 'CHLOROPHYLL', 'Green pigment used in plants.'),
      llmTerm('chlorophyll', 'CHLOROPHY', 'Green pigment used in plants.'),
      llmTerm('T cell', 'TCELL', 'A lymphocyte that helps immune defense.'),
      llmTerm('T cell', 'CELL', 'A lymphocyte that helps immune defense.'),
      llmTerm('Cayon Beach', 'CAYONBEA', 'A coastal village on the island.'),
      llmTerm('Cayon Beach', 'CAYON', 'A coastal village on the island.'),
    ]);
    expect(terms.map((row) => row.answer)).toEqual([
      'CHLOROPHYLL',
      'CELL',
      'CAYON',
    ]);
  });

  it('keeps complete long names and drops 13+ letter leftovers', () => {
    const valid = validateLlmTerms([
      llmTerm(
        'chlorophyll',
        'CHLOROPHY',
        'Green pigment used by plants in light.',
      ),
      llmTerm('T cell', 'TCELL', 'A lymphocyte that helps immune defense.'),
      llmTerm(
        'photosynthesis',
        'PHOTOSYNTHESIS',
        'How plants turn light into food.',
      ),
      llmTerm('ribosome', 'RIBOSOME', 'The cell structure that builds proteins.'),
    ]);
    expect(valid.map((row) => row.answer)).toEqual(['CHLOROPHYLL', 'CELL', 'RIBOSOME']);
  });
});
