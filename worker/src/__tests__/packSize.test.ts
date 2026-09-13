import { describe, expect, it } from 'vitest';
import type { LlmPack } from '@word-voyage/contracts';
import {
  countByBand,
  hasPaidBandCoverage,
  mergeBandPacks,
  assignBandDifficulty,
  appendUniqueTerms,
  shouldExpandBand,
} from '../ai/packSize';

function term(
  answer: string,
  difficulty: number,
): LlmPack['terms'][number] {
  return {
    term: answer,
    answer,
    definition: 'A sufficiently detailed educational definition.',
    category: 'Landmarks',
    difficulty,
  };
}

function pack(terms: LlmPack['terms']): LlmPack {
  return {
    title: 'Landmarks',
    description: 'A paid study pack about landmarks.',
    language: 'en',
    terms,
  };
}

describe('paid pack size', () => {
  it('merges bands without repeating answers', () => {
    const merged = mergeBandPacks([
      pack([term('NEVIS', 1), term('KITTS', 2)]),
      pack([term('NEVIS', 3), term('FORT', 3)]),
      pack([term('VOLCANO', 5)]),
    ]);
    expect(merged.terms.map((row) => row.answer)).toEqual([
      'NEVIS',
      'KITTS',
      'FORT',
      'VOLCANO',
    ]);
  });

  it('requires a full Easy, Medium, and Hard word set', () => {
    const easy = Array.from({ length: 12 }, (_, i) =>
      term(`EASY${String.fromCharCode(65 + i)}`, 1),
    );
    const medium = Array.from({ length: 12 }, (_, i) =>
      term(`MID${String.fromCharCode(65 + i)}X`, 3),
    );
    const hard = Array.from({ length: 12 }, (_, i) =>
      term(`HARD${String.fromCharCode(65 + i)}`, 5),
    );
    expect(countByBand([...easy, ...medium, ...hard])).toEqual({
      easy: 12,
      medium: 12,
      hard: 12,
    });
    expect(hasPaidBandCoverage([...easy, ...medium, ...hard])).toBe(true);
    expect(hasPaidBandCoverage([...easy, ...medium])).toBe(false);
  });

  it('pins each band to Easy, Medium, or Hard even if the model mislabels', () => {
    const pinned = assignBandDifficulty(
      [term('NEVIS', 5), term('REEF', 3)],
      'easy',
    );
    expect(pinned.map((row) => row.difficulty)).toEqual([2, 1]);
  });

  it('grows a band toward 60 unique words and stops when the topic runs out', () => {
    const first = appendUniqueTerms(
      [],
      [term('NEVIS', 1), term('KITTS', 2)],
    );
    const grown = appendUniqueTerms(first, [
      term('NEVIS', 1),
      term('FORT', 2),
      term('REEF', 1),
    ]);
    expect(grown.map((row) => row.answer)).toEqual([
      'NEVIS',
      'KITTS',
      'FORT',
      'REEF',
    ]);
    const withoutDupLandmark = appendUniqueTerms(
      [{ ...term('CELL', 1), term: 'T cell' }],
      [{ ...term('BLOOD', 2), term: 'T cell' }],
    );
    expect(withoutDupLandmark.map((row) => row.answer)).toEqual(['CELL']);
    expect(shouldExpandBand(22, 20)).toBe(true);
    expect(shouldExpandBand(60, 20)).toBe(false);
    expect(shouldExpandBand(40, 5)).toBe(false);
  });
});
