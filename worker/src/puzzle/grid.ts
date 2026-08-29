import type { GridCell, PuzzleAnswer, PuzzleDefinition } from './types';
import { normalizeWord } from './normalize';

export function buildEmptyGrid(puzzle: PuzzleDefinition): GridCell[] {
  const map = new Map<string, GridCell>();

  for (const answer of puzzle.answers) {
    const word = normalizeWord(answer.word);
    for (let i = 0; i < word.length; i += 1) {
      const row = answer.direction === 'horizontal' ? answer.row : answer.row + i;
      const column =
        answer.direction === 'horizontal' ? answer.column + i : answer.column;
      const key = `${row}:${column}`;
      const existing = map.get(key);
      const letter = word[i]!;
      if (existing && existing.letter !== letter) {
        throw new Error(
          `Invalid intersection at ${key}: ${existing.letter} vs ${letter}`,
        );
      }
      map.set(key, {
        row,
        column,
        letter,
        filled: false,
        revealed: false,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.row === b.row ? a.column - b.column : a.row - b.row,
  );
}

export function validatePuzzleGrid(puzzle: PuzzleDefinition): string | null {
  try {
    buildEmptyGrid(puzzle);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid puzzle grid';
  }
}
