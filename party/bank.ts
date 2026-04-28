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
import appConfigJson from '../public/data/quiz-app-config.json';

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
 * Frameworks + branding come from quiz-app-config.json — the single
 * source of truth for "what topics are in this bank, what should the game
 * be called". (Phase-1 split:until 2db1450 these lived in quiz-bank-metadata.json
 * along with the documentation-only stats; they got promoted to their own
 * file so designers can read the metadata file without accidentally editing
 * stuff that hits production.)
 *
 * Framework A (9-grid in normal modes) → topic_frameworks.system_A_standard_9
 * Framework B (4-grid in purgatory)    → topic_frameworks.system_B_purgatory_4
 *
 * Each declares an array of `{id, label}` objects; we extract the `label`
 * string (because question.topic stores the Chinese label directly, not
 * the technical id).
 *
 * shortId (F1..F9, L1..L4) is the 1-based index of the array.
 * Client uses shortId for grid cell positioning; server uses the label
 * string to filter questions by topic.
 *
 * Backward-compat fallbacks: if app-config is malformed/missing the
 * expected shape, we use the original insurance labels so the picker
 * still works rather than crash on bank load.
 */

const FALLBACK_FRAMEWORKS_A = [
  '保險基礎與法規', '契約條款與效力', '核保與健康告知',
  '理賠實務與爭議', '險種規劃與商品', '精算、財務與監理',
  '高資產與稅務傳承', '業務倫理與合規', '保費、保單運用與計算',
];
const FALLBACK_FRAMEWORKS_B = [
  '跨部門溝通', '客戶溝通', '道德判斷', '時間尺度',
];
const FALLBACK_TITLE_PREFIX = '保險知識';
const FALLBACK_TITLE_SUFFIX = '星攻略';

interface ConfigFramework {
  id?: string;
  label?: string;
}
interface AppConfigShape {
  branding?: { title_prefix?: string; title_suffix?: string };
  topic_frameworks?: {
    system_A_standard_9?: { frameworks?: ConfigFramework[] };
    system_B_purgatory_4?: { frameworks?: ConfigFramework[] };
  };
}

function extractLabels(arr: ConfigFramework[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(arr)) return fallback;
  const labels = arr
    .map((fw) => fw?.label)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
  return labels.length > 0 ? labels : fallback;
}

const _cfg = appConfigJson as AppConfigShape;

export const FRAMEWORKS_A: string[] = extractLabels(
  _cfg.topic_frameworks?.system_A_standard_9?.frameworks,
  FALLBACK_FRAMEWORKS_A
);
export const FRAMEWORKS_B: string[] = extractLabels(
  _cfg.topic_frameworks?.system_B_purgatory_4?.frameworks,
  FALLBACK_FRAMEWORKS_B
);

export const BRANDING = {
  titlePrefix: typeof _cfg.branding?.title_prefix === 'string' && _cfg.branding.title_prefix.length > 0
    ? _cfg.branding.title_prefix
    : FALLBACK_TITLE_PREFIX,
  titleSuffix: typeof _cfg.branding?.title_suffix === 'string' && _cfg.branding.title_suffix.length > 0
    ? _cfg.branding.title_suffix
    : FALLBACK_TITLE_SUFFIX,
};

/**
 * shortId → topic-label map. Synthesized from FRAMEWORKS_{A,B} arrays:
 *   index 0 of A → 'F1', index 0 of B → 'L1', etc.
 * Server's enter_category handler converts the shortId payload into the
 * topic-label string used by pickQuestion's filter.
 */
export const FRAMEWORK_BY_SHORT_ID: Record<string, string> = {
  ...Object.fromEntries(FRAMEWORKS_A.map((label, i) => [`F${i + 1}`, label])),
  ...Object.fromEntries(FRAMEWORKS_B.map((label, i) => [`L${i + 1}`, label])),
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
    // Phase 4 fix:武裝煉獄是「秘技 / 強制覆蓋」,要繞過 custom mode 的 type
    // whitelist。煉獄只有 multiple_choice + essay 兩種題型,如果 user custom
    // 勾「短答 / 計算 / 一字千金」,套 typeWhitelist 後 0 題 → bug:user
    // 按了「確定煉獄」結果報「煉獄已抽完」。武裝就是要強制觸發,什麼題型
    // 都得跳到煉獄(從 multiple_choice / essay 隨機抽)。
    candidates = ALL_QUESTIONS.filter(
      (q) => q.difficulty === 'purgatory' && !input.usedIds.has(q.id)
    );
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
