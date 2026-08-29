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
export const TARGET_ANSWERS = 5;

export type ValidTerm = {
  stableKey: string;
  term: string;
  answer: string;
  definition: string;
  explanation?: string;
  category: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
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

export function validateLlmTerms(terms: LlmTerm[]): ValidTerm[] {
  const seen = new Set<string>();
  const valid: ValidTerm[] = [];
  for (const term of terms) {
    const answer = normalizeWord(term.answer);
    if (!isPlayableAnswer(answer) || seen.has(answer)) continue;
    if (definitionLeaksAnswer(term.definition, answer)) continue;
    if (isCircularDefinition(term.term, term.definition)) continue;
    if (
      containsFabricatedUrl(term.definition) ||
      containsFabricatedUrl(term.explanation ?? '')
    ) {
      continue;
    }
    seen.add(answer);
    valid.push({
      stableKey: answer.toLowerCase(),
      term: term.term.trim(),
      answer,
      definition: term.definition.trim(),
      explanation: term.explanation?.trim(),
      category: term.category.trim() || 'General',
      difficulty: term.difficulty as ValidTerm['difficulty'],
    });
  }
  return valid;
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

export function buildConnectedPuzzle(
  words: string[],
  puzzleId: number,
  packId: string,
  lessonId: string,
  seed: number,
): PuzzleDefinition | null {
  const minTarget = words.length <= 3 ? 2 : 3;
  let result = null;
  for (
    let target = Math.min(TARGET_ANSWERS, words.length);
    target >= minTarget && !result;
    target -= 1
  ) {
    result = generateConnectedCrossword({
      candidates: words,
      targetAnswerCount: target,
      random: seededRandom(seed + target * 101),
      allowDisconnected: false,
      maxWordSetAttempts: 16,
      maxLayoutsPerSet: 4,
      maxSearchNodes: 350,
    });
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
  const validation = validateCrosswordPuzzle(puzzle, { allowDisconnected: false });
  if (!validation.valid || validation.componentCount !== 1) return null;
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
  while (lessons.length < 30 && remaining.length >= 2 && stall < remaining.length) {
    const lessonId = `lesson_${lessons.length + 1}`;
    const puzzleContentId = `study_${packId}_${lessonId}`;
    const window = remaining.slice(0, 40).map((term) => term.answer);
    const puzzle = buildConnectedPuzzle(
      window,
      (stableHash(puzzleContentId) || 1) % 1_000_000_000,
      packId,
      lessonId,
      seed + lessons.length * 1009,
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
    if (usedTerms.length < 2) {
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
