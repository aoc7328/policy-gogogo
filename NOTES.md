# Operational Notes

Living document for things that don't fit in code or commit messages —
things a future maintainer (or future-you) needs to know to not panic.

---

## Known Dev Dependencies CVE

**Status as of 2026-07-23 with `wrangler@4.106.0` + `partyserver@0.5.8`:**
`npm audit` reports **4 vulnerabilities (all high)**, all originating in
wrangler's local-dev runtime (miniflare = 本機 Workers 模擬器). They do
**not** ship to the worker deployed on Cloudflare.

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

**版本鎖定注意**:`wrangler` 釘在 `4.106.0` —— 4.107+ 的 peer 要
`@cloudflare/workers-types@^5`,而 `partyserver@0.5.8` 的 peer 要 `^4`,
直接升會 ERESOLVE 失敗。等 partyserver 跟上 v5 types 再一起升。

GHSA IDs at the time of writing (may shift as advisories get updated):
- `GHSA-f88m-g3jw-g9cj` (sharp → libvips: CVE-2026-33327/33328/35590/35591)
- `GHSA-g9mf-h72j-4rw9` (undici unbounded decompression)
- `GHSA-2mjp-6q6p-2qxm` (undici request smuggling)
- `GHSA-vrm6-8vpv-qv8q` (undici websocket memory)
- `GHSA-v9p9-hfj2-hcw8` (undici websocket exception)
- `GHSA-4992-7rv2-5pvq` (undici CRLF injection)
- `GHSA-pr7r-676h-xcf6` (undici shared-cache info disclosure)

### Why we're not fixing them today

1. **Dev-only blast radius.** `sharp` 與 `undici` 都是 `miniflare`
   (wrangler 的本機 Workers 模擬器)拉進來的,只在開發機跑
   `npm run dev` 時存在。部署到 Cloudflare 的 worker bundle 裡沒有它們。
2. **Upstream fix needed.** 版本釘在 wrangler/miniflare 自己的
   `package.json`,不是我們的 —— 單獨 `npm install sharp@latest` 沒用。
3. **`npm audit fix --force` 會弄壞專案.** 它會把 `wrangler` 降到
   4.15.2(audit 建議值),那個版本跟目前的設定檔格式不相容。**別跑。**

### What to do instead

等 wrangler / miniflare 發布跟上的版本。每次升 `wrangler` 之後跑:

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
- ✅ Treat `audit:check` exit 1 as a real signal — don't ignore.
- ❌ Do not run `npm audit fix --force`.
- ❌ Do not silence `npm audit` warnings globally (e.g. via `.npmrc`
  `audit=false`); we want them visible.
