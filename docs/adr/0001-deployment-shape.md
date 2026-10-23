# ADR-0001: Deployment shape on Cloudflare

- **Status:** Accepted at review point R1 (2026-10-23). The Free-plan trial still has to be verified at the first deploy (#8).
- **Date:** 2026-10-23
- **Issue:** #7 (E2.1)
- **OpenConnector:** `v1.9.2` = `2748be7758ad388b4eb59a33696285a8444a3c81`, the pin in `vendor/open-connector`.

## Decision

1. **Overlay, not fork.** OpenConnector stays a git submodule pinned to a release tag. SplitMind owns the wrangler template, the scripts, the docs and `patches/`. Nothing found in this spike needs a fork.
2. **Workers KV for transit files.** One `kv_namespaces` array holds both the `TRANSIT_FILES` and `OAUTH_KV` bindings, with `TRANSIT_FILES_BACKEND="kv"`.
3. **Try Workers Free with two changes, and fall back to Workers Paid ($5/month).** Unmodified upstream does not fit Free. Every cold isolate spends about 50 ms of CPU on key derivation alone, and Free allows 10 ms per request (Finding 2). Two changes ship with the first deploy (#8):
   - **HKDF for random keys:** an upstream-bound patch that derives the AES key with HKDF instead of PBKDF2 when the encryption key is 32 random bytes. Key setup drops from 49-94 ms to 0.4-0.9 ms of CPU (measured, Finding 2).
   - **Catalog trim:** a build step that ships only the `notion` and `slack` catalog entries as static assets.

   **Pass criteria at #8.** Deploy to Free, then watch the Workers dashboard (Metrics → CPU time), the reported startup time and the error rate over at least 24 hours of normal use. If any cold request goes over 10 ms of CPU, or if any 1102 error appears, switch the account to Paid. Switching is a plan change and needs no redeploy. On Paid, keep the HKDF patch only if upstream accepts it.

   Local timing was skipped on purpose: wall time from `wrangler dev` is only a proxy for Cloudflare CPU time, so the dashboard is the real test.

## Context

The kickoff pins Cloudflare (decision 2), the overlay repo shape (decision 6) and a default policy (decision 7). This spike answers three questions:
- Does the bundle fit the current size limits?
- Does per-request CPU fit Free's 10 ms?
- Is the overlay approach sound?

## Findings

### 1. Bundle size fits every plan

**Cloudflare's live limits** ([limits page](https://developers.cloudflare.com/workers/platform/limits/), last updated Oct 12, 2026; [changelog, Sep 4, 2026](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)):

> Previously, Cloudflare checked that compressed size and rejected deploys over 3 MB (Free) or 10 MB (Paid). That limit has been removed. Cloudflare now only checks the uncompressed size of your bundle, which is 64 MiB across all plans.

> There is no compressed size limit. Only the uncompressed bundle size counts.

The kickoff's "3 MB compressed on Free" is out of date.

| Measure | Value | Source | Limit | Fits? |
|---|---|---|---|---|
| Minified script (`--minify`) | 13.8 MiB | upstream `docs/cloudflare.md` @ v1.9.2 | 64 MiB uncompressed | Yes, 21.6% of the limit |
| Unminified script | 28.7 MiB | same | 64 MiB | Yes, 44.8% |
| gzip size | not yet measured | `wrangler deploy` output | none (reference only) | n/a |
| Startup time (global scope) | not yet measured | `wrangler deploy` reports `startup_time_ms` | 1 s, all plans | Probably. Upstream builds its app in the first request, not at global scope. |

Arithmetic: 13.8 / 64 = 0.216; 28.7 / 64 = 0.448.

**Gap.** The issue asks for the real `wrangler deploy --dry-run` sizes. The cloud session that ran this spike blocks `npm ci` on upstream, because it runs upstream's install scripts. The fallback run on a Mac couldn't download the upstream repository (GitHub transfers ran at about 600 bytes/s). The first deploy in #8 prints both sizes and `startup_time_ms`, and they get recorded there. Since size has 3-4× headroom, they cannot change the decision.

### 2. CPU: unmodified upstream does not fit Free's 10 ms on a cold isolate

**Live limits:**
- CPU time per HTTP request: Free 10 ms, Paid 5 min (default 30 s).
- CPU time per Cron Trigger: Free 10 ms.

Cloudflare allows some slack: "each isolate has some built-in flexibility … if your Worker starts hitting the limit consistently, its execution will be terminated". Termination returns error 1102.

What a cold isolate does inside its **first request** (`src/server/cloudflare.ts` @ v1.9.2):

1. **PBKDF2 key derivation, 100,000 iterations of SHA-256.**
   - Path: `createSecretCodec()` → `WorkerAesGcmSecretCodec.create()` (`src/server/secrets/worker-secret-codec.ts:22-38`).
   - It is cached for the isolate's lifetime, so warm requests skip it.
2. **The full provider catalog.**
   - It loads all 1,696 providers from static assets, unfiltered by the action allowlist.
   - It then builds the catalog store (`loadCatalogFromAssets`, `src/server/cloudflare/catalog-assets.ts`).
   - The catalog's TypeScript source (`actions.ts` + `definition.ts`) totals 18,888,821 bytes. That puts the JSON at roughly 15-40 MB.
3. **The deferred MCP and docs modules** (`preloadOptionalServerModules()`). Upstream's own comment says Workers pay for these "at app creation".

**Measured: step 1 alone.** The test is an independent script with upstream's exact parameters, run on Node 22 WebCrypto on a 2.8 GHz Xeon:

```
$ node docs/adr/0001/pbkdf2-bench.mjs
[{"wallMs":73.3,"cpuMs":70.4},{"wallMs":79.5,"cpuMs":79.2},{"wallMs":47.8,"cpuMs":47.4},{"wallMs":49,"cpuMs":48.9},{"wallMs":46.3,"cpuMs":46.3},{"wallMs":47.2,"cpuMs":47},{"wallMs":52.4,"cpuMs":52.3}]
median wall ms: 49 min: 46.3 max: 79.5
```

The fastest run, 46.3 ms, is 4.6× Free's whole budget, and it comes before any catalog work. Workers use BoringSSL rather than OpenSSL. The speed differs between the two, but not by 5×.

**Estimated: step 2.** V8 parses JSON at roughly 200-400 MB/s, so 15-40 MB takes about 40-200 ms. That puts total cold-request CPU at roughly 0.1-0.3 s.

**Why it matters here.** Cloudflare's slack covers *infrequent* overruns. A Worker that one person uses a few times a day is cold most of the time. So the first Claude tool call after an idle gap is exactly the request likely to fail with 1102, which is a kickoff tripwire. The per-minute cron also pays the PBKDF2 cost on every cold isolate, against the same 10 ms.

**What the two changes remove:**

- **HKDF for random keys.** Key stretching protects low-entropy passwords. Upstream's documented key is `openssl rand -base64 32`, which is 256 random bits, so PBKDF2 adds no security for it.
  - For a key that is standard base64 of exactly 32 bytes, the change derives the AES key with HKDF-SHA256 and writes records under a new `enc:worker:v2:` prefix.
  - The PBKDF2 key is derived only when an old `v1` record is read, so existing deployments keep working.
  - Passphrase keys stay on v1.
  - Results from the patched codec, checked against fixtures sealed independently with `node:crypto`: a v2 round trip; reading a v2 fixture; reading a v1 fixture under the raw key; a passphrase key staying on v1; and a passphrase key rejecting v2. All five pass.

    ```
    create() CPU ms, raw 32-byte key (v2/HKDF): [0.82,0.85,0.46,0.41,0.58]
    create() CPU ms, passphrase (v1/PBKDF2): [93.57,69.17,80.48,48.86,52.91]
    ```

  - This touches secret handling. It is filed upstream before it lands in `patches/`, which follows `patches/README.md`, and it needs Sam's approval to merge.
- **Catalog trim.** This copies only `notion.json` and `slack.json` into the catalog assets. It runs after `npm run generate:catalog` and before upstream's `scripts/copy-catalog-assets.ts`.
  - It matches the `notion.*,slack.*` allowlist (decision 7).
  - The trade-off: adding a provider later means widening the trim list as well as the allowlist.

**Still unknown:** the CPU left after both changes, which covers module evaluation, the two-provider catalog store and MCP handling. That gap is why #8 has pass criteria.

**Not done: dropping the cron.** The per-minute cron serves SaaS OAuth cleanup and Provider Trigger maintenance, and SplitMind uses neither. It could probably be removed, but that is unverified, so the template keeps it.

### 3. Cost on Workers Paid (the fallback): $5.00/month

Live pricing ([pricing page](https://developers.cloudflare.com/workers/platform/pricing/), last updated Oct 2, 2026):
- **$5/month minimum per account.** It includes 10M requests and 30M CPU-ms.
- Overage: $0.30 per additional million requests, and $0.02 per additional million CPU-ms.

Worst-case usage, with deliberately pessimistic assumptions:

| Item | Arithmetic | Monthly |
|---|---|---|
| Cron invocations | 60 × 24 × 30 | 43,200 requests |
| Cron CPU, every run cold | 43,200 × 60 ms | 2,592,000 CPU-ms |
| Claude and console requests (assumed, generous) | 3,000/day × 30 | 90,000 requests |
| Request CPU, every one cold | 90,000 × 300 ms | 27,000,000 CPU-ms |
| **Total** | 133,200 requests; 29.6M CPU-ms | inside the included 10M requests and 30M CPU-ms |

That makes the bill $5.00 flat. D1 and KV paid allowances (25B rows read, 50M rows written and 1M KV writes per month) are far above what four connections use. Paid is account-wide, so if the account already pays for Workers, this adds nothing.

### 4. Overlay vs. fork: the overlay holds

- **Rendering config is safe.** Upstream's `.gitignore` already covers `wrangler.local.jsonc`, `.wrangler/`, `.env`, `dist/` and `catalog/`. A deploy script can render `wrangler.template.jsonc` into `vendor/open-connector/wrangler.local.jsonc` and run upstream's own build without dirtying the submodule.
- **No source changes are needed to deploy.** Every setting that decisions 2, 3, 4 and 7 need is a wrangler var or binding (`docs/configuration.md` @ v1.9.2):
  - `TRANSIT_FILES_BACKEND`
  - `OAUTH_KV`
  - `OOMOL_CONNECT_ORIGIN`
  - `OOMOL_CONNECT_BLOCKED_PROXIES`
  - `OOMOL_CONNECT_ALLOWED_ACTIONS`
  - `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH`
- **Upgrades stay cheap.** Upstream moves fast (tags v1.3.5 → v1.9.2). A fork would have to rebase that churn. With the submodule, an upgrade is a tag bump plus re-applying patches.
- The only engine change so far is the HKDF patch. It is a Free-plan optimization, not a reason to fork.

### 5. KV for transit files

- **Limits fit.** Upstream's KV backend clamps files to 25 MiB (`src/server/files/kv-transit-files.ts:23`). It sets the TTL on write, with a 60 s minimum, so no lifecycle rule is needed. That matches decision 2, which expects no files over 25 MiB.
- **No R2 needed.** That is one fewer product to enable.
- **Upstream docs snag** (for the docs PR in #37). `wrangler.example.jsonc` shows `OAUTH_KV` and the KV transit option as two separate commented `"kv_namespaces"` blocks. If you uncomment both, you get a duplicate JSON key, the later one wins, and one binding is silently dropped. `wrangler.template.jsonc` uses a single array.

## Wrangler template

`wrangler.template.jsonc` at the repository root holds placeholders only: `<worker-name>`, `<d1-database-name>`, `<d1-database-id>`, `<transit-kv-namespace-id>`, `<oauth-kv-namespace-id>` and `<public-origin>`.
- **Bindings:** `DB` (D1); `TRANSIT_FILES` and `OAUTH_KV` (KV); `ASSETS` (Static Assets).
- **Vars:** `TRANSIT_FILES_BACKEND=kv`, `OOMOL_CONNECT_ORIGIN`, `OOMOL_CONNECT_BLOCKED_PROXIES="*"`, `OOMOL_CONNECT_ALLOWED_ACTIONS="notion.*,slack.*"`, `OOMOL_CONNECT_ALLOWED_CUSTOM_OAUTH=slack`.
- **Provider ids verified:** `service = "notion"` (`src/providers/notion/definition.ts:8`) and `service = "slack"` (`src/providers/slack/definition.ts:7`).
- **Free plan:** no `limits` block. A commented `cpu_ms` cap is ready for when the account moves to Paid.

## Consequences

- **#8 (deploy):**
  - Add the catalog trim step and the HKDF patch (done: `scripts/catalog-assets.ts`, `patches/0001-…`). Filing the upstream issue is a public post, so it waits for Sam under #37.
  - Render the template (done: `scripts/deploy.ts`, see `docs/setup/cloudflare.md`).
  - Apply migrations through `0018_connection_retirement.sql`.
  - Record the bundle sizes and `startup_time_ms`.
  - Run the 24-hour CPU check above.
- **If the check fails:** Sam switches the account to Workers Paid, a $5/month billing change. The template's `cpu_ms` cap gets uncommented.
- **#37 (upstream work):** gets the HKDF change, plus the `kv_namespaces` docs fix.

## Addendum: measured while preparing #8 (2026-10-23)

Upstream installs in the cloud sandbox after all: its lockfile points at `registry.npmmirror.com`, which the sandbox refuses, and `npm ci --replace-registry-host=registry.npmmirror.com` fetches the same packages from npmjs. `scripts/bootstrap.sh` now does that.

**Bundle (wrangler 4.150.0, both patches applied, `npm run deploy -- --dry-run`):**

```
Total Upload: 20873.01 KiB / gzip: 5029.58 KiB
```

That is 20.4 MiB, 32% of the 64 MiB limit, and larger than upstream's documented 13.8 MiB. It still fits every plan. `startup_time_ms` is only reported by a real upload, so it is recorded at the first deploy.

**Catalog assets:** all 1,667 providers produce 47,814,344 bytes in 12 chunks; Notion and Slack alone produce 144,202 bytes in 1 chunk (`scripts/catalog-assets.ts`).

**Cold first request in local `workerd`** (`wrangler dev`, a fresh process per run, `GET /health`, curl wall time). Wall time includes asset and D1 I/O, which Cloudflare does not count as CPU, so these are upper bounds:

| Configuration | Cold request | Warm request |
|---|---|---|
| Full catalog, HKDF key | 885–1,691 ms | 5–6 ms |
| Trimmed catalog, HKDF key | 76–138 ms | 4–7 ms |
| Trimmed catalog, passphrase key (PBKDF2) | 91–144 ms | 4–6 ms |

PBKDF2 at upstream's parameters, timed alone in `workerd`: 18–22 ms per derivation against 3 ms for an empty request, so about 15 ms of work; HKDF is indistinguishable from the empty request. That is lower than the Node figure in finding 2, but still over 10 ms by itself, so patch 0001 stays.

Instrumenting `createCloudflareApp` (temporarily, not committed) splits a trimmed cold request into: `preloadOptionalServerModules()` 64 ms, key setup 1 ms, catalog load 23 ms, `createConnectApp` 13 ms. Evaluating the MCP and docs modules is now the largest cost. Moving that call to module scope (startup, which has its own 1 s limit) cut the in-request time from 72–113 ms to 33–41 ms in a quick experiment. That would be a third patch; it is filed as an enhancement to try only if the Free trial fails and Paid is not wanted.

**Expectation:** the trial on Free will probably show cold requests above 10 ms. The pass criteria above still decide.

## Known vs. assumed

- **Known (read or measured 2026-10-23):**
  - Live docs: 64 MiB uncompressed size limit on all plans, with no compressed limit. Free CPU is 10 ms per request and per cron. Paid has a $5/month minimum with 10M requests and 30M CPU-ms included.
  - Upstream code at v1.9.2: it runs PBKDF2-SHA256 at 100k iterations and loads the full 1,696-provider catalog inside each isolate's first request.
  - Measured on Node 22: PBKDF2 at those parameters takes at least 46 ms of CPU. HKDF takes under 1 ms.
- **Assumed:**
  - The bundle is about 13.8 MiB, upstream's documented figure.
  - BoringSSL in Workers is within about 2× of Node for PBKDF2.
  - The catalog JSON is 15-40 MB, inferred from source size.
  - Usage stays at or below 3,000 requests a day.
  - Free CPU after both changes is unknown until #8.

## Lens for Claude

- Size is not the constraint any more; cold-start CPU is. Don't re-argue size from the old 3 MB rule.
- Never fit Free by lowering PBKDF2 iterations. HKDF applies only to 32-byte random keys, and any secrets-handling change needs Sam.
- Keep both KV bindings in one `kv_namespaces` array.
