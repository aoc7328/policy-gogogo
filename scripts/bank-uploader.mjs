#!/usr/bin/env node
/**
 * bank-uploader.mjs — 本地題庫更新工具
 *
 * 啟動方式:雙擊根目錄的 bank-uploader.bat。
 * 它會 listen 在 http://localhost:3001 並自動開瀏覽器。
 * 介面上選 1~5 個 JSON 檔(任何檔名都可,工具自動改名),按確認 →
 * 寫到 public/data/ → git pull/add/commit/push → npm run deploy。
 * 進度即時 streaming 到頁面上。
 */

import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = resolve(ROOT, 'public', 'data');
const PORT = 3001;
const MAX_BODY = 5 * 1024 * 1024;

const DIFFICULTIES = [
  { id: 'easy',      label: '簡單', filename: 'insurance-quiz-bank-easy.json' },
  { id: 'medium',    label: '中等', filename: 'insurance-quiz-bank-medium.json' },
  { id: 'hard',      label: '困難', filename: 'insurance-quiz-bank-hard.json' },
  { id: 'hell',      label: '地獄', filename: 'insurance-quiz-bank-hell.json' },
  { id: 'purgatory', label: '煉獄', filename: 'insurance-quiz-bank-purgatory.json' },
];

const HTML = `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<title>題庫更新工具</title>
<style>
*{box-sizing:border-box}
body{font-family:"Noto Sans TC",system-ui,sans-serif;background:#050912;color:#F2EDE1;margin:0;padding:24px;line-height:1.6}
header{display:flex;justify-content:space-between;align-items:center;padding-bottom:16px;border-bottom:1px solid #2a3040;margin-bottom:24px;max-width:720px;margin-left:auto;margin-right:auto}
h1{margin:0;font-size:18px;letter-spacing:.12em}
.help-btn{background:transparent;border:1px solid #5C6480;color:#D4A34B;padding:8px 16px;cursor:pointer;font-family:monospace;letter-spacing:.14em;font-size:12px}
.help-btn:hover{border-color:#D4A34B}
main{max-width:720px;margin:0 auto}
.intro{color:#9BA3B5;font-size:14px;margin-bottom:20px}
.row{display:grid;grid-template-columns:80px 1fr 110px;gap:16px;align-items:center;background:#0B1020;padding:12px 16px;margin-bottom:8px;border:1px solid #2a3040}
.row .label{font-weight:700}
.row input[type=file]{background:#050912;color:#F2EDE1;border:1px solid #5C6480;padding:6px 8px;font-family:monospace;font-size:12px;cursor:pointer}
.row .status{color:#5C6480;font-family:monospace;font-size:11px;text-align:right}
.row .status.set{color:#88C765}
.submit{width:100%;margin-top:16px;padding:16px;background:#D4A34B;border:none;color:#050912;font-family:monospace;font-size:14px;font-weight:700;letter-spacing:.2em;cursor:pointer}
.submit:hover:not(:disabled){background:#EDC266}
.submit:disabled{background:#2a3040;color:#5C6480;cursor:not-allowed}
.log{background:#000;color:#88C765;font-family:monospace;font-size:12px;padding:16px;margin-top:20px;white-space:pre-wrap;max-height:480px;overflow-y:auto;border:1px solid #2a3040}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;padding:24px;z-index:100}
.modal.hidden{display:none}
.modal-content{background:#0B1020;border:1px solid #5C6480;padding:32px;max-width:720px;width:100%;max-height:90vh;overflow-y:auto}
.modal h2{margin-top:0;color:#D4A34B;letter-spacing:.12em}
.modal h3{color:#D4A34B;margin-top:24px;margin-bottom:8px;font-size:15px}
.modal code{background:#050912;padding:2px 6px;color:#88C765;font-size:13px;border-radius:2px}
.modal ul,.modal ol{margin-top:8px;padding-left:24px}
.modal li{margin-bottom:4px}
.modal-close{margin-top:24px;padding:10px 24px;background:#D4A34B;border:none;color:#050912;font-weight:700;cursor:pointer;letter-spacing:.14em}
.copy-wrap{position:relative;margin:8px 0}
.copy-btn{position:absolute;top:8px;right:8px;background:#0B1020;border:1px solid #5C6480;color:#D4A34B;padding:4px 10px;font-family:monospace;font-size:11px;letter-spacing:.1em;cursor:pointer;z-index:1}
.copy-btn:hover{border-color:#D4A34B;background:#141B2E}
.copy-wrap pre{margin:0;padding-right:80px}
</style>
</head>
<body>
<header>
<h1>保險知識星攻略 · 題庫更新工具</h1>
<button class="help-btn" onclick="document.getElementById('help-modal').classList.remove('hidden')">說明</button>
</header>
<main>
<p class="intro">把要更新的難度檔案各自選好,按下方按鈕。沒選的難度不會被動到 — 例如只想換「煉獄」就只選那一格。電腦上的檔名隨便取,工具會自動改成正確檔名再放進去。</p>
${DIFFICULTIES.map(d => `<label class="row" for="f-${d.id}">
<span class="label">${d.label}</span>
<input type="file" id="f-${d.id}" accept=".json" onchange="onPick('${d.id}', this)">
<span class="status" id="s-${d.id}">未選</span>
</label>`).join('')}
<button class="submit" id="submit-btn" onclick="doSubmit()" disabled>確認上傳並部署</button>
<div class="log" id="log" style="display:none"></div>
</main>
<div class="modal hidden" id="help-modal">
<div class="modal-content">
<h2>使用說明 / 重要規範</h2>

<h3>1. 檔名 — 不用管</h3>
<p>你電腦上的檔名隨便取(例如 history-easy.json、20260427-banks/easy.json),工具會自動改成正確的檔名(<code>insurance-quiz-bank-{難度}.json</code>)再寫入專案。</p>

<h3>2. JSON 結構必須遵守</h3>
<p>每個檔案頂層必須有兩個 key:</p>
<ul>
<li><code>metadata</code> — 題庫描述資訊(name, version 等)</li>
<li><code>questions</code> — 實際題目</li>
</ul>
<p>「煉獄」的 <code>questions</code> 是<strong>扁平陣列</strong>(framework B);其他四個難度是<strong>巢狀物件</strong>(按題型分組,framework A)。直接打開現有的 JSON 仿照寫就對了。</p>

<h3>3. 題目 ID 規則</h3>
<p>每一題都有 <code>id</code>,格式 <code>{prefix}-{type}-{number}</code>。prefix 是難度識別碼:</p>
<ul>
<li>簡單:<code>E</code>(例 <code>E-SA-001</code>)</li>
<li>中等:<code>M</code></li>
<li>困難:<code>H</code></li>
<li>地獄:<code>X</code></li>
<li>煉獄:<code>P</code></li>
</ul>
<p>type 是題型代碼:<code>SA</code>(簡答)/ <code>MC</code>(選擇)/ <code>ES</code>(申論)/ <code>CALC</code>(計算)/ <code>WG</code>(玩字遊戲)。</p>
<p>id <strong>必須在同一檔案裡 unique</strong>(不能重複),否則 server 抽題會錯亂。建議連號 001、002...。</p>

<h3>4. 框架(分類)— 跟著題庫走</h3>
<p>題庫的 <code>metadata</code> 必須宣告自己的框架(分類)清單,server 跟三端 UI 全部都讀這個。換主題就是換清單,不再寫死保險。</p>
<p>結構長這樣(右上角可一鍵複製):</p>
<div class="copy-wrap">
<button class="copy-btn" onclick="copyPre(this)">複製</button>
<pre style="background:#050912;color:#88C765;padding:12px;font-size:12px;line-height:1.6;overflow-x:auto;border:1px solid #2a3040">{
  "metadata": {
    "name": "中國史題庫",
    "frameworks": {
      "A": [
        "上古傳說", "夏商周", "春秋戰國",
        "秦漢", "魏晉南北朝", "隋唐",
        "宋元", "明清", "近現代"
      ],
      "B": [
        "重大戰役", "文化思潮", "制度變革", "人物評價"
      ]
    }
  },
  "questions": { ... }
}</pre>
</div>
<ul>
<li><strong>frameworks.A</strong> — 1~9 個分類,簡單/中等/困難/地獄共用。對應到 9 宮格 UI(<code>F1</code> = 第一個、<code>F2</code> = 第二個...,以陣列順序)</li>
<li><strong>frameworks.B</strong> — 1~4 個分類,煉獄專用。對應到煉獄畫面(<code>L1</code>~<code>L4</code>)</li>
<li><strong>少於 9 / 4 個怎麼辦?</strong> — 也行,UI 會把多餘格子變灰色不可選。但<strong>建議湊滿</strong>,使用者體驗較完整</li>
</ul>
<p>每題的 <code>topic</code> 欄位<strong>必須完全等於 frameworks 清單裡的某一個字串</strong>(連標點都要一樣),否則 server 抽題時這題會被排除。</p>
<p>例如,中國史 metadata 宣告「上古傳說」是 framework A 的第一格,題目就要寫(右上角可一鍵複製):</p>
<div class="copy-wrap">
<button class="copy-btn" onclick="copyPre(this)">複製</button>
<pre style="background:#050912;color:#88C765;padding:12px;font-size:12px;line-height:1.6;border:1px solid #2a3040">{
  "id": "E-MC-001",
  "topic": "上古傳說",
  "question": "..."
}</pre>
</div>
<p>(三端 UI 不再認識「保險基礎與法規」這 9 個固定保險分類了 — 從這次重構之後,完全跟著 metadata 走。所以你想換成歷史、地理、人文、自然,都只要改 metadata + 題目的 topic,三端會自動切。)</p>

<h3>5. 各題型必填欄位</h3>
<ul>
<li><code>short_answer</code>(簡答):id, topic, question, answer</li>
<li><code>multiple_choice</code>(選擇):id, topic, question, options, correct, explanation</li>
<li><code>essay</code>(申論):id, topic, question, key_points, model_answer</li>
<li><code>calculation</code>(計算):id, topic, question, given, steps, answer, unit</li>
<li><code>word_game</code>(玩字):id, topic, word, options, correct</li>
</ul>
<p>少欄位的話 server 抽到這題會報錯,題庫驗證程式也會抓出來。</p>

<h3>6. 上傳之後會發生什麼</h3>
<ol>
<li>檔案被改名後寫入 <code>public/data/</code></li>
<li>git pull → add → commit → push(Cloudflare Pages 自動 redeploy 前端)</li>
<li>npm run deploy(把新題庫推到 PartyKit server)</li>
<li>大概 1~2 分鐘後新題庫上線,玩家連進來就吃新題目</li>
</ol>

<h3>7. 失敗了怎麼辦</h3>
<p>進度面板會把每一步的錯誤紅字印出來。常見的:</p>
<ul>
<li>JSON 格式錯 → 自己用 jsonlint.com 檢查或請 Claude 幫忙</li>
<li>git push 被拒 → 可能是有衝突,跟 Claude 說</li>
<li>partykit deploy 失敗 → 可能是登入過期,終端機跑一次 <code>npx partykit login</code></li>
</ul>

<button class="modal-close" onclick="document.getElementById('help-modal').classList.add('hidden')">關閉</button>
</div>
</div>
<script>
const files = {};

// 一鍵複製:讀按鈕 next sibling(<pre>)的純文字內容到剪貼簿。
// 在 localhost 上 navigator.clipboard 可用,不需要 https。
function copyPre(btn) {
  const pre = btn.nextElementSibling;
  if (!pre) return;
  const text = pre.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = '已複製 ✓';
    btn.style.color = '#88C765';
    btn.style.borderColor = '#88C765';
    setTimeout(() => {
      btn.textContent = orig;
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 1500);
  }).catch(err => {
    btn.textContent = '複製失敗';
    console.error('clipboard write failed', err);
    setTimeout(() => { btn.textContent = '複製'; }, 1500);
  });
}

function onPick(id, input) {
  const f = input.files[0];
  const status = document.getElementById('s-' + id);
  if (!f) {
    delete files[id];
    status.textContent = '未選';
    status.classList.remove('set');
    updateBtn();
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    files[id] = e.target.result;
    status.textContent = (f.size / 1024).toFixed(1) + ' KB';
    status.classList.add('set');
    updateBtn();
  };
  reader.readAsText(f);
}
function updateBtn() {
  document.getElementById('submit-btn').disabled = Object.keys(files).length === 0;
}
async function doSubmit() {
  const btn = document.getElementById('submit-btn');
  const log = document.getElementById('log');
  btn.disabled = true;
  btn.textContent = '部署中... 請勿關閉視窗';
  log.style.display = 'block';
  log.textContent = '';
  try {
    const res = await fetch('/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(files),
    });
    if (!res.ok) {
      const errText = await res.text();
      log.textContent = '錯誤: ' + errText;
      btn.disabled = false;
      btn.textContent = '重試';
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      log.textContent += decoder.decode(value);
      log.scrollTop = log.scrollHeight;
    }
    btn.textContent = '完成 ✓ 可關閉視窗';
  } catch (e) {
    log.textContent += '\\n錯誤: ' + e.message;
    btn.disabled = false;
    btn.textContent = '重試';
  }
}
</script>
</body>
</html>`;

function runCmd(cmd, args, opts, res) {
  return new Promise((resolveP, rejectP) => {
    res.write(`\n$ ${cmd} ${args.join(' ')}\n`);
    const child = spawn(cmd, args, { ...opts, shell: true });
    child.stdout.on('data', d => res.write(d.toString('utf8')));
    child.stderr.on('data', d => res.write(d.toString('utf8')));
    child.on('close', code => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', rejectP);
  });
}

async function handleUpload(req, res) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY) {
      res.writeHead(413);
      res.end('Payload too large (>5MB)');
      return;
    }
    chunks.push(chunk);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Request body 不是合法 JSON: ' + e.message);
    return;
  }
  // Validate each uploaded file is itself parseable JSON
  for (const d of DIFFICULTIES) {
    if (!(d.id in payload)) continue;
    try { JSON.parse(payload[d.id]); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`【${d.label}】檔案不是合法 JSON: ${e.message}`);
      return;
    }
  }
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Transfer-Encoding': 'chunked',
  });
  try {
    res.write('=== 寫入檔案到 public/data/ ===\n');
    for (const d of DIFFICULTIES) {
      if (!(d.id in payload)) {
        res.write(`(略過) ${d.filename}\n`);
        continue;
      }
      await writeFile(resolve(DATA_DIR, d.filename), payload[d.id], 'utf8');
      res.write(`✓ ${d.filename} (${(payload[d.id].length / 1024).toFixed(1)} KB)\n`);
    }
    await runCmd('git', ['pull'], { cwd: ROOT }, res);
    await runCmd('git', ['add', 'public/data/'], { cwd: ROOT }, res);
    // Skip commit+push if nothing actually changed (re-uploading same files)
    const hasChanges = await new Promise((resolveP) => {
      const child = spawn('git', ['diff', '--cached', '--quiet'], { cwd: ROOT, shell: true });
      child.on('close', code => resolveP(code !== 0));
    });
    if (hasChanges) {
      const updated = DIFFICULTIES.filter(d => d.id in payload).map(d => d.label).join(', ');
      const msg = `chore: update bank (${updated}) via uploader`;
      await runCmd('git', ['commit', '-m', msg], { cwd: ROOT }, res);
      await runCmd('git', ['push'], { cwd: ROOT }, res);
    } else {
      res.write('\n(檔案內容跟現有的一樣,沒有 commit 需要做)\n');
    }
    res.write('\n=== 部署 PartyKit server ===\n');
    await runCmd('npm', ['run', 'deploy'], { cwd: ROOT }, res);
    res.write('\n=== 全部完成 ✓ ===\n');
    res.write('Cloudflare Pages 還需要 1~2 分鐘把前端 redeploy 完。\n');
    res.write('8 秒後自動關閉本機伺服器,可以關閉這個分頁了。\n');
    res.end();
    setTimeout(() => process.exit(0), 8000);
  } catch (e) {
    res.write(`\n=== 失敗 ===\n${e.message}\n`);
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (req.method === 'POST' && req.url === '/upload') {
    return handleUpload(req, res);
  }
  res.writeHead(404);
  res.end();
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} 已經被佔用 — 可能你已經有開一個視窗在跑這個工具。先關掉那個再重開。`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`題庫更新工具已啟動: http://localhost:${PORT}`);
  spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], {
    detached: true,
    stdio: 'ignore',
  }).unref();
});

// 30 分鐘 idle 自動關閉(避免從 .vbs 啟動後忘了用,server 殘留在背景)。
// 使用者真的在使用時,部署完成的自動 process.exit 會更早觸發,
// 這個 timeout 只是兜底。
setTimeout(() => {
  console.log('30 分鐘無動作,自動關閉。');
  process.exit(0);
}, 30 * 60 * 1000);
