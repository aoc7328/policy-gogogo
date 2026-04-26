# Operational Notes

Living document for things that don't fit in code or commit messages —
things a future maintainer (or future-you) needs to know to not panic.

---

## Known Dev Dependencies CVE

**Status as of 2026-04-26 with `partykit@0.0.115`:**
`npm audit` reports **4 vulnerabilities (3 moderate, 1 high)**, all originating
in PartyKit's local-dev runtime. They do **not** ship to the production worker
on Cloudflare.

### The findings

| Root package | Severity | Path                                       | Why it's here                                    |
|--------------|----------|--------------------------------------------|--------------------------------------------------|
| `esbuild`    | moderate | `partykit → esbuild`                       | Bundles user code for `partykit dev`.            |
| `undici`     | high     | `partykit → miniflare → undici`            | Powers Workers' HTTP fetch in the local sim.     |

GHSA IDs at the time of writing (may shift as advisories get updated):
- `GHSA-67mh-4wv8-2f99` (esbuild dev-server CORS)
- `GHSA-g9mf-h72j-4rw9` (undici unbounded decompression)
- `GHSA-2mjp-6q6p-2qxm` (undici request smuggling)
- `GHSA-vrm6-8vpv-qv8q` (undici websocket memory)
- `GHSA-v9p9-hfj2-hcw8` (undici websocket exception)
- `GHSA-4992-7rv2-5pvq` (undici CRLF injection)

### Why we're not fixing them today

1. **Dev-only blast radius.** Both `esbuild` and `undici` are pulled in by
   `partykit` (and `miniflare`, the Workers simulator). They run on the
   developer's laptop during `partykit dev`. They do not exist in the
   bundle that PartyKit deploys to Cloudflare's edge.
2. **Upstream fix needed.** The pinned versions live inside PartyKit's
   `package.json`, not ours. We can't just `npm install esbuild@latest` —
   `partykit` would still resolve its own pinned copy.
3. **`npm audit fix --force` would brick the project.** It downgrades
   `partykit` to `0.0.0` (per the audit advisory). **DO NOT RUN IT.**

### What to do instead

Wait for `partykit` to publish a release that bumps `esbuild` and `miniflare`.
Each time you upgrade `partykit`, run:

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

- ✅ Run `npm run audit:check` after every `npm install` that touches `partykit`
  or its tree (e.g. after `npm update`, `npm install partykit@latest`).
- ✅ Treat `audit:check` exit 1 as a real signal — don't ignore.
- ❌ Do not run `npm audit fix --force`.
- ❌ Do not silence `npm audit` warnings globally (e.g. via `.npmrc`
  `audit=false`); we want them visible.
