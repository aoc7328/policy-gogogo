/**
 * client/bankloader.ts — fetch the 5 BANK JSONs from /data/ and normalize
 * them into the flat shape that the three HTMLs expect.
 *
 * Phase 0 Q11 deployment plan: BANK lives at /public/data/ as static
 * JSON, served by Cloudflare Pages. All three clients fetch on load.
 * Server is still authoritative for question selection (gets bundled
 * copies at build time); clients only need the bank for content lookup
 * (stem / options / answer text given a question id).
 *
 * Bundled into the same IIFE as PartyBus and exposed at
 * `window.PGGBankLoader` so the existing inline scripts can call it
 * without ESM gymnastics.
 */

type Difficulty = 'easy' | 'medium' | 'hard' | 'hell' | 'purgatory';

const ALL_DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard', 'hell', 'purgatory'];

const ID_PREFIX_TO_DIFF: Record<string, Difficulty> = {
  E: 'easy',
  M: 'medium',
  H: 'hard',
  X: 'hell',
  P: 'purgatory',
};

const SYSTEM_A_TYPES = ['short_answer', 'multiple_choice', 'essay', 'calculation', 'word_game'];

interface RawQuestion {
  id: string;
  topic: string;
  type?: string;
  [k: string]: unknown;
}

interface NormalizedBank {
  questions: RawQuestion[];           // always flat with `type` field
  count: number;
  byType: Record<string, number>;
  uploadedAt: string;
  filename: string;
}

export interface AutoLoadOptions {
  /** Path prefix for fetch. Default: 'data/' (relative — works file:// + http). */
  baseUrl?: string;
  /** Fired after each file is loaded (or fails). */
  onProgress?: (loaded: number, total: number, difficulty: Difficulty) => void;
  /** Fired with each per-file error. */
  onError?: (difficulty: Difficulty, message: string) => void;
}

export interface AutoLoadResult {
  ok: boolean;
  banks: Partial<Record<Difficulty, NormalizedBank>>;
  errors: { difficulty: Difficulty; message: string }[];
}

function normalize(diff: Difficulty, parsed: unknown, filename: string): NormalizedBank {
  if (diff === 'purgatory') {
    // System B: flat array; each item has its own `type` field.
    const root = parsed as { questions?: RawQuestion[] };
    const arr = Array.isArray(root.questions) ? root.questions : [];
    const byType: Record<string, number> = {};
    for (const q of arr) {
      const t = q.type ?? 'unknown';
      byType[t] = (byType[t] ?? 0) + 1;
    }
    return {
      questions: arr,
      count: arr.length,
      byType,
      uploadedAt: new Date().toISOString(),
      filename,
    };
  }
  // System A: nested questions.<difficulty>.<type>[]; flatten and stamp `type`.
  const root = parsed as Record<string, unknown>;
  let bank: Record<string, unknown> | null = null;
  const byDiff = (root.questions as Record<string, unknown> | undefined)?.[diff];
  if (byDiff && typeof byDiff === 'object') bank = byDiff as Record<string, unknown>;
  else if (root[diff] && typeof root[diff] === 'object') bank = root[diff] as Record<string, unknown>;
  else if (root.questions && typeof root.questions === 'object' && !Array.isArray(root.questions)) {
    bank = root.questions as Record<string, unknown>;
  }
  if (!bank) {
    throw new Error(`expected nested questions.${diff}.<type> structure`);
  }
  const flat: RawQuestion[] = [];
  const byType: Record<string, number> = {};
  for (const t of SYSTEM_A_TYPES) {
    const arr = bank[t];
    if (!Array.isArray(arr)) continue;
    for (const raw of arr as RawQuestion[]) {
      flat.push({ ...raw, type: t });
    }
    byType[t] = arr.length;
  }
  if (flat.length === 0) {
    throw new Error(`no questions found in nested structure for ${diff}`);
  }
  return {
    questions: flat,
    count: flat.length,
    byType,
    uploadedAt: new Date().toISOString(),
    filename,
  };
}

async function loadOne(diff: Difficulty, baseUrl: string): Promise<NormalizedBank> {
  const filename = `insurance-quiz-bank-${diff}.json`;
  const url = `${baseUrl}${filename}`;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (e) {
    throw new Error(`JSON parse failed for ${filename}: ${(e as Error).message}`);
  }
  return normalize(diff, parsed, filename);
}

async function autoLoad(opts: AutoLoadOptions = {}): Promise<AutoLoadResult> {
  const baseUrl = opts.baseUrl ?? 'data/';
  const banks: Partial<Record<Difficulty, NormalizedBank>> = {};
  const errors: AutoLoadResult['errors'] = [];
  let loaded = 0;
  // Load in parallel — 5 small files, no need to serialize.
  await Promise.all(
    ALL_DIFFICULTIES.map(async (diff) => {
      try {
        const bank = await loadOne(diff, baseUrl);
        banks[diff] = bank;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ difficulty: diff, message: msg });
        opts.onError?.(diff, msg);
      } finally {
        loaded += 1;
        opts.onProgress?.(loaded, ALL_DIFFICULTIES.length, diff);
      }
    })
  );
  return {
    ok: errors.length === 0,
    banks,
    errors,
  };
}

/**
 * Helper for clients with a `BANK_SCHEMA` table where each difficulty has
 * a `prefix` (E/M/H/X/P). Useful for `getQuestionById(id)` lookups.
 */
function difficultyForId(id: string): Difficulty | null {
  const prefix = id?.[0]?.toUpperCase?.();
  return prefix ? (ID_PREFIX_TO_DIFF[prefix] ?? null) : null;
}

const PGGBankLoader = {
  autoLoad,
  difficultyForId,
};

(window as unknown as { PGGBankLoader: typeof PGGBankLoader }).PGGBankLoader = PGGBankLoader;

export default PGGBankLoader;
