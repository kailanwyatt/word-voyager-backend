import {
  STUDY_BAND_EXPAND_MIN,
  STUDY_PACK_TERM_MIN,
  STUDY_TERMS_PER_BAND_FLOOR,
  STUDY_TERMS_PER_BAND_TARGET,
  type LlmPack,
  type LlmTerm,
} from '@word-voyage/contracts';

export type DifficultyBand = 'easy' | 'medium' | 'hard';

export function difficultyBand(level: number): DifficultyBand {
  if (level <= 2) return 'easy';
  if (level <= 3) return 'medium';
  return 'hard';
}

export function countByBand(
  terms: readonly { difficulty: number }[],
): Record<DifficultyBand, number> {
  const counts: Record<DifficultyBand, number> = {
    easy: 0,
    medium: 0,
    hard: 0,
  };
  for (const term of terms) {
    counts[difficultyBand(term.difficulty)] += 1;
  }
  return counts;
}

export function assignBandDifficulty(
  terms: readonly LlmTerm[],
  band: DifficultyBand,
): LlmTerm[] {
  return terms.map((term) => {
    const len = term.answer.length;
    if (band === 'easy') {
      return { ...term, difficulty: len <= 4 ? 1 : 2 };
    }
    if (band === 'medium') {
      return { ...term, difficulty: 3 };
    }
    return { ...term, difficulty: len <= 7 ? 4 : 5 };
  });
}

export function appendUniqueTerms(
  existing: readonly LlmTerm[],
  incoming: readonly LlmTerm[],
  cap = STUDY_TERMS_PER_BAND_TARGET,
): LlmTerm[] {
  const seen = new Set(existing.map((term) => term.answer.toUpperCase()));
  const terms = [...existing];
  for (const term of incoming) {
    const answer = term.answer.toUpperCase();
    if (seen.has(answer)) continue;
    seen.add(answer);
    terms.push({ ...term, answer });
    if (terms.length >= cap) break;
  }
  return terms;
}

export function shouldExpandBand(currentCount: number, addedCount: number): boolean {
  return (
    currentCount < STUDY_TERMS_PER_BAND_TARGET &&
    addedCount >= STUDY_BAND_EXPAND_MIN
  );
}

export function mergeBandPacks(packs: readonly LlmPack[]): LlmPack {
  const seen = new Set<string>();
  const terms: LlmTerm[] = [];
  for (const pack of packs) {
    for (const term of pack.terms) {
      const answer = term.answer.toUpperCase();
      if (seen.has(answer)) continue;
      seen.add(answer);
      terms.push(term);
    }
  }
  const first = packs[0];
  return {
    title: first?.title ?? 'Study Pack',
    description: first?.description ?? 'Generated study terms.',
    language: 'en',
    terms,
  };
}

export function hasPaidBandCoverage(
  terms: readonly { difficulty: number }[],
): boolean {
  if (terms.length < STUDY_PACK_TERM_MIN) return false;
  const counts = countByBand(terms);
  return (
    counts.easy >= STUDY_TERMS_PER_BAND_FLOOR &&
    counts.medium >= STUDY_TERMS_PER_BAND_FLOOR &&
    counts.hard >= STUDY_TERMS_PER_BAND_FLOOR
  );
}
