import type { LlmTerm } from '@word-voyage/contracts';
import { normalizeWord } from '../puzzle/normalize';

export const MIN_STUDY_ANSWER_LEN = 3;
export const MAX_STUDY_ANSWER_LEN = 12;
export const MAX_CROSSWORD_ANSWER_LEN = 8;

/**
 * Crossword-padding words that are not a subject. Drop only when the
 * display label *is* that word, not when it appears inside a real term
 * ("whole note", "surface area").
 */
const META_FILLER = new Set([
  'AREA',
  'UNIT',
  'BASIC',
  'LEARN',
  'STUDY',
  'WORD',
  'TEST',
  'QUIZ',
  'LEVEL',
  'SKILL',
  'TOPIC',
  'IDEA',
  'FACT',
  'NOTE',
  'BOOK',
  'CLASS',
  'WATER',
  'EARTH',
  'PLACE',
  'NAME',
  'GROUP',
]);

export function letterKey(raw: string): string {
  return normalizeWord(raw);
}

export function displayTokens(term: string): string[] {
  return term
    .split(/[\s/,.&+.`-]+/)
    .map((part) => letterKey(part))
    .filter((part) => part.length >= MIN_STUDY_ANSWER_LEN);
}

export type ResolvedStudyTerm = {
  term: string;
  answer: string;
};

function inRange(word: string): boolean {
  return (
    word.length >= MIN_STUDY_ANSWER_LEN && word.length <= MAX_STUDY_ANSWER_LEN
  );
}

function isMetaFillerAnswer(answer: string, display: string): boolean {
  if (!META_FILLER.has(answer)) return false;
  const tokens = displayTokens(display);
  const full = letterKey(display);
  return full === answer || (tokens.length === 1 && tokens[0] === answer);
}

function capitalizedDefinitionWords(definition: string): string[] {
  return (definition.match(/\b[A-Z][a-zA-Z]{3,}\b/g) ?? []).map((word) =>
    letterKey(word),
  );
}

/**
 * If a short token in a multi-word label is a prefix of a longer
 * capitalized word in the definition, restore that complete word.
 * Does not run on a complete token the learner already typed (CELL stays CELL).
 */
export function expandClippedDisplay(term: string, definition?: string): string {
  if (!definition) return term;
  const longerNames = capitalizedDefinitionWords(definition).filter(
    (word) => word.length >= 7,
  );
  if (longerNames.length === 0) return term;
  return term.replace(/[A-Za-z]+/g, (word) => {
    const key = letterKey(word);
    if (key.length < 3 || key.length > 5) return word;
    const restored = longerNames.find(
      (name) => name.length >= key.length + 3 && name.startsWith(key),
    );
    if (!restored) return word;
    return restored.charAt(0) + restored.slice(1).toLowerCase();
  });
}

function isCompleteToken(proposed: string, tokens: readonly string[]): boolean {
  return inRange(proposed) && tokens.includes(proposed);
}

function isCompleteGlue(
  proposed: string,
  tokens: readonly string[],
  full: string,
): boolean {
  return (
    inRange(proposed) &&
    proposed === full &&
    tokens.length > 1 &&
    tokens.join('') === full
  );
}

/** T-cell / St. Kitts: a 1–2 letter particle glued onto one real word. */
function particleGlueToken(
  proposed: string,
  tokens: readonly string[],
  full: string,
): string | null {
  if (proposed !== full || tokens.length !== 1) return null;
  const token = tokens[0]!;
  if (token === full || !inRange(token)) return null;
  return token;
}

function repairFromDisplay(
  tokens: readonly string[],
  full: string,
  proposed: string,
): string | null {
  if (tokens.length === 1 && inRange(tokens[0]!)) return tokens[0]!;
  const playable = tokens.filter(inRange);
  const crossword = playable.filter(
    (word) => word.length <= MAX_CROSSWORD_ANSWER_LEN,
  );
  const pool = crossword.length > 0 ? crossword : playable;
  if (pool.length === 0) return inRange(full) ? full : null;

  const maxLen = Math.max(...pool.map((word) => word.length));
  const longest = pool.filter((word) => word.length === maxLen);
  if (longest.length === 1) return longest[0]!;

  const aligned = longest.filter(
    (word) => proposed.startsWith(word) || word.startsWith(proposed),
  );
  if (aligned.length > 0) return aligned[0]!;
  return longest[0]!;
}

function accept(
  display: string,
  answer: string,
): ResolvedStudyTerm | null {
  if (!inRange(answer) || isMetaFillerAnswer(answer, display)) return null;
  return { term: display, answer };
}

/**
 * Paid packs keep answers a learner would type: a complete word from the
 * display label, or the complete letter-stripped name with no letters
 * dropped. Truncated prefixes are repaired from the display; invented
 * topic lists do not belong here.
 */
export function resolveStudyAnswer(
  term: string,
  answer: string,
  definition?: string,
): ResolvedStudyTerm | null {
  const original = term.trim();
  if (!original) return null;
  const proposed = letterKey(answer);
  let display = original;
  let tokens = displayTokens(display);
  let full = letterKey(display);

  if (isCompleteToken(proposed, tokens)) {
    return accept(display, proposed);
  }

  if (!isCompleteToken(proposed, tokens)) {
    display = expandClippedDisplay(original, definition);
    tokens = displayTokens(display);
    full = letterKey(display);
  }

  if (isCompleteToken(proposed, tokens)) {
    return accept(display, proposed);
  }

  const particle = particleGlueToken(proposed, tokens, full);
  if (particle) return accept(display, particle);

  if (isCompleteGlue(proposed, tokens, full)) {
    return accept(display, proposed);
  }

  const repaired = repairFromDisplay(tokens, full, proposed);
  if (!repaired) return null;
  return accept(display, repaired);
}

export function canonicalizeLlmTerms(terms: readonly LlmTerm[]): LlmTerm[] {
  const seenAnswers = new Set<string>();
  const seenEntities = new Set<string>();
  const out: LlmTerm[] = [];
  for (const term of terms) {
    const resolved = resolveStudyAnswer(term.term, term.answer, term.definition);
    if (!resolved) continue;
    if (seenAnswers.has(resolved.answer)) continue;
    const entity = letterKey(resolved.term);
    if (entity && seenEntities.has(entity)) continue;
    seenAnswers.add(resolved.answer);
    if (entity) seenEntities.add(entity);
    out.push({
      ...term,
      term: resolved.term,
      answer: resolved.answer,
    });
  }
  return out;
}
