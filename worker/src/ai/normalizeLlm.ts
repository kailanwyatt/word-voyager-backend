import { STUDY_BAND_WAVE_MAX, type LlmTerm } from '@word-voyage/contracts';

export function failValidation(reason: string, details?: unknown): never {
  const suffix = details == null ? '' : ` ${JSON.stringify(details).slice(0, 400)}`;
  throw new Error('validation_failed', { cause: `${reason}${suffix}` });
}

/** Recover truncated JSON objects from chat completions. */
export function parseLlmJson(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    // fall through
  }
  const start = text.indexOf('{');
  if (start < 0) failValidation('non_json', { preview: text.slice(0, 120) });
  const sliced = text.slice(start);
  const attempts = [
    sliced,
    `${sliced}}`,
    sliced.replace(/,\s*$/, '') + ']}',
    sliced.replace(/,\s*$/, '') + '}]}',
    sliced.replace(/,\s*\{[^}]*$/, '') + ']}',
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next close
    }
  }
  failValidation('non_json', { preview: text.slice(0, 120) });
}

function lettersAnswer(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (!/^[A-Z]{3,12}$/.test(trimmed)) return null;
  return trimmed;
}

/** Drop invalid terms and extra fields so one bad word cannot fail the pack. */
export function normalizeLlmPayload(
  raw: unknown,
  maxTerms = STUDY_BAND_WAVE_MAX,
): {
  title: string;
  description: string;
  language: 'en';
  terms: LlmTerm[];
} {
  const root =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const termsIn = Array.isArray(root.terms) ? root.terms : [];
  const seen = new Set<string>();
  const terms: LlmTerm[] = [];
  for (const item of termsIn) {
    if (!item || typeof item !== 'object') continue;
    const term = item as Record<string, unknown>;
    const answer = lettersAnswer(String(term.answer ?? ''));
    if (!answer || seen.has(answer)) continue;
    const definition = String(term.definition ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
    if (definition.length < 8) continue;
    const difficultyRaw = Number(term.difficulty);
    const difficulty =
      Number.isFinite(difficultyRaw) && difficultyRaw >= 1 && difficultyRaw <= 5
        ? Math.round(difficultyRaw)
        : 2;
    seen.add(answer);
    terms.push({
      term: String(term.term ?? answer).trim().slice(0, 40) || answer,
      answer,
      definition,
      explanation:
        term.explanation == null
          ? undefined
          : String(term.explanation).slice(0, 400),
      category: String(term.category ?? 'General').slice(0, 40) || 'General',
      difficulty,
    });
    if (terms.length >= maxTerms) break;
  }

  const title = String(root.title ?? 'Study Pack').trim().slice(0, 80) || 'Study Pack';
  const description =
    String(root.description ?? 'Generated study terms.')
      .trim()
      .slice(0, 400) || 'Generated study terms.';
  return {
    title,
    description,
    language: 'en',
    terms,
  };
}
