import type { PuzzleAnswer, PuzzleDefinition, WordDirection } from './types';
import { normalizeWord } from './normalize';

export type PuzzleQuality = 'poor' | 'acceptable' | 'good' | 'excellent';

export interface PlacedWord {
  word: string;
  row: number;
  column: number;
  direction: WordDirection;
}

export interface CrosswordValidationResult {
  valid: boolean;
  errors: string[];
  intersectionCount: number;
  componentCount: number;
  quality: PuzzleQuality;
  score: number;
  width: number;
  height: number;
}

export interface GenerateCrosswordOptions {
  /** Candidate dictionary words formable from the wheel. */
  candidates: string[];
  /** Preferred number of required answers (2–5). */
  targetAnswerCount?: number;
  /** Seeded RNG in [0,1). */
  random?: () => number;
  /** Allow disconnected components (default false). */
  allowDisconnected?: boolean;
  /** Max backtracking nodes explored per word-set attempt. */
  maxSearchNodes?: number;
  /** Max word-set subsets to try. */
  maxWordSetAttempts?: number;
  /** Max layouts scored per successful word set. */
  maxLayoutsPerSet?: number;
  /** Log debug tables in development. */
  debug?: boolean;
  /** 3+ letter answers to avoid when picking a subset. */
  excludeWords?: ReadonlySet<string>;
}

export interface GenerateCrosswordResult {
  placements: PlacedWord[];
  validation: CrosswordValidationResult;
  attempts: number;
}

type CellKey = string;

function key(row: number, column: number): CellKey {
  return `${row}:${column}`;
}

function cellsOf(placement: PlacedWord): { row: number; column: number; letter: string }[] {
  const word = normalizeWord(placement.word);
  return Array.from({ length: word.length }, (_, i) => ({
    row: placement.direction === 'horizontal' ? placement.row : placement.row + i,
    column:
      placement.direction === 'horizontal' ? placement.column + i : placement.column,
    letter: word[i]!,
  }));
}

/** Shared-letter potential between two words (for subset selection). */
export function intersectionPotential(wordA: string, wordB: string): number {
  const a = normalizeWord(wordA);
  const b = normalizeWord(wordB);
  if (a === b) return 0;
  let score = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (a[i] !== b[j]) continue;
      score += 3;
      const aInternal = i > 0 && i < a.length - 1;
      const bInternal = j > 0 && j < b.length - 1;
      if (aInternal || bInternal) score += 2;
    }
  }
  if (a.length >= 4) score += 1;
  if (b.length >= 4) score += 1;
  if (score > 0 && score < 5) score -= 2;
  return Math.max(0, score);
}

function sharedLetterPairs(wordA: string, wordB: string): { ai: number; bi: number }[] {
  const a = normalizeWord(wordA);
  const b = normalizeWord(wordB);
  const pairs: { ai: number; bi: number }[] = [];
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      if (a[i] === b[j]) pairs.push({ ai: i, bi: j });
    }
  }
  return pairs;
}

/** Graph connectivity via shared cells (true intersections). */
export function isFullyConnected(placements: PlacedWord[]): boolean {
  if (placements.length <= 1) return true;
  const cellOwners = new Map<CellKey, number[]>();
  placements.forEach((p, index) => {
    for (const cell of cellsOf(p)) {
      const k = key(cell.row, cell.column);
      const list = cellOwners.get(k) ?? [];
      list.push(index);
      cellOwners.set(k, list);
    }
  });

  const adj: number[][] = Array.from({ length: placements.length }, () => []);
  for (const owners of cellOwners.values()) {
    if (owners.length < 2) continue;
    for (let i = 0; i < owners.length; i += 1) {
      for (let j = i + 1; j < owners.length; j += 1) {
        const a = owners[i]!;
        const b = owners[j]!;
        adj[a]!.push(b);
        adj[b]!.push(a);
      }
    }
  }

  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of adj[cur]!) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen.size === placements.length;
}

export function countIntersections(placements: PlacedWord[]): number {
  const cellCounts = new Map<CellKey, number>();
  for (const p of placements) {
    for (const cell of cellsOf(p)) {
      const k = key(cell.row, cell.column);
      cellCounts.set(k, (cellCounts.get(k) ?? 0) + 1);
    }
  }
  let intersections = 0;
  for (const count of cellCounts.values()) {
    if (count >= 2) intersections += 1;
  }
  return intersections;
}

function componentCount(placements: PlacedWord[]): number {
  if (placements.length === 0) return 0;
  const cellOwners = new Map<CellKey, number[]>();
  placements.forEach((p, index) => {
    for (const cell of cellsOf(p)) {
      const k = key(cell.row, cell.column);
      const list = cellOwners.get(k) ?? [];
      list.push(index);
      cellOwners.set(k, list);
    }
  });
  const adj: number[][] = Array.from({ length: placements.length }, () => []);
  for (const owners of cellOwners.values()) {
    if (owners.length < 2) continue;
    for (let i = 0; i < owners.length; i += 1) {
      for (let j = i + 1; j < owners.length; j += 1) {
        adj[owners[i]!]!.push(owners[j]!);
        adj[owners[j]!]!.push(owners[i]!);
      }
    }
  }
  const seen = new Set<number>();
  let components = 0;
  for (let i = 0; i < placements.length; i += 1) {
    if (seen.has(i)) continue;
    components += 1;
    const queue = [i];
    seen.add(i);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of adj[cur]!) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return components;
}

function boundingBox(placements: PlacedWord[]) {
  let minRow = Infinity;
  let maxRow = -Infinity;
  let minCol = Infinity;
  let maxCol = -Infinity;
  for (const p of placements) {
    for (const cell of cellsOf(p)) {
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minCol = Math.min(minCol, cell.column);
      maxCol = Math.max(maxCol, cell.column);
    }
  }
  if (!Number.isFinite(minRow)) {
    return { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0, width: 0, height: 0 };
  }
  return {
    minRow,
    maxRow,
    minCol,
    maxCol,
    width: maxCol - minCol + 1,
    height: maxRow - minRow + 1,
  };
}

export function normalizePlacements(placements: PlacedWord[]): PlacedWord[] {
  const box = boundingBox(placements);
  return placements.map((p) => ({
    ...p,
    word: normalizeWord(p.word),
    row: p.row - box.minRow,
    column: p.column - box.minCol,
  }));
}

function minIntersectionsForCount(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  if (n === 3) return 2;
  if (n === 4) return 3;
  return Math.max(4, n - 1);
}

/** Detect illegal parallel adjacency (stacked rows/cols without shared cells). */
export function hasIllegalAdjacency(placements: PlacedWord[]): string | null {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i]!;
      const b = placements[j]!;
      if (a.direction !== b.direction) continue;

      const aCells = cellsOf(a);
      const bCells = cellsOf(b);
      const aKeys = new Set(aCells.map((c) => key(c.row, c.column)));
      const shares = bCells.some((c) => aKeys.has(key(c.row, c.column)));
      if (shares) continue;

      if (a.direction === 'horizontal') {
        if (Math.abs(a.row - b.row) !== 1) continue;
        const aCols = new Set(aCells.map((c) => c.column));
        const overlap = bCells.filter((c) => aCols.has(c.column)).length;
        if (overlap >= 2) {
          return `${a.word} and ${b.word} are adjacent but do not intersect`;
        }
      } else {
        if (Math.abs(a.column - b.column) !== 1) continue;
        const aRows = new Set(aCells.map((c) => c.row));
        const overlap = bCells.filter((c) => aRows.has(c.row)).length;
        if (overlap >= 2) {
          return `${a.word} and ${b.word} are adjacent but do not intersect`;
        }
      }
    }
  }
  return null;
}

export function scoreLayout(placements: PlacedWord[]): number {
  if (placements.length === 0) return -1000;
  const intersections = countIntersections(placements);
  const connected = isFullyConnected(placements);
  const box = boundingBox(placements);
  const area = box.width * box.height;

  let score = 0;
  score += intersections * 20;
  if (connected) score += 15;

  // Per-word intersection degree
  const cellOwners = new Map<CellKey, number[]>();
  placements.forEach((p, index) => {
    for (const cell of cellsOf(p)) {
      const k = key(cell.row, cell.column);
      const list = cellOwners.get(k) ?? [];
      list.push(index);
      cellOwners.set(k, list);
    }
  });
  const degree = Array.from({ length: placements.length }, () => 0);
  for (const owners of cellOwners.values()) {
    if (owners.length < 2) continue;
    for (const o of owners) degree[o]! += 1;
  }
  for (const d of degree) {
    if (d >= 2) score += 10;
    else if (d === 1) score -= 2; // leaves are normal in compact crosswords
    else score -= 12;
  }

  score += placements.length * 8;

  score -= Math.max(0, box.width - 8) * 5;
  score -= Math.max(0, box.height - 8) * 5;
  score -= Math.max(0, area - placements.join('').length) * 0.5;

  // Empty cells inside bounding box
  const occupied = new Set<CellKey>();
  for (const p of placements) {
    for (const cell of cellsOf(p)) occupied.add(key(cell.row, cell.column));
  }
  const empty = area - occupied.size;
  score -= empty * 3;

  if (!connected) score -= 50;
  return score;
}

export function qualityFromScore(
  score: number,
  placements: PlacedWord[],
): PuzzleQuality {
  const connected = isFullyConnected(placements);
  const intersections = countIntersections(placements);
  const minIx = minIntersectionsForCount(placements.length);
  if (!connected || intersections < minIx) return 'poor';
  if (score >= 70) return 'excellent';
  if (score >= 35) return 'good';
  if (score >= 15) return 'acceptable';
  return 'poor';
}

export function validateCrosswordPuzzle(
  puzzle: Pick<PuzzleDefinition, 'letters' | 'answers'>,
  options: { allowDisconnected?: boolean } = {},
): CrosswordValidationResult {
  const allowDisconnected = options.allowDisconnected === true;
  const errors: string[] = [];
  const placements: PlacedWord[] = puzzle.answers.map((a) => ({
    word: normalizeWord(a.word),
    row: a.row,
    column: a.column,
    direction: a.direction,
  }));

  if (placements.length === 0) {
    errors.push('No answers');
  }

  const seenWords = new Set<string>();
  for (const p of placements) {
    if (seenWords.has(p.word)) errors.push(`Duplicate answer ${p.word}`);
    seenWords.add(p.word);
    if (!Number.isFinite(p.row) || !Number.isFinite(p.column)) {
      errors.push(`Invalid coordinates for ${p.word}`);
    }
  }

  // Letter conflicts
  const grid = new Map<CellKey, string>();
  for (const p of placements) {
    for (const cell of cellsOf(p)) {
      const k = key(cell.row, cell.column);
      const existing = grid.get(k);
      if (existing && existing !== cell.letter) {
        errors.push(
          `Letter conflict at ${k}: ${existing} vs ${cell.letter}`,
        );
      }
      grid.set(k, cell.letter);
    }
  }

  const adjacencyError = hasIllegalAdjacency(placements);
  if (adjacencyError) errors.push(adjacencyError);

  const comps = componentCount(placements);
  if (!allowDisconnected && placements.length > 1 && comps !== 1) {
    errors.push(`${comps} connected components (expected 1)`);
  }

  const intersections = countIntersections(placements);
  const minIx = minIntersectionsForCount(placements.length);
  if (!allowDisconnected && intersections < minIx) {
    errors.push(
      `Only ${intersections} intersections; need at least ${minIx} for ${placements.length} words`,
    );
  }

  // Every non-root word should share a cell with some other word when connected required
  if (!allowDisconnected && placements.length > 1) {
    for (let i = 0; i < placements.length; i += 1) {
      const p = placements[i]!;
      const keys = new Set(cellsOf(p).map((c) => key(c.row, c.column)));
      let linked = false;
      for (let j = 0; j < placements.length; j += 1) {
        if (i === j) continue;
        if (cellsOf(placements[j]!).some((c) => keys.has(key(c.row, c.column)))) {
          linked = true;
          break;
        }
      }
      if (!linked) {
        errors.push(`${p.word} belongs to disconnected component`);
      }
    }
  }

  const box = boundingBox(placements);
  if (box.width > 12 || box.height > 12) {
    errors.push(`Bounding box too large (${box.width}x${box.height})`);
  }

  const score = scoreLayout(placements);
  const quality = qualityFromScore(score, placements);
  if (!allowDisconnected && (quality === 'poor' || quality === 'acceptable')) {
    // still mark invalid for campaign bar when structural errors exist;
    // quality alone doesn't force invalid if structure is ok — campaign filter uses quality separately
  }

  return {
    valid: errors.length === 0,
    errors,
    intersectionCount: intersections,
    componentCount: comps,
    quality,
    score,
    width: box.width,
    height: box.height,
  };
}

class MutableGrid {
  private cells = new Map<CellKey, string>();
  private refCount = new Map<CellKey, number>();

  get(row: number, column: number): string | undefined {
    return this.cells.get(key(row, column));
  }

  canPlace(placement: PlacedWord): boolean {
    const word = normalizeWord(placement.word);
    const cells = cellsOf(placement);
    let crosses = 0;

    // Start/end clearance
    if (placement.direction === 'horizontal') {
      const before = this.get(placement.row, placement.column - 1);
      const after = this.get(placement.row, placement.column + word.length);
      if (before || after) return false;
    } else {
      const before = this.get(placement.row - 1, placement.column);
      const after = this.get(placement.row + word.length, placement.column);
      if (before || after) return false;
    }

    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i]!;
      const existing = this.get(cell.row, cell.column);
      if (existing && existing !== cell.letter) return false;
      if (existing && existing === cell.letter) crosses += 1;

      // Side adjacency for non-crossing letters
      if (!existing) {
        if (placement.direction === 'horizontal') {
          if (this.get(cell.row - 1, cell.column)) return false;
          if (this.get(cell.row + 1, cell.column)) return false;
        } else {
          if (this.get(cell.row, cell.column - 1)) return false;
          if (this.get(cell.row, cell.column + 1)) return false;
        }
      }
    }

    // First word may place freely; later words must cross at least once
    return true;
  }

  apply(placement: PlacedWord): void {
    for (const cell of cellsOf(placement)) {
      const k = key(cell.row, cell.column);
      this.cells.set(k, cell.letter);
      this.refCount.set(k, (this.refCount.get(k) ?? 0) + 1);
    }
  }

  undo(placement: PlacedWord): void {
    for (const cell of cellsOf(placement)) {
      const k = key(cell.row, cell.column);
      const next = (this.refCount.get(k) ?? 1) - 1;
      if (next <= 0) {
        this.refCount.delete(k);
        this.cells.delete(k);
      } else {
        this.refCount.set(k, next);
      }
    }
  }
}

function getCandidatePlacements(
  word: string,
  placed: PlacedWord[],
  grid: MutableGrid,
): PlacedWord[] {
  const w = normalizeWord(word);
  const candidates: PlacedWord[] = [];

  if (placed.length === 0) {
    return [
      { word: w, row: 0, column: 0, direction: 'horizontal' },
      { word: w, row: 0, column: 0, direction: 'vertical' },
    ];
  }

  for (const existing of placed) {
    const pairs = sharedLetterPairs(w, existing.word);
    for (const { ai, bi } of pairs) {
      const existingCells = cellsOf(existing);
      const anchor = existingCells[bi]!;
      const direction: WordDirection =
        existing.direction === 'horizontal' ? 'vertical' : 'horizontal';
      const row =
        direction === 'vertical' ? anchor.row - ai : anchor.row;
      const column =
        direction === 'horizontal' ? anchor.column - ai : anchor.column;
      const candidate: PlacedWord = { word: w, row, column, direction };
      if (grid.canPlace(candidate)) {
        // Must actually cross at least one occupied cell
        const crosses = cellsOf(candidate).some(
          (c) => grid.get(c.row, c.column) === c.letter,
        );
        if (crosses) candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function chooseNextWord(
  remaining: string[],
  placed: PlacedWord[],
): string {
  if (placed.length === 0) {
    return [...remaining].sort(
      (a, b) => b.length - a.length || a.localeCompare(b),
    )[0]!;
  }
  let best = remaining[0]!;
  let bestScore = -1;
  for (const word of remaining) {
    let score = 0;
    for (const p of placed) {
      score += intersectionPotential(word, p.word);
    }
    score += word.length;
    if (score > bestScore) {
      bestScore = score;
      best = word;
    }
  }
  return best;
}

function placeWordsBacktrack(
  remaining: string[],
  grid: MutableGrid,
  placements: PlacedWord[],
  state: { nodes: number; maxNodes: number },
): PlacedWord[] | null {
  if (state.nodes > state.maxNodes) return null;
  state.nodes += 1;

  if (remaining.length === 0) {
    return placements.length > 0 ? [...placements] : null;
  }

  const word = chooseNextWord(remaining, placements);
  const rest = remaining.filter((w) => w !== word);
  let candidates = getCandidatePlacements(word, placements, grid);

  // Rank: more crossings with existing grid first, then compactness
  candidates = candidates
    .map((c) => {
      const crosses = cellsOf(c).filter(
        (cell) => grid.get(cell.row, cell.column) === cell.letter,
      ).length;
      return { c, crosses };
    })
    .sort((a, b) => b.crosses - a.crosses)
    .map((x) => x.c)
    .slice(0, 10);

  for (const candidate of candidates) {
    grid.apply(candidate);
    placements.push(candidate);
    const result = placeWordsBacktrack(rest, grid, placements, state);
    if (result) return result;
    placements.pop();
    grid.undo(candidate);
  }

  return null;
}

/** Select a high-connectivity answer subset from candidates. */
export function selectAnswerSubset(
  candidates: string[],
  targetCount: number,
  random: () => number,
  excludeWords: ReadonlySet<string> = new Set(),
): string[] {
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const raw of candidates) {
    const word = normalizeWord(raw);
    if (word.length < 2 || seen.has(word)) continue;
    seen.add(word);
    pool.push(word);
  }

  if (pool.length === 0) return [];
  if (pool.length <= targetCount) return pool;

  const orderIndex = new Map(pool.map((word, index) => [word, index]));

  // Score each word by total intersection potential with others
  const connectivity = new Map<string, number>();
  for (const word of pool) {
    let total = 0;
    for (const other of pool) {
      if (word === other) continue;
      total += intersectionPotential(word, other);
    }
    connectivity.set(word, total + word.length * 2);
  }

  const ranked = [...pool].sort((a, b) => {
    const connectivityDelta =
      (connectivity.get(b) ?? 0) - (connectivity.get(a) ?? 0);
    const excludeDelta =
      (excludeWords.has(a) ? 40 : 0) - (excludeWords.has(b) ? 40 : 0);
    if (connectivityDelta + excludeDelta !== 0) {
      return connectivityDelta + excludeDelta;
    }
    return (orderIndex.get(a) ?? 0) - (orderIndex.get(b) ?? 0);
  });

  // Seeded jitter: pick among top candidates with slight randomness
  const top = ranked.slice(0, Math.min(ranked.length, targetCount + 6));
  const selected: string[] = [];
  const available = [...top];
  while (selected.length < targetCount && available.length > 0) {
    // Prefer words that connect well to already selected
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < available.length; i += 1) {
      const word = available[i]!;
      let score = connectivity.get(word) ?? 0;
      for (const s of selected) score += intersectionPotential(word, s) * 2;
      score += random() * 4;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(available.splice(bestIdx, 1)[0]!);
  }

  // Ensure selected set has pairwise connectivity potential
  const totalPotential = selected.reduce((sum, a, i) => {
    for (let j = i + 1; j < selected.length; j += 1) {
      sum += intersectionPotential(a, selected[j]!);
    }
    return sum;
  }, 0);
  if (selected.length >= 2 && totalPotential <= 0) {
    // Fall back to longest connected pair + fillers from ranked
    return ranked.slice(0, targetCount);
  }

  return selected;
}

export function generateConnectedCrossword(
  options: GenerateCrosswordOptions,
): GenerateCrosswordResult | null {
  const random = options.random ?? Math.random;
  const allowDisconnected = options.allowDisconnected === true;
  const targetCount = Math.max(
    2,
    Math.min(5, options.targetAnswerCount ?? 3),
  );
  const maxWordSetAttempts = options.maxWordSetAttempts ?? 20;
  const maxLayoutsPerSet = options.maxLayoutsPerSet ?? 4;
  const maxSearchNodes = options.maxSearchNodes ?? 400;

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const raw of options.candidates) {
    const word = normalizeWord(raw);
    if (word.length < 2 || seen.has(word)) continue;
    seen.add(word);
    candidates.push(word);
    if (candidates.length >= 40) break;
  }

  if (candidates.length < 2 && !allowDisconnected) {
    return null;
  }

  let attempts = 0;
  let best: { placements: PlacedWord[]; validation: CrosswordValidationResult } | null =
    null;

  for (let setAttempt = 0; setAttempt < maxWordSetAttempts; setAttempt += 1) {
    attempts += 1;
    const subset =
      candidates.length <= targetCount
        ? candidates
        : selectAnswerSubset(
            candidates,
            Math.min(targetCount, candidates.length),
            random,
            options.excludeWords,
          );

    if (subset.length < 2 && !allowDisconnected) continue;

    // Verify subset has some shared-letter potential
    let potential = 0;
    for (let i = 0; i < subset.length; i += 1) {
      for (let j = i + 1; j < subset.length; j += 1) {
        potential += intersectionPotential(subset[i]!, subset[j]!);
      }
    }
    if (subset.length >= 2 && potential <= 0) continue;

    for (let layoutAttempt = 0; layoutAttempt < maxLayoutsPerSet; layoutAttempt += 1) {
      attempts += 1;
      const order = [...subset];
      // Light shuffle of order after the longest word for variety
      for (let i = order.length - 1; i > 1; i -= 1) {
        if (random() < 0.45) {
          const j = 1 + Math.floor(random() * i);
          const tmp = order[i]!;
          order[i] = order[j]!;
          order[j] = tmp;
        }
      }

      const grid = new MutableGrid();
      const state = { nodes: 0, maxNodes: maxSearchNodes };
      const found = placeWordsBacktrack(order, grid, [], state);
      if (!found) continue;

      const normalized = normalizePlacements(found);
      const validation = validateCrosswordPuzzle(
        {
          letters: [],
          answers: normalized.map((p) => ({
            word: p.word,
            row: p.row,
            column: p.column,
            direction: p.direction,
          })),
        },
        { allowDisconnected },
      );

      if (options.debug && typeof console !== 'undefined') {
        // eslint-disable-next-line no-console
        console.table(
          normalized.map((p) => ({
            word: p.word,
            row: p.row,
            column: p.column,
            direction: p.direction,
          })),
        );
      }

      if (!validation.valid) continue;

      // Prefer higher quality, but still keep structurally valid layouts.
      // Place-name sets often produce sparse bounding boxes that score "poor"
      // even when they are fully connected with enough crossings.
      if (
        !best ||
        validation.score > best.validation.score ||
        qualityRank(validation.quality) > qualityRank(best.validation.quality)
      ) {
        best = { placements: normalized, validation };
      }
      if (
        validation.quality === 'good' ||
        validation.quality === 'excellent'
      ) {
        return {
          placements: normalized,
          validation,
          attempts,
        };
      }
    }
  }

  if (
    best &&
    best.validation.valid &&
    (best.placements.length === 1 ||
      (best.validation.componentCount === 1 &&
        best.validation.intersectionCount >=
          minIntersectionsForCount(best.placements.length)))
  ) {
    return {
      placements: best.placements,
      validation: best.validation,
      attempts,
    };
  }

  return null;
}

function qualityRank(quality: PuzzleQuality): number {
  switch (quality) {
    case 'excellent':
      return 4;
    case 'good':
      return 3;
    case 'acceptable':
      return 2;
    default:
      return 1;
  }
}

export function placementsToAnswers(placements: PlacedWord[]): PuzzleAnswer[] {
  return placements.map((p) => ({
    word: normalizeWord(p.word),
    row: p.row,
    column: p.column,
    direction: p.direction,
  }));
}
