#!/usr/bin/env node
/**
 * build-bank-review.mjs — 產生「題庫審閱頁」單檔 HTML。
 *
 * 用途:把 2026-08-27 的地獄／煉獄題庫稽核結果做成一頁,交給外部專家
 * (保險實務、法遵)逐題判定「刪除／修改／保留」並寫建議,審完匯出一個
 * JSON 檔回傳。
 *
 * 設計前提:**不依賴任何後端,也不下載任何檔案**。整頁是靜態 HTML,
 * 審閱者的輸入存在他自己瀏覽器的 localStorage;審完後頁面產生一段
 * 「提示詞」,他直接複製、用 LINE 傳回承辦人即可。
 * 不用下載檔案的另一個好處:可以直接發布成 Artifact(Artifact 的沙箱會
 * 擋掉網頁自己觸發的下載,但複製到剪貼簿不受影響)。
 *
 * 產出: bank-review.html(專案根目錄;根目錄 HTML 不隨 public/ 部署)
 * 執行: node scripts/build-bank-review.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

// ── 讀題庫 ────────────────────────────────────────────────────────
const hellBank = read('public/data/insurance-quiz-bank-hell.json');
const purgBank = read('public/data/insurance-quiz-bank-purgatory.json');

const TYPE_LABEL = {
  short_answer: '簡答題',
  essay: '申論題',
  multiple_choice: '選擇題',
  calculation: '計算題',
  word_game: '一字千金',
};

const hellQs = Object.entries(hellBank.questions.hell).flatMap(([type, arr]) =>
  arr.map((q) => ({ ...q, type, bank: 'hell', bankLabel: '地獄' }))
);
const purgQs = Object.values(purgBank.questions).map((q) => ({
  ...q, bank: 'purgatory', bankLabel: '煉獄',
}));
const ALL = [...hellQs, ...purgQs];
const byId = new Map(ALL.map((q) => [q.id, q]));

// ── 稽核結果(2026-08-27)─────────────────────────────────────────
// cat: A=法規錯誤/過時  C=框架牽強  D=小毛病
// ── 2026-08-28 外部專家審閱結果(已全部套用)────────────────────────
// decision: delete=刪除  modify=修改。刪除的題目已不在題庫,頁面顯示為
// 「已刪除」而不再展開原文。這張表讓本頁同時是「稽核發現」與「處理紀錄」。
const RESOLVED_AT = '2026-08-28';
const RESOLUTION = {
  'X-CA-001': 'modify', 'X-CA-003': 'modify', 'X-CA-005': 'modify',
  'X-CA-008': 'modify', 'X-CA-009': 'delete', 'X-CA-010': 'delete',
  'X-CA-011': 'modify', 'X-CA-015': 'delete', 'X-CA-017': 'modify',
  'X-ES-005': 'modify', 'X-ES-008': 'modify', 'X-ES-014': 'modify',
  'X-ES-015': 'delete', 'X-ES-018': 'modify', 'X-MC-003': 'modify',
  'X-MC-011': 'modify', 'X-MC-022': 'modify', 'X-SA-011': 'modify',
};

const FINDINGS = [
  {
    id: 'X-MC-003', cat: 'A', sev: '高',
    title: '評議中心「100 萬」是舊制,現行為 120 萬／12 萬',
    detail:
      '金管會 2021 年 9 月公告調高金融消費者保護法第 29 條第 2 項之「一定額度」:保險給付爭議(含投資型保險商品)為 120 萬元、非屬保險給付爭議為 12 萬元。本題正解 C(100 萬)已失效,而且四個選項裡沒有 120 萬可選 —— 不能只改正解欄,必須改寫選項或整題刪除。',
    ref: '金管會 2021-09-16 新聞稿;金融消費評議中心「效力及拘束力」常見問答',
    suggest: '建議改寫:選項改為「120 萬／12 萬／20 萬／無上限」,正解 120 萬;或整題刪除。',
    note: '2026-08-27 第一場實際抽到這題(第 7 題,判 25%)。',
  },
  {
    id: 'X-ES-008', cat: 'A', sev: '高',
    title: '範例答案內兩處「100 萬」為舊制額度',
    detail:
      '本題本身是好題(評議制度對保險業的結構性影響),但範例答案裡「爭議金額 100 萬元以下…人身保險給付 100 萬、其他商品 10 萬」是 2021 年調高前的數字。現行為保險給付 120 萬、非屬保險給付 12 萬。',
    ref: '同上',
    suggest: '建議修改:把範例答案內的兩處金額更新為 120 萬／12 萬即可,題目本體不動。',
  },
  {
    id: 'X-MC-011', cat: 'A', sev: '高',
    title: '境外保單「不列入遺產稅」與國稅局實務相反',
    detail:
      '依財政部函釋,未經主管機關核准之外國保險公司壽險保單不適用保險法第 112 條,因此**不能**主張遺產及贈與稅法第 16 條第 9 款「不計入遺產總額」—— 實務上境外保單身故保險金應併入遺產課稅。本題正解 C 教的方向與此相反,屬於會讓學員拿去跟客戶講、事後出事的錯誤知識。',
    ref: '財政部函釋;PwC 稅務法規解析「境外保單到底應不應該納入遺產課徵遺產稅」',
    suggest: '建議改寫正解與解析為「應併入遺產課稅,另有境外所得最低稅負問題」;或整題刪除。',
  },
  {
    id: 'X-ES-015', cat: 'A', sev: '高',
    title: '同上(境外保單不列遺產稅)+「境內財產原則」敘述錯誤',
    detail:
      '範例答案寫「境外保險金不列入台灣遺產稅(因台灣遺產稅制採境內財產原則)」—— 兩處都有問題:(1) 台灣對境內居住者採全球財產課遺產稅,不是境內財產原則;(2) 境外保單依函釋應併入遺產。題目本身(跨境理賠實務挑戰)有價值,問題出在稅務段落。',
    ref: '同 X-MC-011;遺產及贈與稅法第 1 條',
    suggest: '建議修改:刪掉或改寫範例答案中的稅務段落,保留理賠實務、文件認證、外匯的部分。',
  },
  {
    id: 'X-ES-014', cat: 'A', sev: '高',
    title: '「死亡前 3 年內贈與併入遺產」—— 法條是 2 年',
    detail:
      '遺產及贈與稅法第 15 條明定為被繼承人死亡前「2 年內」對配偶、各順序繼承人及其配偶之贈與,視為遺產併入遺產總額。本題範例答案多處寫 3 年,並據此計算 732 萬 × 3 = 2,196 萬併入遺產。',
    ref: '遺產及贈與稅法第 15 條(全國法規資料庫);財政部臺北國稅局「死亡前 2 年內贈與」宣導',
    suggest: '建議修改:全文 3 年改為 2 年,連帶更正併入金額(732 萬 × 2 = 1,464 萬)。',
  },
  {
    id: 'X-CA-008', cat: 'A', sev: '高',
    title: '同上(3 年應為 2 年),且標準答案數字因此是錯的',
    detail:
      '題目設定「身故時 3 年內贈與併入遺產」,計算有效年數 15 − 3 = 12 年,答案 2,440,000 × 3 × 12 = 87,840,000。依正確法條(2 年)應為 15 − 2 = 13 年 → 2,440,000 × 3 × 13 = 95,160,000。這是標準答案本身錯誤,不是敘述瑕疵。',
    ref: '同上',
    suggest: '建議修改:題目與步驟改為 2 年,答案改為 95,160,000。',
  },
  {
    id: 'X-CA-009', cat: 'A', sev: '高',
    title: '個人 CFC 用 40% 邊際稅率計算 —— 應為最低稅負制 20%',
    detail:
      '個人受控外國企業(CFC)制度下,境外公司盈餘是按持股比例計算「海外營利所得」,併入所得基本稅額條例的基本所得額,按 **20%** 計算基本稅額,不是用綜合所得稅邊際稅率 40% 直接乘。另有「當年度盈餘 700 萬元以下豁免」與實質營運活動豁免,題目用「忽略免稅門檻」帶過但稅率框架仍錯。按正確制度,答案 200 萬應為 100 萬。',
    ref: '財政部賦稅署「個人受控外國企業(CFC)制度懶人包」;所得基本稅額條例',
    suggest: '建議改寫:稅率改 20%、補上 700 萬豁免門檻的說明;或整題刪除(與已刪的 X-CA-018 同類,計算框架站不住)。',
  },

  {
    id: 'X-CA-015', cat: 'C', sev: '中',
    title: '遺產稅級距為舊制,且把「保額槓桿」算成「稅務效益」',
    detail:
      '兩個問題:(1) 級距用 5,000 萬／1 億,那是 2017–2024 舊制,自 2025 年起已調整為 5,621 萬／1 億 1,242 萬(免稅額 1,333 萬未變);(2) 更值得討論的是把 1,983 萬全部稱為「稅務效益」—— 其中 1,500 萬其實來自保額槓桿(躉繳 3,000 萬換保額 4,500 萬),純粹的稅務效益只有約 483 萬。把槓桿當節稅講,是這題和已刪除的 X-CA-018 同一種毛病。',
    ref: '財政部 2024-11-28 公告(2025 年起適用之遺產稅課稅級距)',
    suggest: '建議改寫:更新級距數字,並在解析中把「保額槓桿」與「稅務效益」拆開說明。',
  },
  {
    id: 'X-CA-017', cat: 'C', sev: '中',
    title: '結論正確但步驟算式兜不攏',
    detail:
      '「舊保單 3.5% 鎖定終身、不應解約」這個結論完全正確,也是很好的教學點。但步驟有兩處對不上:(1) 80 萬全額乘以 1.035^10 卻標示為「20 年後保單價值」—— 後 40 萬是分 10 年陸續繳的,不能全額複利 10 年;(2)「新商品本金 68 萬、20 年後約 78 萬」用 2% 算不出這個數(68 萬 × 1.02^10 ≈ 82.9 萬、× 1.02^20 ≈ 101 萬)。台上若被細心的學員追問會很難收場。',
    suggest: '建議改寫:重算步驟,或改成不要求精確現值、只比較「利率差 1.5% × 20 年」的概念。',
  },
  {
    id: 'X-CA-001', cat: 'C', sev: '中',
    title: '與 X-CA-010 幾乎同一情境,但課稅基礎口徑不同',
    detail:
      '本題與 X-CA-010 都是「78 歲躉繳 3,000 萬、保額 3,500 萬、被實質課稅、稅率 20%」,但本題以躉繳保費 3,000 萬為課稅基礎(答 600 萬),X-CA-010 以保額 3,500 萬為基礎(答 700 萬)。兩題同時存在於題庫,玩過其中一題的人再遇到另一題,幾乎一定答錯 —— 這正是現場「答案模稜兩可」的來源之一。實務上實質課稅是把「保險給付」併入遺產,X-CA-010 的口徑較正確。',
    suggest: '建議二選一保留(建議留 X-CA-010),或把本題改成明確不同的情境。',
  },
  {
    id: 'X-CA-010', cat: 'C', sev: '中',
    title: '與 X-CA-001 撞題(見該題說明)',
    detail:
      '本題口徑(以保額 3,500 萬併入遺產)較符合實務,但與 X-CA-001 情境幾乎相同、答案不同。兩題留一題即可。',
    suggest: '建議保留本題、調整或刪除 X-CA-001。',
  },
  {
    id: 'X-SA-011', cat: 'C', sev: '中',
    title: '實支實付敘述語意混亂,且未反映 2024 年新制',
    detail:
      '參考答案寫「醫療險受益是同一個人時,大多數公司採『定額給付』(不是額度加總)」—— 實支實付本來就不是定額給付,這句話把「日額型 vs 實支實付」和「正副本理賠」兩件事混在一起,學員容易被繞暈。另外 2024 年 7 月起實支實付新制(回歸損害填補原則、副本理賠限縮)完全沒反映,而這正是「重複投保實支實付」這題最關鍵的當代答案。',
    suggest: '建議改寫:分開講「正副本受理」與「損害填補」,並補上 2024 年 7 月新制。',
  },

  {
    id: 'X-CA-011', cat: 'D', sev: '低',
    title: '(b) 小題的期望值算法有誤',
    detail:
      '步驟寫「即使申覆成功率 50%、期望淨效益 = 54,000 − 3,000 = 51,000」—— 體檢費 6,000 元是「一定要付」的確定成本,不該乘以 50%。正確為 0.5 × 108,000 − 6,000 = 48,000。主答案 (a) 的 108,000 不受影響,只有 (b) 的推論數字要修。',
    suggest: '建議修改:步驟最後一行改為 48,000。',
  },
  {
    id: 'X-CA-003', cat: 'D', sev: '低',
    title: '題目提示的 3^(1/30) 值略不準',
    detail:
      '題目給「3^(1/30) ≈ 1.0371」,實際約 1.0373(IRR ≈ 3.73%)。因為評分是照題目提示走,實際影響很小,但精確一點比較好。',
    suggest: '建議修改:提示改 1.0373、答案改 3.73;或維持現狀(影響低)。',
  },
  {
    id: 'X-CA-005', cat: 'D', sev: '低',
    title: '「保額 500 萬」是用不到的裝飾數據',
    detail:
      '計算只用到標準費率 20,000 與加費 80%,保額 500 萬完全沒進算式。與已刪除的 X-CA-018(給了 80% 通過率卻沒用到)是同一種毛病,只是程度輕很多 —— 學員會花時間找它該擺哪裡。',
    suggest: '建議修改:拿掉保額,或改成「每萬元保額費率」讓保額真的進算式。',
  },
  {
    id: 'X-MC-022', cat: 'D', sev: '低',
    title: '受益人身故後保險金的法律路徑寫錯(結論相同)',
    detail:
      '解析說受益人(媽媽)過世後「保險金進入爸爸的遺產」。若媽媽是在被保險人(爸爸)之後才過世,保險金請求權已經歸屬於媽媽,應進入**媽媽**的遺產;只有受益人先於被保險人死亡且未改指定時,才回到被保險人的遺產。兩種路徑的最終結論(由繼承人依法分配、業務員不介入)相同,但講錯法理會被專業學員抓到。註:本題同時也是下面「解析錯位」批次的一員。',
    suggest: '建議修改:解析補上兩種情形的區分。',
  },
  {
    id: 'X-ES-018', cat: 'D', sev: '低',
    title: '引用「保險法第 127 條住院必要性定義」—— 該條沒有這個定義',
    detail:
      '保險法第 127 條是關於「訂約時被保險人已在疾病或妊娠中,保險人不負給付責任」,並沒有住院必要性的定義。住院必要性是條款與實務見解(以及評議中心案例)在處理的問題,不是 127 條。',
    suggest: '建議修改:改引「保單條款之住院定義 + 評議中心見解」,或直接不引法條。',
  },
  {
    id: 'X-ES-005', cat: 'D', sev: '低',
    title: '第三人代繳保費引用第 117 條 —— 應為第 115 條',
    detail:
      '保險法第 115 條規定「利害關係人,均得代要保人交付保險費」;第 117 條講的是保險人不得以訴訟請求交付保險費、以及欠繳保費時的減額或終止效果。範例答案引 117 條說明「保費繳付不限於要保人本人」,條號有誤。',
    suggest: '建議修改:條號改為第 115 條。',
  },
];

// ── 解析錯位:2026-08-27 已修正,這裡讀「修正紀錄」供抽查 ─────────────
const fixRecord = read('scripts/data-scramble-fix-record.json');
const scramble = fixRecord.items.map((r) => {
  const q = byId.get(r.id);
  return { ...r, correct: q ? q.correct : '', ok: !!q && q.explanation.includes(`**${q.correct} 最優**`) };
});
// 防呆:產生審閱頁時順便確認題庫真的已修好(避免發出去的頁面說「已修正」其實沒修)
const stillBroken = ALL.filter((q) => {
  const m = (q.explanation || '').match(/優先序為\s*\*\*([A-D])\s*>/);
  return m && m[1] !== q.correct;
});
if (stillBroken.length) {
  throw new Error(`題庫仍有 ${stillBroken.length} 題解析錯位(${stillBroken.map((q) => q.id).join(',')}),請先執行修正`);
}

// ── 組資料 ────────────────────────────────────────────────────────
const pick = (q) => ({
  id: q.id,
  bank: q.bank,
  bankLabel: q.bankLabel,
  type: q.type,
  typeLabel: TYPE_LABEL[q.type] || q.type,
  topic: q.topic || '',
  layer: q.layer || '',
  question: q.question || '',
  options: q.options || null,
  correct: q.correct || '',
  explanation: q.explanation || '',
  answer: q.answer || '',
  unit: q.unit || '',
  given: q.given || null,
  steps: q.steps || null,
  keyPoints: q.key_points || null,
  modelAnswer: q.model_answer || '',
  word: q.word || '',
  contextPhrase: q.context_phrase || '',
  scenario: q.scenario || '',
  meaning: q.meaning || '',
});

const DATA = {
  builtAt: new Date().toISOString().slice(0, 10),
  fixedAt: fixRecord.fixedAt,
  counts: {
    hell: hellQs.length,
    purgatory: purgQs.length,
    findings: FINDINGS.length,
    scramble: scramble.length,
    scrambleHell: scramble.filter((s) => s.bank === 'hell').length,
    scramblePurg: scramble.filter((s) => s.bank === 'purgatory').length,
  },
  resolvedAt: RESOLVED_AT,
  findings: FINDINGS.map((f) => ({
    ...f,
    resolution: RESOLUTION[f.id] || null,
    q: byId.has(f.id) ? pick(byId.get(f.id)) : null,
  })),
  scramble: scramble.map((s) => ({ ...s, q: pick(byId.get(s.id)) })),
  all: ALL.map(pick),
};

// 檢查:題目不在題庫時,必須是「審閱判定刪除」才合理;否則是意外遺失。
for (const f of FINDINGS) {
  if (!byId.has(f.id) && RESOLUTION[f.id] !== 'delete') {
    throw new Error(`題目 ${f.id} 不在題庫,但審閱結果不是刪除 —— 可能被誤刪`);
  }
}

const json = JSON.stringify(DATA)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// ── HTML ──────────────────────────────────────────────────────────
const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>保險知識星攻略 · 題庫審閱</title>
<style>
:root{
  --bg:#f6f7f9; --surface:#fff; --surface-2:#fafbfc; --line:#e3e6ea; --line-2:#eef0f3;
  --ink:#1a1d21; --ink-2:#5a6169; --ink-3:#8b929b;
  --accent:#2f5fd8; --accent-s:#eaf0fd;
  --hi:#b4341f; --hi-s:#fdecea; --mid:#9a6408; --mid-s:#fdf3e2; --low:#4a5563; --low-s:#eef1f4;
  --ok:#1a7a4c; --ok-s:#e6f4ec;
  --shadow:0 1px 2px rgba(16,24,40,.04),0 4px 14px rgba(16,24,40,.05);
  --radius:12px;
  --font:"PingFang TC","Noto Sans TC","Microsoft JhengHei","Hiragino Sans TC",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"SFMono-Regular",Consolas,"Roboto Mono","Noto Sans TC",monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#14161a; --surface:#1c1f24; --surface-2:#22262c; --line:#2f343b; --line-2:#282d33;
    --ink:#e8eaed; --ink-2:#a8b0ba; --ink-3:#7b838d;
    --accent:#7ba1ff; --accent-s:#1e2740;
    --hi:#ff8f7a; --hi-s:#3a2320; --mid:#e5b464; --mid-s:#352b18; --low:#aab3bd; --low-s:#262b31;
    --ok:#6dd39b; --ok-s:#1b2f24;
    --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 14px rgba(0,0,0,.25);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--font);
  font-size:15px;line-height:1.75;letter-spacing:.01em}
.wrap{max-width:940px;margin:0 auto;padding:0 16px 96px}

/* ── 頂部 ── */
header{background:linear-gradient(180deg,var(--surface),var(--surface-2));border-bottom:1px solid var(--line);
  padding:28px 0 22px;margin-bottom:20px}
header .wrap{padding-bottom:0}
h1{margin:0 0 6px;font-size:22px;line-height:1.4;letter-spacing:.02em}
.sub{color:var(--ink-2);font-size:13.5px;margin:0}
.meta{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--surface);border:1px solid var(--line);
  border-radius:999px;padding:4px 12px;font-size:12.5px;color:var(--ink-2)}
.chip b{color:var(--ink);font-family:var(--mono);font-weight:600}

/* ── 說明卡 ── */
.intro{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:18px;box-shadow:var(--shadow)}
.intro h2{margin:0 0 10px;font-size:15px;letter-spacing:.02em}
.intro ol{margin:0;padding-left:22px;color:var(--ink-2);font-size:14px}
.intro li{margin:5px 0}
.intro .who{margin-top:14px;padding-top:14px;border-top:1px dashed var(--line)}
label.name{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:14px}
input[type=text]{flex:1;min-width:180px;font:inherit;font-size:14px;padding:9px 12px;border-radius:9px;
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink)}
input[type=text]:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}

/* ── 分頁 ── */
nav.tabs{position:sticky;top:0;z-index:20;background:var(--bg);padding:10px 0;margin-bottom:16px;
  border-bottom:1px solid var(--line)}
nav.tabs .row{display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
nav.tabs .row::-webkit-scrollbar{display:none}
.tab{flex:none;font:inherit;font-size:13.5px;padding:8px 14px;border-radius:9px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink-2);cursor:pointer;white-space:nowrap;transition:.15s}
.tab:hover{border-color:var(--accent);color:var(--ink)}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.tab .n{font-family:var(--mono);opacity:.85;margin-left:5px;font-size:12px}

/* ── 進度 ── */
.progress{display:flex;align-items:center;gap:12px;background:var(--surface);border:1px solid var(--line);
  border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;box-shadow:var(--shadow)}
.bar{flex:1;height:7px;background:var(--line-2);border-radius:99px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--ok);border-radius:99px;transition:width .3s;width:0}
.progress .txt{font-size:13px;color:var(--ink-2);white-space:nowrap}
.progress .txt b{color:var(--ink);font-family:var(--mono)}

/* ── 題卡 ── */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  margin-bottom:14px;box-shadow:var(--shadow);overflow:hidden}
.card.done{border-color:var(--ok)}
.chd{padding:16px 18px 0}
.tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.tag{font-size:11.5px;padding:2.5px 9px;border-radius:6px;background:var(--low-s);color:var(--low);
  border:1px solid transparent;letter-spacing:.03em}
.tag.id{font-family:var(--mono);font-weight:600;background:var(--accent-s);color:var(--accent);font-size:12px}
.tag.high{background:var(--hi-s);color:var(--hi)}
.tag.mid{background:var(--mid-s);color:var(--mid)}
.tag.done{background:var(--ok-s);color:var(--ok);margin-left:auto}
.finding{background:var(--surface-2);border:1px solid var(--line-2);border-left:3px solid var(--hi);
  border-radius:9px;padding:13px 15px;margin-bottom:14px}
.card[data-sev="中"] .finding{border-left-color:var(--mid)}
.card[data-sev="低"] .finding{border-left-color:var(--low)}
.finding h3{margin:0 0 7px;font-size:14.5px;line-height:1.6}
.finding p{margin:0 0 8px;font-size:13.5px;color:var(--ink-2);line-height:1.8}
.finding p:last-child{margin-bottom:0}
.finding .lbl{display:inline-block;font-size:11.5px;color:var(--ink-3);letter-spacing:.05em;
  margin-right:6px;font-weight:600}
.finding .sug{color:var(--ok)}

details.qd{border-top:1px solid var(--line-2);margin-top:2px}
details.qd>summary{cursor:pointer;padding:11px 18px;font-size:13px;color:var(--ink-2);
  list-style:none;user-select:none;background:var(--surface-2)}
details.qd>summary::-webkit-details-marker{display:none}
details.qd>summary::before{content:"▸ ";color:var(--ink-3)}
details.qd[open]>summary::before{content:"▾ "}
details.qd>summary:hover{color:var(--ink)}
.qbody{padding:4px 18px 16px;background:var(--surface-2)}
.qtext{white-space:pre-wrap;font-size:14px;line-height:1.85;margin:8px 0 12px}
.row{margin:10px 0}
.row .k{font-size:11.5px;color:var(--ink-3);letter-spacing:.06em;font-weight:600;margin-bottom:4px}
.opts{list-style:none;margin:0;padding:0}
.opts li{padding:7px 11px;border:1px solid var(--line);border-radius:8px;margin-bottom:5px;
  font-size:13.5px;background:var(--surface);line-height:1.7}
.opts li.right{border-color:var(--ok);background:var(--ok-s)}
.opts li b{font-family:var(--mono);margin-right:7px;color:var(--ink-2)}
.opts li.right b{color:var(--ok)}
.expl{white-space:pre-wrap;font-size:13px;color:var(--ink-2);line-height:1.85;
  background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:11px 13px;max-height:340px;overflow:auto}
.steps{margin:0;padding-left:20px;font-size:13.5px;color:var(--ink-2);font-family:var(--mono);line-height:1.9}
.kv{display:grid;grid-template-columns:auto 1fr;gap:3px 14px;font-size:13.5px}
.kv .kk{color:var(--ink-3)}
.kv .vv{font-family:var(--mono)}
.ansbox{background:var(--ok-s);border:1px solid var(--ok);border-radius:8px;padding:9px 13px;
  font-size:14px;color:var(--ok);font-weight:600;font-family:var(--mono)}

/* ── 決定區 ── */
.decide{padding:14px 18px 16px;border-top:1px solid var(--line-2)}
.opts-row{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:11px}
.pill{position:relative}
.pill input{position:absolute;opacity:0;pointer-events:none}
.pill span{display:inline-block;font-size:13.5px;padding:7px 15px;border-radius:8px;
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);cursor:pointer;transition:.15s}
.pill input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
.pill span:hover{border-color:var(--ink-3)}
.pill input:checked+span{font-weight:600;color:#fff}
.pill.del input:checked+span{background:#c0392b;border-color:#c0392b}
.pill.mod input:checked+span{background:#b8860b;border-color:#b8860b}
.pill.keep input:checked+span{background:#1a7a4c;border-color:#1a7a4c}
.pill.hold input:checked+span{background:#5a6169;border-color:#5a6169}
textarea{width:100%;font:inherit;font-size:14px;line-height:1.75;padding:11px 13px;border-radius:9px;
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink);resize:vertical;min-height:64px}
textarea:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}

/* ── 批次卡 ── */
.batch{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:18px 20px;margin-bottom:16px;box-shadow:var(--shadow)}
.batch h2{margin:0 0 8px;font-size:16px}
.batch p{margin:0 0 10px;font-size:13.5px;color:var(--ink-2);line-height:1.8}
.idlist{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0}
.idlist code{font-family:var(--mono);font-size:11.5px;background:var(--surface-2);border:1px solid var(--line);
  border-radius:5px;padding:2px 7px;color:var(--ink-2)}
.eg{background:var(--surface-2);border:1px solid var(--line-2);border-radius:9px;padding:12px 14px;margin:12px 0;font-size:13px}
.eg .k{font-size:11.5px;color:var(--ink-3);letter-spacing:.06em;font-weight:600;margin-bottom:5px}
.eg .bad{color:var(--hi)}
.eg .good{color:var(--ok)}

/* ── 搜尋 ── */
.search{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.search input{flex:1;min-width:200px}
select{font:inherit;font-size:13.5px;padding:9px 11px;border-radius:9px;border:1px solid var(--line);
  background:var(--surface-2);color:var(--ink)}

/* ── 底部列 ── */
.footbar{position:fixed;left:0;right:0;bottom:0;z-index:30;background:var(--surface);
  border-top:1px solid var(--line);box-shadow:0 -2px 14px rgba(16,24,40,.07)}
.footbar .wrap{padding:11px 16px;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.footbar .st{font-size:12.5px;color:var(--ink-2);margin-right:auto}
.footbar .st b{color:var(--ink);font-family:var(--mono)}
button.btn{font:inherit;font-size:13.5px;font-weight:600;padding:9px 17px;border-radius:9px;cursor:pointer;
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink);transition:.15s}
button.btn:hover{border-color:var(--ink-3)}
button.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.btn.primary:hover{filter:brightness(1.08)}
.hint{font-size:12.5px;color:var(--ink-3);margin-top:8px;line-height:1.7}
.toast{position:fixed;left:50%;transform:translateX(-50%);bottom:76px;z-index:50;background:var(--ink);
  color:var(--bg);padding:11px 20px;border-radius:10px;font-size:13.5px;opacity:0;pointer-events:none;
  transition:opacity .25s,transform .25s;max-width:88vw;text-align:center;line-height:1.6}
.toast.on{opacity:1;transform:translateX(-50%) translateY(-6px)}
.empty{text-align:center;color:var(--ink-3);padding:40px 20px;font-size:14px}
@media(max-width:600px){
  body{font-size:14.5px}
  h1{font-size:19px}
  .chd,.decide{padding-left:14px;padding-right:14px}
  .qbody,details.qd>summary{padding-left:14px;padding-right:14px}
  .footbar .st{width:100%;margin-bottom:2px}
}
@media print{
  nav.tabs,.footbar,.decide .opts-row,.search{display:none}
  .card{break-inside:avoid;box-shadow:none}
}
</style>
</head>
<body>

<header>
  <div class="wrap">
    <h1>保險知識星攻略 · 題庫審閱</h1>
    <p class="sub">地獄級 ＋ 煉獄級題庫稽核結果 · 請協助判定每一題要「刪除／修改／保留」</p>
    <div class="meta">
      <span class="chip">建檔 <b id="m-date"></b></span>
      <span class="chip">待判定 <b id="m-find"></b> 題</span>
      <span class="chip">解析錯位 <b id="m-scr"></b> 題</span>
      <span class="chip">題庫全量 <b id="m-all"></b> 題</span>
    </div>
  </div>
</header>

<div class="wrap">

  <div class="intro">
    <h2>這份文件要請您做什麼</h2>
    <ol>
      <li>這是保險教育訓練搶答遊戲的題庫，最近實際使用後發現部分題目的<b>答案有疑慮或法規已過時</b>。</li>
      <li>系統已先做過一輪稽核，列出<b id="i-find">—</b>題有問題的題目（下方「待判定」分頁），每題附上疑慮說明與建議。</li>
      <li>請您逐題選擇處理方式並寫下建議；不同意稽核意見也請直接寫，這正是需要專業把關的地方。</li>
      <li>另有一批<b id="i-scr">—</b>題的「解析與正解對不上」已經修好了，請到該分頁<b>抽查</b>確認修得對不對。</li>
      <li>審完後切到最後的<b>「產生回覆」</b>分頁，按一下<b>「複製全部內容」</b>，直接貼到 LINE 傳回承辦人就完成了 —— <b>不需要下載任何檔案</b>。</li>
    </ol>
    <div class="who">
      <label class="name">審閱人姓名／單位
        <input type="text" id="reviewer" placeholder="例：王大明 · 法遵部" autocomplete="name">
      </label>
      <div class="hint">填了姓名，回覆內容才分得出是誰的意見。您輸入的每一個字都會自動存在這台裝置的瀏覽器裡，關掉頁面再打開仍在（除非清除瀏覽資料）；中途離開不會白做。</div>
    </div>
  </div>

  <nav class="tabs">
    <div class="row">
      <button class="tab on" data-tab="find">待判定<span class="n" id="t-find"></span></button>
      <button class="tab" data-tab="scr">已修正抽查<span class="n" id="t-scr"></span></button>
      <button class="tab" data-tab="all">全部題目<span class="n" id="t-all"></span></button>
      <button class="tab" data-tab="sum">整體建議</button>
      <button class="tab" data-tab="out">產生回覆 ✓</button>
    </div>
  </nav>

  <div class="progress">
    <div class="bar"><i id="pbar"></i></div>
    <div class="txt">已判定 <b id="pnum">0</b> / <b id="ptot">0</b></div>
  </div>

  <main id="view"></main>
</div>

<div class="footbar">
  <div class="wrap">
    <span class="st" id="saveState">尚未輸入</span>
    <button class="btn primary" id="btn-goout">前往「產生回覆」→</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script id="bank-data" type="application/json">${json}</script>
<script>
(function(){
'use strict';
var D = JSON.parse(document.getElementById('bank-data').textContent);
var LS = 'pgg_bank_review_v1';
var DECIS = [
  {v:'delete', label:'刪除', cls:'del'},
  {v:'modify', label:'修改', cls:'mod'},
  {v:'keep',   label:'保留（無需更動）', cls:'keep'},
  {v:'hold',   label:'待討論', cls:'hold'}
];
var DECIS_LABEL = {delete:'刪除', modify:'修改', keep:'保留', hold:'待討論'};

var state = {reviewer:'', items:{}, batch:{}, general:''};
try {
  var raw = localStorage.getItem(LS);
  if (raw) { var s = JSON.parse(raw); if (s && typeof s === 'object') state = Object.assign(state, s); }
} catch(e){}
if (!state.items) state.items = {};
if (!state.batch) state.batch = {};

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function $(id){ return document.getElementById(id); }

var toastT;
function toast(msg){
  var t = $('toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(function(){ t.classList.remove('on'); }, 2600);
}

function save(){
  try { localStorage.setItem(LS, JSON.stringify(state)); }
  catch(e){ $('saveState').textContent = '⚠ 無法自動存檔（瀏覽器限制）· 請盡快匯出'; return; }
  var n = countDone();
  $('saveState').textContent = n ? ('已自動存檔 · 已判定 ' + n + ' 題') : '尚未輸入';
  updateProgress();
}
function countDone(){
  var n = 0;
  for (var k in state.items){ var it = state.items[k]; if (it && (it.decision || (it.note||'').trim())) n++; }
  return n;
}
function updateProgress(){
  var tot = D.findings.length, done = 0;
  D.findings.forEach(function(f){
    var it = state.items[f.id];
    if (it && (it.decision || (it.note||'').trim())) done++;
  });
  $('pnum').textContent = done; $('ptot').textContent = tot;
  $('pbar').style.width = tot ? Math.round(done/tot*100)+'%' : '0%';
}

/* ── 題目內容渲染 ── */
function qDetail(q){
  var h = '';
  if (q.type === 'word_game'){
    h += '<div class="row"><div class="k">字</div><div class="qtext" style="font-size:22px;margin:2px 0 8px">'+esc(q.word)+'　<span style="font-size:15px;color:var(--ink-2)">'+esc(q.contextPhrase)+'</span></div></div>';
    if (q.scenario) h += '<div class="row"><div class="k">情境</div><div class="qtext">'+esc(q.scenario)+'</div></div>';
  } else {
    h += '<div class="qtext">'+esc(q.question)+'</div>';
  }
  if (q.options){
    h += '<div class="row"><div class="k">選項</div><ul class="opts">';
    if (Array.isArray(q.options)){
      q.options.forEach(function(o){
        var right = (String(o) === String(q.correct));
        h += '<li class="'+(right?'right':'')+'">'+esc(o)+(right?'　✓':'')+'</li>';
      });
    } else {
      Object.keys(q.options).forEach(function(k){
        var right = (k === q.correct);
        h += '<li class="'+(right?'right':'')+'"><b>'+esc(k)+'</b>'+esc(q.options[k])+(right?'　✓':'')+'</li>';
      });
    }
    h += '</ul></div>';
  }
  if (q.given){
    h += '<div class="row"><div class="k">已知條件</div><div class="kv">';
    Object.keys(q.given).forEach(function(k){
      h += '<div class="kk">'+esc(k)+'</div><div class="vv">'+esc(q.given[k])+'</div>';
    });
    h += '</div></div>';
  }
  if (q.steps && q.steps.length){
    h += '<div class="row"><div class="k">解題步驟</div><ol class="steps">';
    q.steps.forEach(function(s){ h += '<li>'+esc(s)+'</li>'; });
    h += '</ol></div>';
  }
  if (q.answer){
    h += '<div class="row"><div class="k">標準答案</div><div class="ansbox">'+esc(q.answer)+(q.unit?('　'+esc(q.unit)):'')+'</div></div>';
  }
  if (q.correct && !q.options){
    h += '<div class="row"><div class="k">正解</div><div class="ansbox">'+esc(q.correct)+'</div></div>';
  }
  if (q.meaning) h += '<div class="row"><div class="k">字義</div><div class="qtext">'+esc(q.meaning)+'</div></div>';
  if (q.keyPoints && q.keyPoints.length){
    h += '<div class="row"><div class="k">評分要點</div><ul class="opts">';
    q.keyPoints.forEach(function(k){ h += '<li>'+esc(k)+'</li>'; });
    h += '</ul></div>';
  }
  if (q.modelAnswer) h += '<div class="row"><div class="k">參考答案</div><div class="expl">'+esc(q.modelAnswer)+'</div></div>';
  if (q.explanation) h += '<div class="row"><div class="k">解析</div><div class="expl">'+esc(q.explanation)+'</div></div>';
  return h;
}

function decideBlock(key, placeholder){
  var it = state.items[key] || {};
  var h = '<div class="decide"><div class="opts-row">';
  DECIS.forEach(function(d){
    h += '<label class="pill '+d.cls+'"><input type="radio" name="d_'+esc(key)+'" value="'+d.v+'"'+
         (it.decision===d.v?' checked':'')+' data-key="'+esc(key)+'"><span>'+d.label+'</span></label>';
  });
  h += '</div><textarea data-note="'+esc(key)+'" placeholder="'+esc(placeholder)+'">'+esc(it.note||'')+'</textarea></div>';
  return h;
}

function findingCard(f){
  var it = state.items[f.id] || {};
  var done = !!(it.decision || (it.note||'').trim());
  var sevCls = f.sev==='高'?'high':(f.sev==='中'?'mid':'');
  var catLabel = {A:'法規錯誤／過時', C:'框架牽強', D:'細節瑕疵'}[f.cat] || f.cat;
  var h = '<article class="card'+(done?' done':'')+'" data-sev="'+esc(f.sev)+'" data-id="'+esc(f.id)+'">';
  h += '<div class="chd"><div class="tags">';
  h += '<span class="tag id">'+esc(f.id)+'</span>';
  if (f.q){
    h += '<span class="tag">'+esc(f.q.bankLabel)+'級</span>';
    h += '<span class="tag">'+esc(f.q.typeLabel)+'</span>';
    if (f.q.topic) h += '<span class="tag">'+esc(f.q.topic)+'</span>';
  }
  h += '<span class="tag '+sevCls+'">'+esc(catLabel)+' · '+esc(f.sev)+'</span>';
  if (f.resolution){
    h += '<span class="tag" style="background:var(--ok-s);color:var(--ok);margin-left:auto">✓ '
       + esc(D.resolvedAt) + ' 已' + (f.resolution==='delete'?'刪除':'修改') + '</span>';
  } else if (done) {
    h += '<span class="tag done">已判定：'+esc(DECIS_LABEL[it.decision]||'已填備註')+'</span>';
  }
  h += '</div>';
  h += '<div class="finding"><h3>'+esc(f.title)+'</h3><p>'+esc(f.detail)+'</p>';
  if (f.ref) h += '<p><span class="lbl">依據</span>'+esc(f.ref)+'</p>';
  if (f.note) h += '<p><span class="lbl">備註</span>'+esc(f.note)+'</p>';
  h += '<p class="sug"><span class="lbl">系統建議</span>'+esc(f.suggest)+'</p></div></div>';
  if (f.q){
    h += '<details class="qd"><summary>展開題目原文與答案</summary><div class="qbody">'
       + qDetail(f.q) + '</div></details>';
  } else {
    h += '<div style="padding:11px 18px;background:var(--surface-2);border-top:1px solid var(--line-2);'
       + 'font-size:13px;color:var(--ink-2)">本題已依審閱結果自題庫刪除，原文不再顯示。</div>';
  }
  h += decideBlock(f.id, '請寫下您的判斷與建議改法（例如：法規已改為 120 萬，選項與解析一併更新；或：此題我認為維持原樣即可，理由…）');
  h += '</article>';
  return h;
}

function browseCard(q){
  var it = state.items[q.id] || {};
  var done = !!(it.decision || (it.note||'').trim());
  var h = '<article class="card'+(done?' done':'')+'" data-id="'+esc(q.id)+'">';
  h += '<details class="qd" style="border-top:none"><summary style="background:var(--surface)">';
  h += '<span class="tag id">'+esc(q.id)+'</span> ';
  h += '<span class="tag">'+esc(q.bankLabel)+'</span> ';
  h += '<span class="tag">'+esc(q.typeLabel)+'</span> ';
  if (done) h += '<span class="tag done" style="margin-left:6px">已標記</span> ';
  h += '<br><span style="display:inline-block;margin-top:7px;color:var(--ink)">'+
       esc((q.type==='word_game' ? (q.word+'（'+q.contextPhrase+'）') : q.question).slice(0,58))+'…</span>';
  h += '</summary><div class="qbody">'+qDetail(q)+'</div></details>';
  h += decideBlock(q.id, '若這題也有問題，請寫下您發現的疑慮（沒問題就不用填）');
  h += '</article>';
  return h;
}

/* ── 分頁 ── */
var currentTab = 'find';
function render(){
  var v = $('view');
  if (currentTab === 'find'){
    var order = {'A':0,'C':1,'D':2};
    var list = D.findings.slice().sort(function(a,b){
      return (order[a.cat]-order[b.cat]) || a.id.localeCompare(b.id);
    });
    var h = '';
    var lastCat = null;
    list.forEach(function(f){
      if (f.cat !== lastCat){
        lastCat = f.cat;
        var t = {A:'A · 法規錯誤或已過時（建議優先處理）', C:'C · 題目框架牽強（建議改寫）', D:'D · 細節瑕疵（影響較小）'}[f.cat];
        h += '<h2 style="margin:26px 0 12px;font-size:15px;letter-spacing:.03em;color:var(--ink-2)">'+esc(t)+'</h2>';
      }
      h += findingCard(f);
    });
    v.innerHTML = h;
  } else if (currentTab === 'scr'){
    var hellIds = D.scramble.filter(function(s){return s.bank==='hell';});
    var purgIds = D.scramble.filter(function(s){return s.bank==='purgatory';});
    var eg = D.scramble.filter(function(s){return s.bank==='hell';})[0] || D.scramble[0];
    var b = state.batch || {};
    var h = '<div class="batch"><h2>解析與正解對不上（'+D.scramble.length+' 題）· 已於 '+esc(D.fixedAt)+' 修正</h2>';
    h += '<p>這批情境選擇題的<b>選項曾經被重新排列</b>，正解欄位有跟著更新，但<b>解析文字裡的 A／B／C／D 沒有更新</b>。現場的症狀是：公佈答案是甲選項，投影出的解析卻在誇獎乙選項——學員直覺認為「答案有問題」。</p>';
    h += '<p>因為<b>題目與正解本身都是對的</b>，這批不需要刪題，只要把解析裡的字母重新對應回它實際描述的選項即可，<b>解析內容一個字都沒有更動</b>。這 '+D.scramble.length+' 題都已修好，並加上了自動檢查防止再犯。</p>';
    if (eg){
      h += '<div class="eg"><div class="k">修正實例：'+esc(eg.id)+'（正解 '+esc(eg.correct)+'）</div>';
      h += '<div class="bad">修正前：優先序為 '+esc(eg.oldOrder.split(">").join(" > "))+'　←　最優寫成 '+esc(eg.oldOrder[0])+'，與正解 '+esc(eg.correct)+' 不符</div>';
      h += '<div class="good" style="margin-top:5px">修正後：優先序為 '+esc(eg.newOrder.split(">").join(" > "))+'　←　最優 '+esc(eg.newOrder[0])+' ＝ 正解</div></div>';
    }
    h += '<p class="hint" style="margin-top:12px">下方逐題列出「修正前 → 修正後」，可展開核對現在的選項與解析是否吻合。<b>不需要每題都看</b>，抽查幾題確認方向正確即可。</p>';
    h += '<div style="margin-top:16px;padding-top:16px;border-top:1px dashed var(--line)">';
    h += '<div class="k" style="font-size:11.5px;color:var(--ink-3);letter-spacing:.06em;font-weight:600;margin-bottom:8px">抽查結果</div>';
    h += '<div class="opts-row">';
    [{v:'agree',label:'抽查過，修得正確',cls:'keep'},
     {v:'review',label:'有幾題怪怪的（下方註明）',cls:'mod'},
     {v:'other',label:'還沒看',cls:'hold'}].forEach(function(d){
      h += '<label class="pill '+d.cls+'"><input type="radio" name="batch_d" value="'+d.v+'"'+(b.decision===d.v?' checked':'')+'><span>'+d.label+'</span></label>';
    });
    h += '</div><textarea id="batch-note" placeholder="抽查意見（可留空）">'+esc(b.note||'')+'</textarea></div></div>';
    D.scramble.forEach(function(s){
      var q = s.q;
      var it = state.items[q.id] || {};
      var done = !!(it.decision || (it.note||'').trim());
      h += '<article class="card'+(done?' done':'')+'" data-id="'+esc(q.id)+'">';
      h += '<div class="chd"><div class="tags"><span class="tag id">'+esc(q.id)+'</span>';
      h += '<span class="tag">'+esc(q.bankLabel)+'級</span>';
      if (q.topic) h += '<span class="tag">'+esc(q.topic)+'</span>';
      h += '<span class="tag" style="background:var(--ok-s);color:var(--ok)">'+esc(s.oldOrder)+' → '+esc(s.newOrder)+'　正解 '+esc(s.correct)+'</span>';
      if (done) h += '<span class="tag done">已填意見</span>';
      h += '</div></div>';
      h += '<details class="qd"><summary>展開題目、選項與修正後的解析</summary><div class="qbody">'+qDetail(q)+'</div></details>';
      h += decideBlock(q.id, '這題的個別意見（可留空）');
      h += '</article>';
    });
    v.innerHTML = h;
  } else if (currentTab === 'all'){
    var h = '<div class="search">';
    h += '<input type="text" id="q-search" placeholder="搜尋題號、關鍵字…（例：X-CA、遺產稅、告知義務）">';
    h += '<select id="q-bank"><option value="">全部題庫</option><option value="hell">地獄級</option><option value="purgatory">煉獄級</option></select>';
    h += '<select id="q-type"><option value="">全部題型</option>';
    var types = {};
    D.all.forEach(function(q){ types[q.type] = q.typeLabel; });
    Object.keys(types).forEach(function(t){ h += '<option value="'+esc(t)+'">'+esc(types[t])+'</option>'; });
    h += '</select></div><p class="hint" style="margin:-6px 0 14px">這裡是完整題庫。若您發現稽核沒抓到的問題，請直接在該題填寫。</p><div id="all-list"></div>';
    v.innerHTML = h;
    var doFilter = function(){
      var kw = ($('q-search').value||'').trim().toLowerCase();
      var bk = $('q-bank').value, tp = $('q-type').value;
      var list = D.all.filter(function(q){
        if (bk && q.bank !== bk) return false;
        if (tp && q.type !== tp) return false;
        if (!kw) return true;
        var hay = (q.id+' '+q.question+' '+q.topic+' '+q.word+' '+q.contextPhrase+' '+q.answer+' '+q.modelAnswer).toLowerCase();
        return hay.indexOf(kw) >= 0;
      });
      $('all-list').innerHTML = list.length
        ? list.map(browseCard).join('')
        : '<div class="empty">沒有符合的題目</div>';
    };
    $('q-search').addEventListener('input', doFilter);
    $('q-bank').addEventListener('change', doFilter);
    $('q-type').addEventListener('change', doFilter);
    doFilter();
  } else if (currentTab === 'sum'){
    var h = '<div class="batch"><h2>整體建議</h2>';
    h += '<p>對這份題庫的整體觀察、共通的問題模式、或您認為應該補強的方向，都可以寫在這裡。</p>';
    h += '<textarea id="general" style="min-height:220px" placeholder="例：&#10;· 高資產稅務類的題目普遍停留在 2023 年前的法規，建議整批盤點&#10;· 情境題的「最適切做法」本質上有多解，建議改為評分式而非單選&#10;· 建議補上 2024 年 7 月實支實付新制的相關題目">'+esc(state.general||'')+'</textarea>';
    h += '<div class="hint">寫完後按右下角「匯出審閱結果」。</div></div>';
    v.innerHTML = h;
    $('general').addEventListener('input', function(){ state.general = this.value; save(); });
  } else if (currentTab === 'out'){
    var txt = buildPrompt();
    var stats = promptStats();
    var h = '<div class="batch"><h2>產生回覆 · 複製後用 LINE 傳回即可</h2>';
    if (!state.reviewer || !state.reviewer.trim()){
      h += '<p style="color:var(--hi)">⚠ 還沒填「審閱人姓名」（在最上方的說明卡片裡）。沒填也可以傳，但承辦人會不知道是誰的意見。</p>';
    }
    h += '<p>下面是您這次審閱的完整結果。按<b>「複製全部內容」</b>，再貼到 LINE 傳給承辦人就完成了。<b>不需要下載檔案、不需要存檔。</b></p>';
    h += '<div class="eg"><div class="k">內容摘要</div>';
    h += '<div>逐題判定 <b>'+stats.answered+'</b> / '+stats.total+' 題';
    if (stats.extra) h += '　·　您額外標記 <b>'+stats.extra+'</b> 題';
    if (stats.batch) h += '　·　含已修正批次的抽查意見';
    if (stats.general) h += '　·　含整體建議';
    h += '</div></div>';
    if (!stats.answered && !stats.extra && !stats.batch && !stats.general){
      h += '<p style="color:var(--hi)">目前還沒有任何意見。請先到「待判定」分頁填寫，再回來這裡複製。</p>';
    }
    h += '<div class="k" style="font-size:11.5px;color:var(--ink-3);letter-spacing:.06em;font-weight:600;margin:16px 0 6px">回覆內容（可直接編輯）</div>';
    h += '<textarea id="prompt-box" style="min-height:340px;font-size:13px;line-height:1.7">'+esc(txt)+'</textarea>';
    h += '<div class="opts-row" style="margin-top:12px">';
    h += '<button class="btn primary" id="btn-copy-prompt" style="font-size:14px;padding:11px 22px">📋 複製全部內容</button>';
    h += '<button class="btn" id="btn-refresh-prompt">重新產生</button>';
    h += '</div>';
    h += '<div class="hint">複製後如果 LINE 顯示不完整，分兩則貼上也可以，順序不影響。</div></div>';
    v.innerHTML = h;
    $('btn-copy-prompt').addEventListener('click', function(){
      copyText($('prompt-box').value, '已複製！現在貼到 LINE 傳給承辦人就完成了');
    });
    $('btn-refresh-prompt').addEventListener('click', function(){
      $('prompt-box').value = buildPrompt();
      toast('已依最新輸入重新產生');
    });
  }
}

/* ── 提示詞產生 ── */
function promptStats(){
  var answered = 0, extra = 0;
  var findIds = {}; D.findings.forEach(function(f){ findIds[f.id] = 1; });
  Object.keys(state.items).forEach(function(id){
    var it = state.items[id];
    if (!it || (!it.decision && !(it.note||'').trim())) return;
    if (findIds[id]) answered++; else extra++;
  });
  return {
    answered: answered, total: D.findings.length, extra: extra,
    batch: !!(state.batch && (state.batch.decision || (state.batch.note||'').trim())),
    general: !!(state.general||'').trim()
  };
}
function buildPrompt(){
  var findMap = {}; D.findings.forEach(function(f){ findMap[f.id] = f; });
  var scrMap = {}; D.scramble.forEach(function(s){ scrMap[s.id] = s; });
  var qMap = {}; D.all.forEach(function(q){ qMap[q.id] = q; });
  var st = promptStats();
  var now = new Date();
  var pad = function(n){ return (n<10?'0':'')+n; };
  var when = now.getFullYear()+'-'+pad(now.getMonth()+1)+'-'+pad(now.getDate());

  var CN = ["一","二","三","四","五"], ci = 0;
  var NUM = function(){ return CN[ci++] || String(ci); };
  var L = [];
  L.push('【保險題庫審閱回覆】');
  L.push('審閱人：' + ((state.reviewer||'').trim() || '（未署名）'));
  L.push('審閱日期：' + when);
  L.push('進度：稽核提出的 ' + st.total + ' 題中已判定 ' + st.answered + ' 題'
         + (st.extra ? '，另自行標記 ' + st.extra + ' 題' : ''));
  L.push('');

  // 1. 稽核題的判定
  var findRows = D.findings.map(function(f){
    var it = state.items[f.id];
    if (!it || (!it.decision && !(it.note||'').trim())) return null;
    return {f:f, it:it};
  }).filter(Boolean);
  if (findRows.length){
    L.push('═══ ' + NUM() + '、稽核提出的問題題目 ═══');
    var catName = {A:'A 法規錯誤／過時', C:'C 框架牽強', D:'D 細節瑕疵'};
    var lastCat = null;
    findRows.sort(function(a,b){
      var o = {A:0,C:1,D:2};
      return (o[a.f.cat]-o[b.f.cat]) || a.f.id.localeCompare(b.f.id);
    }).forEach(function(r){
      if (r.f.cat !== lastCat){ lastCat = r.f.cat; L.push(''); L.push('── ' + catName[r.f.cat] + ' ──'); }
      L.push('');
      L.push('[' + r.f.id + '] ' + (DECIS_LABEL[r.it.decision] || '（未選處理方式）'));
      L.push('  問題：' + r.f.title);
      if ((r.it.note||'').trim()) L.push('  審閱意見：' + r.it.note.trim().replace(/\\n/g, '\\n　　'));
    });
    L.push('');
  }

  // 2. 額外標記的題目
  var extraRows = Object.keys(state.items).map(function(id){
    var it = state.items[id];
    if (!it || (!it.decision && !(it.note||'').trim())) return null;
    if (findMap[id]) return null;
    return {id:id, it:it, scr:scrMap[id], q:qMap[id]};
  }).filter(Boolean).sort(function(a,b){ return a.id.localeCompare(b.id); });
  var scrRows = extraRows.filter(function(r){ return r.scr; });
  var newRows = extraRows.filter(function(r){ return !r.scr; });

  if (newRows.length){
    L.push('═══ ' + NUM() + '、審閱人額外發現的問題（稽核未提出）═══');
    newRows.forEach(function(r){
      L.push('');
      L.push('[' + r.id + '] ' + (DECIS_LABEL[r.it.decision] || '（未選處理方式）'));
      if (r.q) L.push('  題目：' + String(r.q.question || r.q.word || '').replace(/\\n/g,' ').slice(0, 60) + '…');
      if ((r.it.note||'').trim()) L.push('  審閱意見：' + r.it.note.trim().replace(/\\n/g, '\\n　　'));
    });
    L.push('');
  }

  // 3. 已修正批次的抽查
  if (st.batch || scrRows.length){
    L.push('═══ ' + NUM() + '、已修正的 ' + D.scramble.length + ' 題「解析錯位」抽查 ═══');
    if (state.batch && state.batch.decision){
      var bl = {agree:'抽查過，修得正確', review:'有幾題怪怪的', other:'還沒看'};
      L.push('整體：' + (bl[state.batch.decision] || state.batch.decision));
    }
    if (state.batch && (state.batch.note||'').trim()) L.push('說明：' + state.batch.note.trim());
    scrRows.forEach(function(r){
      L.push('');
      L.push('[' + r.id + '] ' + (DECIS_LABEL[r.it.decision] || '（意見）') + '　（修正 ' + r.scr.oldOrder + ' → ' + r.scr.newOrder + '）');
      if ((r.it.note||'').trim()) L.push('  審閱意見：' + r.it.note.trim().replace(/\\n/g, '\\n　　'));
    });
    L.push('');
  }

  // 4. 整體建議
  if (st.general){
    L.push('═══ ' + NUM() + '、整體建議 ═══');
    L.push((state.general||'').trim());
    L.push('');
  }

  L.push('───────────────');
  L.push('以上是外部專家對題庫的審閱結果，請依此修改題庫，並回報每一項的處理情況。');
  L.push('（題號對應 public/data/ 底下的題庫檔；X- 開頭為地獄級、P- 為煉獄級、H- 困難、M- 普通、E- 簡單。）');
  return L.join('\\n');
}
function copyText(text, okMsg){
  var done = function(){ toast(okMsg || '已複製'); };
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(done, function(){ fallbackCopy(text, done); });
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, cb){
  var ta = document.createElement('textarea');
  ta.value = text; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); cb(); }
  catch(e){ toast('自動複製失敗 · 請手動選取上方文字框的內容複製'); }
  ta.remove();
}

/* ── 事件（委派）── */
document.addEventListener('change', function(e){
  var t = e.target;
  if (t.name === 'batch_d'){
    state.batch = state.batch || {};
    state.batch.decision = t.value;
    save(); return;
  }
  var key = t.getAttribute('data-key');
  if (key && t.type === 'radio'){
    state.items[key] = state.items[key] || {};
    state.items[key].decision = t.value;
    save();
    var card = t.closest('.card');
    if (card){ card.classList.add('done'); refreshBadge(card, key); }
  }
});
document.addEventListener('input', function(e){
  var t = e.target;
  if (t.id === 'batch-note'){
    state.batch = state.batch || {};
    state.batch.note = t.value; save(); return;
  }
  if (t.id === 'reviewer'){ state.reviewer = t.value; save(); return; }
  var nk = t.getAttribute('data-note');
  if (nk){
    state.items[nk] = state.items[nk] || {};
    state.items[nk].note = t.value;
    save();
    var card = t.closest('.card');
    if (card){
      var it = state.items[nk];
      card.classList.toggle('done', !!(it.decision || (it.note||'').trim()));
      refreshBadge(card, nk);
    }
  }
});
function refreshBadge(card, key){
  var it = state.items[key] || {};
  var tags = card.querySelector('.tags');
  if (!tags) return;
  var old = tags.querySelector('.tag.done');
  var label = it.decision ? ('已判定：'+(DECIS_LABEL[it.decision]||'')) : ((it.note||'').trim() ? '已填備註' : '');
  if (!label){ if (old) old.remove(); return; }
  if (old) { old.textContent = label; }
  else { var s = document.createElement('span'); s.className='tag done'; s.textContent = label; tags.appendChild(s); }
}

document.querySelectorAll('.tab').forEach(function(b){
  b.addEventListener('click', function(){
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('on'); });
    b.classList.add('on');
    currentTab = b.getAttribute('data-tab');
    render();
    window.scrollTo({top:0, behavior:'smooth'});
  });
});


/* 底部主按鈕:跳到「產生回覆」分頁 */
$('btn-goout').addEventListener('click', function(){
  var tab = document.querySelector('.tab[data-tab="out"]');
  if (tab) tab.click();
});

/* ── 啟動 ── */
$('m-date').textContent = D.builtAt;
$('m-find').textContent = D.counts.findings;
$('m-scr').textContent = D.counts.scramble;
$('m-all').textContent = D.counts.hell + D.counts.purgatory;
$('i-find').textContent = D.counts.findings;
$('i-scr').textContent = D.counts.scramble;
$('t-find').textContent = D.counts.findings;
$('t-scr').textContent = D.counts.scramble;
$('t-all').textContent = D.counts.hell + D.counts.purgatory;
$('reviewer').value = state.reviewer || '';
render();
save();
})();
</script>
</body>
</html>
`;

const OUT = resolve(ROOT, 'bank-review.html');
writeFileSync(OUT, html, 'utf8');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
console.log(`✅ 已產生 ${OUT}`);
console.log(`   待判定 ${FINDINGS.length} 題 · 解析錯位 ${scramble.length} 題（地獄 ${DATA.counts.scrambleHell}、煉獄 ${DATA.counts.scramblePurg}）· 全量 ${ALL.length} 題 · ${kb} KB`);
