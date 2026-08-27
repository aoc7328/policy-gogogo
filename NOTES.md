# Operational Notes

Living document for things that don't fit in code or commit messages —
things a future maintainer (or future-you) needs to know to not panic.

---

## 需要跑著 server 才能測的驗證腳本

`npm run verify:all` 是純靜態的,不需要 server。另外有兩支**要先把後端跑起來**
才能跑的端到端腳本,涵蓋 2026-07-23 兩場實測抓到的阻斷級問題:

```sh
npx wrangler dev -c worker/wrangler.jsonc --port 1998   # 另開一個終端機
npm run verify:live                                      # = verify:roster + verify:buzz
```

- `verify:roster`(`scripts/verify-startgame-roster.mjs`)
  重現「玩家改過組名 + 助理端重整過頁面 → 按開始遊戲 → 全場從分組名單消失、
  誰都搶答不了」。這是最嚴重的一個,改到 `startGame()` 一定要重跑。
- `verify:buzz`(`scripts/verify-buzz-integrity.mjs`)
  搶答封包的身分以 server 名冊為準(不採信 payload 的 name/team)、狂點節流
  (每連線每秒最多計 20 次)、改名撞名要被擋。

⚠ 腳本預設連 `127.0.0.1:1998`。PartyKit 時代的 1999 若被殘留的 `workerd.exe`
佔住(會 accept 連線但不回應),換個埠比較快:`node scripts/verify-buzz-integrity.mjs 127.0.0.1:1998`。

---

## Known Dev Dependencies CVE

**Status as of 2026-08-27 with `wrangler@4.106.0` + `partyserver@0.5.8`:**
`npm audit` reports **4 vulnerable packages**(1 moderate + 3 high),全部來自
wrangler 的本機 dev runtime(miniflare = 本機 Workers 模擬器)。它們
**不會**進到部署上 Cloudflare 的 worker bundle。

> **GitHub 顯示的數字跟 `npm audit` 不一樣,兩個都對。** Dependabot 是
> 「一則 advisory 算一個」,`npm audit` 是「一個套件算一個」。2026-08-27
> GitHub 通報 12 個(4 high / 6 moderate / 2 low)—— 這 12 個**全部都是
> `undici` 這一個套件**累積的 advisory(七月時是 6 則,上游持續在補)。
> 套件集合沒變 → `audit:check` 依然 exit 0,這是預期行為:這支腳本盯的是
> 「有沒有跑出可接受清單以外的套件」,不是 advisory 的則數。

> **2026-07 平台搬遷**:後端原本跑在 PartyKit 託管平台,該平台已無人維護
> 且無法再部署(Cloudflare 2026-07-09 起新 DO namespace 強制 SQLite 後端,
> PartyKit CLI 不支援 `new_sqlite_classes`)。改用 partyserver + wrangler
> 部署到自家 Cloudflare 帳號,詳見 `worker/wrangler.jsonc` 檔頭。
> 隨之 `partykit` / `esbuild`(舊路徑)/ `ws` 三筆 CVE 消失,換成下表四筆。

### The findings

| Root package | Severity | Path                            | Why it's here                                |
|--------------|----------|---------------------------------|----------------------------------------------|
| `wrangler`   | high     | (root devDependency)            | 本機 dev + deploy CLI;transitive carrier。   |
| `miniflare`  | high     | `wrangler → miniflare`          | 本機 Workers 模擬器。                        |
| `undici`     | high     | `wrangler → miniflare → undici` | 模擬器的 HTTP fetch。                        |
| `sharp`      | high     | `wrangler → miniflare → sharp`  | 模擬器的圖片處理(libvips CVE)。            |

**版本鎖定注意**:`wrangler` 釘在 `4.106.0`。原始理由(2026-07-23):
4.107+ 的 peer 要 `@cloudflare/workers-types@^5`,而 `partyserver@0.5.8`
的 peer 要 `^4`,直接升會 ERESOLVE 失敗。

> **2026-08-27 複查:上游那道鎖已經解開了,但我們仍然不升。**
> `partyserver@0.5.10` 的 peer 已放寬成 `^4.20260424.1 || ^5.20260703.1`,
> 所以 wrangler 4.126 + types v5 這條路技術上通了。**不升的理由變了**:
> 以前是「升不上去」,現在是「升的代價變高」—— 要升 wrangler 就得連
> `partyserver` 一起升,而 partyserver **不是工具,它就是跑整場遊戲的
> 伺服器函式庫**。風險性質從「部署工具壞掉、重裝就好」變成「遊戲本體
> 行為可能改變」,得重跑 `verify:all` + 全套 live 腳本 + 實際部署驗證。
> 為了修一批觸發條件不存在的 dev-only CVE,不值得在活動檔期承擔這個。
> **真的要升的時機**:確定接下來兩週沒有活動,且三個套件
> (wrangler / @cloudflare/workers-types / partyserver)一起升、一次驗完。

undici 的 12 則 advisory 依攻擊面分四類(2026-08-27 盤點),括號內為
**為什麼對本專案不適用**:
- **連線串線 6 則** — 連線池/快取重用導致回應錯置或跨使用者外洩
  (要當「同時服務多人的共用快取」才有意義;wrangler 是單機 CLI)
- **Cookie 注入 4 則** — Set-Cookie 解析不嚴謹,可塞欄位或降級 SameSite
  (本專案的 dev 流程不處理第三方 cookie)
- **憑證未驗證 1 則** — SOCKS5 ProxyAgent 漏掉 requestTls(沒用代理)
- **WebSocket 碎片 DoS 1 則** — 惡意伺服器可撐爆客戶端記憶體
  (只連自家 Cloudflare)

另有 `sharp` 一則(GitHub 未計入):`GHSA-f88m-g3jw-g9cj`
(libvips: CVE-2026-33327/33328/35590/35591),要處理**惡意圖片檔**
才會觸發,本專案不讓它處理任何圖片。

GHSA 清單會隨上游持續增補,不在此逐一列舉 —— 以 `npm audit` 當下輸出為準。

### Why we're not fixing them today

1. **Dev-only blast radius.** `sharp` 與 `undici` 都是 `miniflare`
   (wrangler 的本機 Workers 模擬器)拉進來的,只在開發機跑
   `npm run dev` 時存在。部署到 Cloudflare 的 worker bundle 裡沒有它們。
   正式相依只有 `partyserver` + `partysocket` 兩個,`npm ls undici` 可自證:
   undici 只從 `jsdom` 與 `wrangler → miniflare` 兩條路進來,兩者皆
   devDependency。
2. **觸發條件不存在**,不只是「風險低」。見上面四類的括號說明 ——
   要用 SOCKS5 代理、要當共用快取服務多人、要主動連惡意伺服器、要處理
   惡意圖片,本專案一項都不符合。最壞情況是本機部署指令失敗,不影響
   已上線的遊戲。
3. **升級代價 > 收益(2026-08-27 重新評估)。** 上游的相依鎖雖已解開,
   但現在要動就得連 `partyserver`(遊戲本體的伺服器函式庫)一起動 ——
   詳見上面「版本鎖定注意」的 2026-08-27 複查。
4. **`npm audit fix --force` 會弄壞專案.** 它會把 `wrangler` 降到
   4.15.2(audit 建議值),那個版本跟目前的 `wrangler.jsonc` 設定檔格式
   不相容,症狀是**部署推不上去**。**別跑。**(Vincent 踩過。)

### What to do instead

維持鎖定,讓 GitHub 的紅色警示掛著 —— 已經查證過、是刻意不修。
每次升 `wrangler` 之後跑:

```sh
npm run audit:check
```

That script (`scripts/audit-check.mjs`) compares the current `npm audit`
output against the accepted set above:

- **Exit 0** → still matches expectation; nothing to do.
- **Exit 1, "0 vulnerabilities"** → 🎉 upstream fixed it. **Delete this entire
  section from NOTES.md and remove the `audit:check` npm script.**
- **Exit 1, "new CVE outside accepted set"** → 🚨 a new vulnerability has
  appeared in a package we hadn't accepted. Investigate and either fix it
  or update this section to accept it (with justification).

### Maintenance protocol

- ✅ Run `npm run audit:check` after every `npm install` that touches `wrangler`
  or its tree (e.g. after `npm update`, `npm install wrangler@latest`)。
  升 wrangler 前先看上面的「版本鎖定注意」。
- ✅ **看到 GitHub Dependabot 的警示數字變多,先看是不是同一批套件。**
  advisory 則數會一直長(undici 七月 6 則 → 八月 12 則),但只要
  `audit:check` 是綠的,就代表套件集合沒變、結論不變,不必重新評估。
- ✅ Treat `audit:check` exit 1 as a real signal — don't ignore.
- ❌ Do not run `npm audit fix --force`.
- ❌ Do not silence `npm audit` warnings globally (e.g. via `.npmrc`
  `audit=false`); we want them visible.
