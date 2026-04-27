/**
 * bank.ts — load the 5 BANK JSON files at build time, normalize into a
 * flat lookup, and provide the question picker used by the server.
 *
 * Build-time inlining: PartyKit's esbuild bundler inlines these imports
 * into the worker bundle. No runtime fetch from R2 / Pages needed.
 *
 * Single source of truth: clients fetch the same JSON files from
 * /public/data/ at runtime, so server `id` + client BANK content stay
 * aligned automatically.
 */

import easyJson from '../public/data/insurance-quiz-bank-easy.json';
import mediumJson from '../public/data/insurance-quiz-bank-medium.json';
import hardJson from '../public/data/insurance-quiz-bank-hard.json';
import hellJson from '../public/data/insurance-quiz-bank-hell.json';
import purgatoryJson from '../public/data/insurance-quiz-bank-purgatory.json';

import type { Difficulty, GameMode } from './protocol';

export interface NormalizedQuestion {
  id: string;
  difficulty: Difficulty;
  framework: string;     // full framework id, e.g. 'f1_insurance_basics' or 'l2_customer'
  type: string;          // 'short_answer' | 'multiple_choice' | ...
}

// ──────────────────────────────────────────────────────────────────────
// Framework / mode static tables (mirror BANK_SCHEMA in assistant.html)
// ──────────────────────────────────────────────────────────────────────

/**
 * Maps the 9-grid + purgatory short ids (shown to the assistant) to the
 * `topic` string used inside the BANK JSON files.
 *
 * The real BANK uses Chinese display labels as the topic (matches
 * quiz-bank-metadata.json `available_frameworks[].label`). The fixture
 * generator (scripts/generate-bank-fixtures.mjs) has been updated to use
 * the same Chinese labels — keep these two in sync.
 *
 * History: previously this table mapped to technical ids
 * ('f1_insurance_basics' etc), which matched the original fixture but
 * NOT the real BANK — so every category lookup failed with
 * 'framework_not_in_bank' once Vincent dropped real bank into /public/data/.
 */
export const FRAMEWORK_BY_SHORT_ID: Record<string, string> = {
  F1: '保險基礎與法規',
  F2: '契約條款與效力',
  F3: '核保與健康告知',
  F4: '理賠實務與爭議',
  F5: '險種規劃與商品',
  F6: '精算、財務與監理',
  F7: '高資產與稅務傳承',
  F8: '業務倫理與合規',
  F9: '保費、保單運用與計算',
  L1: '跨部門溝通',
  L2: '客戶溝通',
  L3: '道德判斷',
  L4: '時間尺度',
};

export const MODE_TIER_POOL: Record<Exclude<GameMode, 'custom'>, Difficulty[]> = {
  ordinary: ['easy', 'medium', 'hard'],
  hell: ['hard', 'hell', 'purgatory'],
  paradise: ['easy', 'medium', 'hard', 'hell', 'purgatory'],
};

// ──────────────────────────────────────────────────────────────────────
// Normalization — flatten both file structures into a single list
// ──────────────────────────────────────────────────────────────────────

interface SystemAFile {
  questions: Record<string, Record<string, RawQuestion[]>>;
}
interface SystemBFile {
  questions: RawQuestion[];
}
interface RawQuestion {
  id: string;
  topic: string;
  type?: string;
  // type-specific fields ignored here — picker only cares about id/topic/type
  [k: string]: unknown;
}

function flattenSystemA(diff: Difficulty, file: unknown): NormalizedQuestion[] {
  const f = file as SystemAFile;
  const byType = f.questions?.[diff];
  if (!byType || typeof byType !== 'object') {
    throw new Error(`bank.ts: ${diff} JSON missing nested questions.${diff}.<type>`);
  }
  const out: NormalizedQuestion[] = [];
  for (const [type, arr] of Object.entries(byType)) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      out.push({
        id: raw.id,
        difficulty: diff,
        framework: raw.topic,
        type,
      });
    }
  }
  return out;
}

function flattenSystemB(file: unknown): NormalizedQuestion[] {
  const f = file as SystemBFile;
  if (!Array.isArray(f.questions)) {
    throw new Error('bank.ts: purgatory JSON must have flat `questions: []` array');
  }
  return f.questions.map((raw) => ({
    id: raw.id,
    difficulty: 'purgatory' as const,
    framework: raw.topic,
    type: raw.type ?? 'unknown',
  }));
}

const ALL_QUESTIONS: NormalizedQuestion[] = [
  ...flattenSystemA('easy', easyJson),
  ...flattenSystemA('medium', mediumJson),
  ...flattenSystemA('hard', hardJson),
  ...flattenSystemA('hell', hellJson),
  ...flattenSystemB(purgatoryJson),
];

// Sanity index — guard against duplicate IDs across the whole bank.
{
  const seen = new Set<string>();
  for (const q of ALL_QUESTIONS) {
    if (seen.has(q.id)) {
      throw new Error(`bank.ts: duplicate question id "${q.id}"`);
    }
    seen.add(q.id);
  }
}

export function bankSize(): number {
  return ALL_QUESTIONS.length;
}

// ──────────────────────────────────────────────────────────────────────
// Picker
// ──────────────────────────────────────────────────────────────────────

export interface PickInput {
  /** Resolved difficulty pool: from MODE_TIER_POOL or custom config. */
  tierPool: Difficulty[];
  /** Framework full id (e.g. 'f5_product_planning'). Pass null to allow any. */
  framework: string | null;
  /** Allowed types (filters by `type` field). null = any type. */
  typeWhitelist: string[] | null;
  /** Already-asked question ids; picker skips these. */
  usedIds: ReadonlySet<string>;
  /**
   * Phase 0 Q4 path (b): assistant pre-armed purgatory. When true, the
   * picker forces a draw from the purgatory tier regardless of framework
   * (the assistant secret is "ignore the previewed F-cell, give me a
   * purgatory question instead"). Caller should clear the flag after.
   */
  purgArmed: boolean;
}

export interface PickError {
  ok: false;
  reason: 'pool_empty' | 'no_purgatory_left' | 'framework_not_in_bank';
  /** Diagnostics so the assistant UI can tell user "load real bank into /public/data/" */
  diag?: {
    tierPool: Difficulty[];
    framework: string | null;
    bankSizeForFramework: number;     // questions in bank matching framework (any tier)
    bankSizeInPool: number;           // questions in bank matching tier pool (any framework)
    crossSize: number;                // questions matching both
    usedInCross: number;              // of crossSize, how many in usedIds
  };
}
export interface PickOk {
  ok: true;
  question: NormalizedQuestion;
  /** True if the picked question is purgatory tier (either path a or b). */
  triggersPurgatory: boolean;
}

export function pickQuestion(input: PickInput): PickOk | PickError {
  let candidates: NormalizedQuestion[];

  if (input.purgArmed) {
    // Path (b): assistant explicitly armed purgatory — force purgatory tier.
    candidates = ALL_QUESTIONS.filter(
      (q) => q.difficulty === 'purgatory' && !input.usedIds.has(q.id)
    );
    if (input.typeWhitelist) {
      candidates = candidates.filter((q) => input.typeWhitelist!.includes(q.type));
    }
    if (candidates.length === 0) {
      return { ok: false, reason: 'no_purgatory_left' };
    }
  } else {
    // Normal path. Filter by tier, framework, type, used.
    candidates = ALL_QUESTIONS.filter((q) => input.tierPool.includes(q.difficulty));
    if (input.framework) {
      candidates = candidates.filter((q) => q.framework === input.framework);
    }
    if (input.typeWhitelist) {
      candidates = candidates.filter((q) => input.typeWhitelist!.includes(q.type));
    }
    const beforeUsedFilter = candidates.length;
    candidates = candidates.filter((q) => !input.usedIds.has(q.id));
    if (candidates.length === 0) {
      // Diagnose: was this framework empty in the server bank to start with,
      // or did we exhaust it via usedIds? Big difference for the user:
      //   - empty in bank  → server BANK is fixture, real bank not synced
      //   - exhausted      → genuine "asked everything in this category"
      const bankSizeForFramework = input.framework
        ? ALL_QUESTIONS.filter((q) => q.framework === input.framework).length
        : ALL_QUESTIONS.length;
      const bankSizeInPool = ALL_QUESTIONS.filter((q) =>
        input.tierPool.includes(q.difficulty)
      ).length;
      const reason: PickError['reason'] =
        beforeUsedFilter === 0 ? 'framework_not_in_bank' : 'pool_empty';
      return {
        ok: false,
        reason,
        diag: {
          tierPool: input.tierPool,
          framework: input.framework,
          bankSizeForFramework,
          bankSizeInPool,
          crossSize: beforeUsedFilter,
          usedInCross: 0, // by definition: if cross-size > 0 we'd have picked
        },
      };
    }
  }

  const idx = Math.floor(Math.random() * candidates.length);
  const picked = candidates[idx]!;
  return {
    ok: true,
    question: picked,
    triggersPurgatory: picked.difficulty === 'purgatory',
  };
}

/** Resolve a game mode to its difficulty tier pool. For 'custom', caller passes own pool. */
export function tiersForMode(mode: GameMode, customTiers: Difficulty[]): Difficulty[] {
  if (mode === 'custom') return customTiers;
  return MODE_TIER_POOL[mode];
}
