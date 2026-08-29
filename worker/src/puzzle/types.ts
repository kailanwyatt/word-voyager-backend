export type WordDirection = 'horizontal' | 'vertical';

export interface PuzzleAnswer {
  word: string;
  row: number;
  column: number;
  direction: WordDirection;
}

export interface PuzzleDefinition {
  id: number;
  worldId: string;
  regionId: string;
  letters: string[];
  answers: PuzzleAnswer[];
  difficulty: number;
  starReward: number;
  coinReward: number;
  bonusWords: string[];
  contentKind?: 'study_lesson';
  studyLessonId?: string;
  studyPackId?: string;
}

export interface GridCell {
  row: number;
  column: number;
  letter: string;
  filled: boolean;
  revealed: boolean;
}
