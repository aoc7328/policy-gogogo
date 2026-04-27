#!/usr/bin/env node
/**
 * generate-bank-fixtures.mjs — write 5 placeholder BANK JSONs into
 *   public/data/insurance-quiz-bank-{easy,medium,hard,hell,purgatory}.json
 *
 * Deterministic fixture data for Phase 2/3/4 work. Replaced by the real
 * 437-question library before Phase 5 deploy.
 *
 * Schema: derived from quiz-bank-metadata.json (system A nested
 * { questions: { <difficulty>: { <type>: [...] } } } for easy/medium/hard/hell;
 * system B flat { questions: [...] } for purgatory). Question shapes match
 * BANK_SCHEMA.typeFields in assistant.html.
 *
 * Every fixture answer/question text is prefixed "[範例]" so they stand out
 * in any UI that renders them.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
mkdirSync(OUT_DIR, { recursive: true });

const PER_TYPE_COUNT = 3;

const TYPE_CODES = {
  short_answer: 'SA',
  multiple_choice: 'MC',
  essay: 'ES',
  calculation: 'CA',
  word_game: 'WG',
};

// Frameworks here are stored as Chinese display labels to match the real
// BANK's `topic` field (e.g. "保險基礎與法規"), so server picker filtering
// works against either fixture or real BANK without translation.
// See party/bank.ts FRAMEWORK_BY_SHORT_ID for the F1-F9 / L1-L4 mapping.
const DIFFICULTIES = {
  easy: {
    label: '簡單',
    prefix: 'E',
    types: ['short_answer', 'multiple_choice', 'essay', 'calculation'],
    frameworks: ['險種規劃與商品', '保險基礎與法規'],
    system: 'A',
  },
  medium: {
    label: '中等',
    prefix: 'M',
    types: ['short_answer', 'multiple_choice', 'essay', 'calculation', 'word_game'],
    frameworks: ['險種規劃與商品', '保費、保單運用與計算'],
    system: 'A',
  },
  hard: {
    label: '困難',
    prefix: 'H',
    types: ['short_answer', 'multiple_choice', 'essay', 'calculation', 'word_game'],
    frameworks: ['精算、財務與監理', '險種規劃與商品'],
    system: 'A',
  },
  hell: {
    label: '地獄',
    prefix: 'X',
    types: ['short_answer', 'multiple_choice', 'essay', 'calculation', 'word_game'],
    frameworks: ['高資產與稅務傳承', '險種規劃與商品'],
    system: 'A',
  },
  purgatory: {
    label: '煉獄',
    prefix: 'P',
    types: ['multiple_choice', 'essay'],
    frameworks: ['客戶溝通', '道德判斷'],
    system: 'B',
  },
};

// 4 Bopomofo readings used for word_game fixtures. Distinct enough that the
// "correct" string is visibly one option among four.
const WORD_FIXTURES = [
  { word: '機', options: ['ㄐㄧ', 'ㄐㄧˋ', 'ㄎㄜ', 'ㄓㄚ'], correct: 'ㄐㄧ', context: '機緣巧合' },
  { word: '繳', options: ['ㄒㄧㄠ', 'ㄐㄧㄠˇ', 'ㄎㄠˋ', 'ㄓㄜˊ'], correct: 'ㄐㄧㄠˇ', context: '繳交保費' },
  { word: '賠', options: ['ㄆㄟˊ', 'ㄈㄤˋ', 'ㄅㄟˋ', 'ㄆㄠˇ'], correct: 'ㄆㄟˊ', context: '理賠申請' },
];

function makeId(diffPrefix, type, seq) {
  return `${diffPrefix}_${TYPE_CODES[type]}_${String(seq).padStart(3, '0')}`;
}

function makeShortAnswer(diffLabel, topic, id) {
  return {
    id,
    topic,
    question: `[範例] ${diffLabel}・${topic}：請簡述本主題的核心概念。`,
    answer: `[範例答案] 本主題核心為...（fixture 佔位字串，請以實際題庫覆蓋）`,
  };
}

function makeMultipleChoice(diffLabel, topic, id, seq) {
  const correct = 'ABCD'[seq % 4];
  return {
    id,
    topic,
    question: `[範例] ${diffLabel}・${topic}：以下敘述何者正確？`,
    options: {
      A: '[選項 A] 第一個敘述',
      B: '[選項 B] 第二個敘述',
      C: '[選項 C] 第三個敘述',
      D: '[選項 D] 第四個敘述',
    },
    correct,
    explanation: `[範例解析] 因為${correct}選項符合本題情境，其餘為干擾項。`,
  };
}

function makeEssay(diffLabel, topic, id) {
  return {
    id,
    topic,
    question: `[範例] ${diffLabel}・${topic}：請就本主題進行論述。`,
    key_points: [
      '[要點一] 名詞定義與背景',
      '[要點二] 適用情境與條件',
      '[要點三] 實務應用與例外',
    ],
    model_answer:
      `[範文] 本題應從定義出發，先說明...，再就...展開，最後以實際案例佐證。` +
      `(fixture 佔位字串，請以實際題庫覆蓋)`,
  };
}

function makeCalculation(diffLabel, topic, id, seq) {
  // Compound interest fixture: FV = P * (1 + i)^N
  const P = 1000 + seq * 100;
  const i = 0.03 + seq * 0.01;
  const N = 5 + seq;
  const answer = Number((P * Math.pow(1 + i, N)).toFixed(2));
  return {
    id,
    topic,
    question: `[範例] ${diffLabel}・${topic}：給定本金、利率與期數，求複利期末本利和。`,
    given: { 本金P: P, 年利率i: i, 期數N: N },
    steps: [
      `Step 1: 套用複利公式 FV = P * (1 + i)^N`,
      `Step 2: 代入 FV = ${P} * (1 + ${i})^${N}`,
      `Step 3: 計算得 FV ≈ ${answer}`,
    ],
    answer,
    unit: '元',
  };
}

function makeWordGame(diffLabel, topic, id, seq) {
  const fix = WORD_FIXTURES[seq % WORD_FIXTURES.length];
  return {
    id,
    topic,
    word: fix.word,
    options: [...fix.options],
    correct: fix.correct,
    context_phrase: fix.context,
  };
}

const TYPE_BUILDERS = {
  short_answer: makeShortAnswer,
  multiple_choice: makeMultipleChoice,
  essay: makeEssay,
  calculation: makeCalculation,
  word_game: makeWordGame,
};

function buildOneType(diffId, type) {
  const spec = DIFFICULTIES[diffId];
  const builder = TYPE_BUILDERS[type];
  const out = [];
  for (let seq = 1; seq <= PER_TYPE_COUNT; seq++) {
    const id = makeId(spec.prefix, type, seq);
    const topic = spec.frameworks[(seq - 1) % spec.frameworks.length];
    out.push(builder(spec.label, topic, id, seq));
  }
  return out;
}

function buildSystemA(diffId) {
  const spec = DIFFICULTIES[diffId];
  const byType = {};
  for (const type of spec.types) {
    byType[type] = buildOneType(diffId, type);
  }
  return {
    fixture: true,
    fixture_note:
      `Generated by scripts/generate-bank-fixtures.mjs · ` +
      `${PER_TYPE_COUNT} questions per type · replace with real library before deploy.`,
    questions: { [diffId]: byType },
  };
}

function buildSystemB(diffId) {
  const spec = DIFFICULTIES[diffId];
  // Flat array; each item carries its own `type` field.
  const flat = [];
  for (const type of spec.types) {
    for (const q of buildOneType(diffId, type)) {
      flat.push({ ...q, type });
    }
  }
  return {
    fixture: true,
    fixture_note:
      `Generated by scripts/generate-bank-fixtures.mjs · ` +
      `${PER_TYPE_COUNT} questions per type · replace with real library before deploy.`,
    questions: flat,
  };
}

const writeOne = (diffId) => {
  const spec = DIFFICULTIES[diffId];
  const data = spec.system === 'A' ? buildSystemA(diffId) : buildSystemB(diffId);
  const path = resolve(OUT_DIR, `insurance-quiz-bank-${diffId}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return path;
};

const written = Object.keys(DIFFICULTIES).map(writeOne);
console.log('Wrote BANK fixtures:');
for (const p of written) console.log(`  - ${p}`);
