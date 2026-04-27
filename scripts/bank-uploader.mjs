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

// 第 1 格是 metadata,後 5 格是各難度題庫。檔名固定 — 工具自動改名,使用者
// 電腦上的原檔叫什麼都行。metadata 是 frameworks(F1-F9 / L1-L4 標籤)+
// branding(遊戲標題前綴)的單一來源,server bundle 跟三端 UI 都讀它。
const UPLOAD_SLOTS = [
  { id: 'metadata',  label: 'metadata', filename: 'quiz-bank-metadata.json' },
  { id: 'easy',      label: '簡單',    filename: 'insurance-quiz-bank-easy.json' },
  { id: 'medium',    label: '中等',    filename: 'insurance-quiz-bank-medium.json' },
  { id: 'hard',      label: '困難',    filename: 'insurance-quiz-bank-hard.json' },
  { id: 'hell',      label: '地獄',    filename: 'insurance-quiz-bank-hell.json' },
  { id: 'purgatory', label: '煉獄',    filename: 'insurance-quiz-bank-purgatory.json' },
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
<p class="intro">第 1 格是 <strong>metadata</strong>(全域設定 — 標題、9+4 框架),後 5 格是各難度的題庫。沒選的不會被動到 — 例如只想換煉獄題目就只選煉獄那一格。電腦上的檔名隨便取,工具會自動改成正確檔名再放進去。</p>
${UPLOAD_SLOTS.map(d => `<label class="row" for="f-${d.id}">
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
<p>你電腦上的檔名隨便取,工具會自動改成正確的檔名再寫入專案。固定 6 個目標檔名:</p>
<ul>
<li><code>quiz-bank-metadata.json</code>(metadata 槽)</li>
<li><code>insurance-quiz-bank-{easy/medium/hard/hell/purgatory}.json</code>(5 個題庫槽)</li>
</ul>

<h3>2. metadata.json 是新主題的「總開關」</h3>
<p>三端的 9 宮格 / 4 宮格 / 標題,**通通**從這支檔讀。換主題的時候,基本上**只動這支** + 6 個題庫的 questions(後者改 topic 就好)。結構長這樣(右上角可一鍵複製):</p>
<div class="copy-wrap">
<button class="copy-btn" onclick="copyPre(this)">複製</button>
<pre style="background:#050912;color:#88C765;padding:12px;font-size:12px;line-height:1.6;overflow-x:auto;border:1px solid #2a3040">{
  "schema_version": "2.0",
  "branding": {
    "title_prefix": "中國史",
    "title_suffix": "星攻略"
  },
  "topic_frameworks": {
    "system_A_standard_9": {
      "frameworks": [
        { "id": "f1", "label": "上古傳說" },
        { "id": "f2", "label": "夏商周" },
        { "id": "f3", "label": "春秋戰國" },
        { "id": "f4", "label": "秦漢" },
        { "id": "f5", "label": "魏晉南北朝" },
        { "id": "f6", "label": "隋唐" },
        { "id": "f7", "label": "宋元" },
        { "id": "f8", "label": "明清" },
        { "id": "f9", "label": "近現代" }
      ]
    },
    "system_B_purgatory_4": {
      "frameworks": [
        { "id": "l1", "label": "重大戰役" },
        { "id": "l2", "label": "文化思潮" },
        { "id": "l3", "label": "制度變革" },
        { "id": "l4", "label": "人物評價" }
      ]
    }
  }
}</pre>
</div>
<ul>
<li><strong>branding.title_prefix</strong> — 1~4 字,可換(如「中國史」、「臺灣地理」)</li>
<li><strong>branding.title_suffix</strong> — 固定 3 字「星攻略」,不要改(三端 UI 對這 3 字有版面寬度假設)</li>
<li><strong>system_A_standard_9.frameworks</strong> — 1~9 個分類,簡單/中等/困難/地獄共用。對應到 9 宮格(陣列第 0 個 = F1、第 1 個 = F2...)</li>
<li><strong>system_B_purgatory_4.frameworks</strong> — 1~4 個分類,煉獄專用。對應 L1~L4</li>
<li><strong>少於 9 / 4 個</strong> — 行,多的格子會變灰色不可選。但建議湊滿</li>
<li><code>id</code> 欄位是給人看的英文代號,server 不嚴格檢查,亂取也行(但同檔內別重複)</li>
<li><code>label</code> 才是 server 真正用的字串 — 必須跟題目 <code>topic</code> 完全一致</li>
</ul>

<h3>3. 題庫 JSON 結構</h3>
<p>每個題庫檔頂層只需要 <code>questions</code>(metadata 已經在 metadata.json 處理掉,題庫檔的 metadata 區塊現在純粹是文件性質,server 不讀)。「煉獄」的 <code>questions</code> 是<strong>扁平陣列</strong>(framework B),其他四個難度是<strong>巢狀物件</strong>(按題型分組,framework A)。直接打開現有的 JSON 仿照寫。</p>

<h3>4. 題目 ID 規則</h3>
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

<h3>5. 題目的 topic 必須對應 metadata 的 label</h3>
<p>例如 metadata 宣告 framework A 第一格的 label 是「上古傳說」,題目就要寫(右上角可一鍵複製):</p>
<div class="copy-wrap">
<button class="copy-btn" onclick="copyPre(this)">複製</button>
<pre style="background:#050912;color:#88C765;padding:12px;font-size:12px;line-height:1.6;border:1px solid #2a3040">{
  "id": "E-MC-001",
  "topic": "上古傳說",
  "question": "..."
}</pre>
</div>
<p>topic 字串<strong>必須完全等於 metadata 裡某個 framework label</strong>(連標點都要一樣),否則 server 抽題時這題會被排除。</p>

<h3>6. 各題型必填欄位</h3>
<ul>
<li><code>short_answer</code>(簡答):id, topic, question, answer</li>
<li><code>multiple_choice</code>(選擇):id, topic, question, options, correct, explanation</li>
<li><code>essay</code>(申論):id, topic, question, key_points, model_answer</li>
<li><code>calculation</code>(計算):id, topic, question, given, steps, answer, unit</li>
<li><code>word_game</code>(玩字):id, topic, word, options, correct</li>
</ul>
<p>少欄位的話 server 抽到這題會報錯,題庫驗證程式也會抓出來。</p>

<h3>7. 上傳之後會發生什麼</h3>
<ol>
<li>檔案被改名後寫入 <code>public/data/</code></li>
<li>git pull → add → commit → push(Cloudflare Pages 自動 redeploy 前端)</li>
<li>npm run deploy(把新題庫推到 PartyKit server)</li>
<li>大概 1~2 分鐘後新題庫上線,玩家連進來就吃新題目</li>
</ol>

<h3>8. 失敗了怎麼辦</h3>
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
  for (const d of UPLOAD_SLOTS) {
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
    for (const d of UPLOAD_SLOTS) {
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
      const updated = UPLOAD_SLOTS.filter(d => d.id in payload).map(d => d.label).join(', ');
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
