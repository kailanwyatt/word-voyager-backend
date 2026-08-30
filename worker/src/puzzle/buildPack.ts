import { createHash } from 'node:crypto';
import type { LlmTerm } from '@word-voyage/contracts';
import {
  generateConnectedCrossword,
  placementsToAnswers,
  validateCrosswordPuzzle,
} from './crossword';
import { validatePuzzleGrid } from './grid';
import { normalizeWord } from './normalize';
import type { PuzzleDefinition } from './types';

export const MIN_ANSWER_LEN = 3;
export const MAX_ANSWER_LEN = 8;
export const TARGET_ANSWERS = 4;
/** Prefer enough lessons for a real study session when terms allow it. */
export const TARGET_LESSON_COUNT = 6;
export const MAX_LESSON_COUNT = 8;

export type ValidTerm = {
  stableKey: string;
  term: string;
  answer: string;
  definition: string;
  explanation?: string;
  category: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
};

export type TermRejection = {
  term: string;
  answer: string;
  reason:
    | 'too_short'
    | 'too_long'
    | 'duplicate'
    | 'leaks_answer'
    | 'circular'
    | 'fabricated_url'
    | 'empty';
};

export type TermValidationResult = {
  accepted: ValidTerm[];
  rejected: TermRejection[];
};

export type BuiltLesson = {
  id: string;
  title: string;
  category?: string;
  order: number;
  termIds: string[];
  terms: ValidTerm[];
  isPreview: boolean;
  puzzleContentId: string;
  puzzle: PuzzleDefinition;
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stableHash(text: string): number {
  const digest = createHash('sha256').update(text).digest();
  return digest.readUInt32BE(0);
}

export function isPlayableAnswer(answer: string): boolean {
  const normalized = normalizeWord(answer);
  return (
    normalized.length >= MIN_ANSWER_LEN && normalized.length <= MAX_ANSWER_LEN
  );
}

/**
 * Prefer crossword-friendly tokens from multi-word place names.
 * e.g. "St. Kitts" + STKITTS → STKITTS, KITTS.
 * Never silently truncate long names (Basseterre → BASSETER).
 */
export function derivePlayableAnswers(term: string, answer: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const lettersOnly = raw.replace(/[^a-zA-Z]/g, '');
    if (lettersOnly.length > MAX_ANSWER_LEN) return;
    const normalized = normalizeWord(raw);
    if (!isPlayableAnswer(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  const parts = term.split(/[\s/,.&+'’`-]+/).filter(Boolean);
  const fullTerm = normalizeWord(term);
  const normalizedAnswer = normalizeWord(answer);

  // Reject answers that are clearly truncations of a longer single-token label.
  const isTruncation =
    parts.length <= 1 &&
    fullTerm.length > MAX_ANSWER_LEN &&
    normalizedAnswer.length === MAX_ANSWER_LEN &&
    fullTerm.startsWith(normalizedAnswer);

  if (!isTruncation) {
    push(answer);
  }

  const skip = new Set(['ST', 'SAINT', 'THE', 'OF', 'AND', 'LA', 'LE', 'EL', 'DE']);
  const glued = normalizeWord(parts.join(''));
  // Only split multi-word labels when the answer is that glued compound.
  if (
    parts.length > 1 &&
    isPlayableAnswer(normalizedAnswer) &&
    (glued === normalizedAnswer || fullTerm === normalizedAnswer)
  ) {
    for (const part of parts) {
      if (skip.has(normalizeWord(part))) continue;
      push(part);
    }
  }

  return out;
}

export function definitionLeaksAnswer(
  definition: string,
  answer: string,
): boolean {
  const def = definition.toLowerCase();
  const ans = normalizeWord(answer).toLowerCase();
  if (ans.length < 3) return true;
  const pattern = new RegExp(`\\b${ans}\\b`, 'i');
  return pattern.test(def);
}

export function isCircularDefinition(term: string, definition: string): boolean {
  const t = term.trim().toLowerCase();
  const d = definition.trim().toLowerCase();
  return d === t || d.startsWith(`${t} is ${t}`) || d === `a ${t}` || d === `an ${t}`;
}

export function containsFabricatedUrl(text: string): boolean {
  return /https?:\/\/|www\./i.test(text);
}

export function validateLlmTermsDetailed(terms: LlmTerm[]): TermValidationResult {
  const seen = new Set<string>();
  const accepted: ValidTerm[] = [];
  const rejected: TermRejection[] = [];

  for (const term of terms) {
    const display = term.term.trim();
    const candidates = derivePlayableAnswers(display, term.answer);
    if (candidates.length === 0) {
      const normalized = normalizeWord(term.answer || display);
      let reason: TermRejection['reason'] = 'empty';
      if (normalized.length > 0 && normalized.length < MIN_ANSWER_LEN) {
        reason = 'too_short';
      } else if (normalized.length > MAX_ANSWER_LEN) {
        reason = 'too_long';
      }
      rejected.push({
        term: display || term.answer,
        answer: normalized || String(term.answer ?? ''),
        reason,
      });
      continue;
    }

    let acceptedOne = false;
    for (const answer of candidates) {
      if (seen.has(answer)) {
        if (!acceptedOne) {
          rejected.push({ term: display, answer, reason: 'duplicate' });
        }
        continue;
      }
      if (definitionLeaksAnswer(term.definition, answer)) {
        rejected.push({ term: display, answer, reason: 'leaks_answer' });
        continue;
      }
      if (isCircularDefinition(display || answer, term.definition)) {
        rejected.push({ term: display, answer, reason: 'circular' });
        continue;
      }
      if (
        containsFabricatedUrl(term.definition) ||
        containsFabricatedUrl(term.explanation ?? '')
      ) {
        rejected.push({ term: display, answer, reason: 'fabricated_url' });
        continue;
      }

      seen.add(answer);
      accepted.push({
        stableKey: answer.toLowerCase(),
        term: display || answer,
        answer,
        definition: term.definition.trim(),
        explanation: term.explanation?.trim(),
        category: term.category.trim() || 'General',
        difficulty: term.difficulty as ValidTerm['difficulty'],
      });
      acceptedOne = true;
      // One playable answer per LLM term keeps packs focused; extras from
      // the same multi-word label are only used when the primary was unusable.
      break;
    }
  }

  return { accepted, rejected };
}

export function validateLlmTerms(terms: LlmTerm[]): ValidTerm[] {
  return validateLlmTermsDetailed(terms).accepted;
}

function wheelLetters(words: readonly string[]): string[] {
  const maximumCounts = new Map<string, number>();
  for (const word of words) {
    const counts = new Map<string, number>();
    for (const letter of word) {
      counts.set(letter, (counts.get(letter) ?? 0) + 1);
    }
    for (const [letter, count] of counts) {
      maximumCounts.set(letter, Math.max(count, maximumCounts.get(letter) ?? 0));
    }
  }
  return [...maximumCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([letter, count]) => Array.from({ length: count }, () => letter));
}

function rotateLeft<T>(items: T[]): void {
  const first = items.shift();
  if (first != null) items.push(first);
}

function buildSingleWordPuzzle(
  word: string,
  puzzleId: number,
  packId: string,
  lessonId: string,
): PuzzleDefinition | null {
  const answer = normalizeWord(word);
  if (!isPlayableAnswer(answer)) return null;
  const puzzle: PuzzleDefinition = {
    id: puzzleId,
    worldId: 'study',
    regionId: 'study-pack',
    letters: wheelLetters([answer]),
    answers: [
      {
        word: answer,
        row: 0,
        column: 0,
        direction: 'horizontal',
      },
    ],
    difficulty: 1,
    starReward: 0,
    coinReward: 0,
    bonusWords: [],
    contentKind: 'study_lesson',
    studyLessonId: lessonId,
    studyPackId: packId,
  };
  const gridError = validatePuzzleGrid(puzzle);
  if (gridError) return null;
  return puzzle;
}

export function buildConnectedPuzzle(
  words: string[],
  puzzleId: number,
  packId: string,
  lessonId: string,
  seed: number,
  options?: { minAnswers?: number; allowSingleWord?: boolean },
): PuzzleDefinition | null {
  const unique = [...new Set(words.map((w) => normalizeWord(w)).filter(isPlayableAnswer))];
  const minAnswers = options?.minAnswers ?? 2;
  const allowSingleWord = options?.allowSingleWord === true;

  let result = null;
  for (
    let target = Math.min(TARGET_ANSWERS, unique.length);
    target >= minAnswers && !result;
    target -= 1
  ) {
    result = generateConnectedCrossword({
      candidates: unique,
      targetAnswerCount: target,
      random: seededRandom(seed + target * 101),
      allowDisconnected: false,
      maxWordSetAttempts: 24,
      maxLayoutsPerSet: 6,
      maxSearchNodes: 500,
    });
  }

  if (!result && allowSingleWord && unique.length >= 1) {
    return buildSingleWordPuzzle(unique[0]!, puzzleId, packId, lessonId);
  }
  if (!result) return null;

  const answers = placementsToAnswers(result.placements);
  const puzzle: PuzzleDefinition = {
    id: puzzleId,
    worldId: 'study',
    regionId: 'study-pack',
    letters: wheelLetters(answers.map((answer) => answer.word)),
    answers,
    difficulty: Math.max(1, Math.min(5, answers.length)),
    starReward: 0,
    coinReward: 0,
    bonusWords: [],
    contentKind: 'study_lesson',
    studyLessonId: lessonId,
    studyPackId: packId,
  };
  const gridError = validatePuzzleGrid(puzzle);
  if (gridError) return null;
  const validation = validateCrosswordPuzzle(puzzle, {
    allowDisconnected: answers.length < 2,
  });
  if (!validation.valid) return null;
  if (answers.length >= 2 && validation.componentCount !== 1) return null;
  return puzzle;
}

export function groupTermsIntoLessons(
  packId: string,
  terms: ValidTerm[],
  seed: number,
): BuiltLesson[] {
  const remaining = [...terms];
  const random = seededRandom(seed + 17);
  for (let i = remaining.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = remaining[i]!;
    remaining[i] = remaining[j]!;
    remaining[j] = tmp;
  }

  const lessons: BuiltLesson[] = [];
  let stall = 0;
  // Prefer smaller connected grids so we can emit several lessons from one term set.
  while (
    lessons.length < MAX_LESSON_COUNT &&
    remaining.length >= 1 &&
    stall < remaining.length + 2
  ) {
    const lessonId = `lesson_${lessons.length + 1}`;
    const puzzleContentId = `study_${packId}_${lessonId}`;
    const window = remaining.slice(0, 40).map((term) => term.answer);
    // Prefer pairs+; only fall back to single-word when stuck so packs are not empty.
    const allowSingleWord = remaining.length === 1 || stall >= remaining.length;

    const puzzle = buildConnectedPuzzle(
      window,
      (stableHash(puzzleContentId) || 1) % 1_000_000_000,
      packId,
      lessonId,
      seed + lessons.length * 1009,
      {
        minAnswers: remaining.length >= 2 ? 2 : 1,
        allowSingleWord,
      },
    );
    if (!puzzle) {
      rotateLeft(remaining);
      stall += 1;
      continue;
    }

    const usedAnswers = new Set(
      puzzle.answers.map((answer) => normalizeWord(answer.word)),
    );
    const usedTerms = remaining.filter((term) => usedAnswers.has(term.answer));
    if (usedTerms.length < 1) {
      rotateLeft(remaining);
      stall += 1;
      continue;
    }
    // Prefer multi-word lessons; only accept singles as a last resort.
    if (usedTerms.length < 2 && !allowSingleWord) {
      rotateLeft(remaining);
      stall += 1;
      continue;
    }

    stall = 0;
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (usedAnswers.has(remaining[i]!.answer)) remaining.splice(i, 1);
    }

    const order = lessons.length;
    lessons.push({
      id: lessonId,
      title: `Puzzle ${order + 1}`,
      category: usedTerms[0]?.category,
      order,
      termIds: usedTerms.map((term) => term.stableKey),
      terms: usedTerms,
      isPreview: order === 0,
      puzzleContentId,
      puzzle: {
        ...puzzle,
        studyLessonId: lessonId,
        studyPackId: packId,
      },
    });
  }
  return lessons;
}
