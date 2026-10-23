# Upstream issue draft: HKDF for random Worker encryption keys (2026-10-23)

**Status: draft only, not filed.** Filing it is a public post from Sam's GitHub account, so it waits for him
(issue #37). Once filed, put the link in the first lines of `patches/0001-worker-secret-codec-hkdf-for-raw-keys.patch`.

Written against OpenConnector `v1.9.2` (`2748be7`). Before filing, re-check `main` for changes to
`src/server/secrets/worker-secret-codec.ts`.

---

**Title:** `perf(cloudflare): skip PBKDF2 when OOMOL_CONNECT_ENCRYPTION_KEY is 32 random bytes`

**Body:**

> ### Problem
>
> `WorkerAesGcmSecretCodec.create()` (`src/server/secrets/worker-secret-codec.ts`) derives the AES-256-GCM key with
> PBKDF2-SHA256 at 100,000 iterations. It runs once per isolate, inside the first request. In local `workerd`
> (wrangler 4.150) that derivation alone takes about 15 ms; in Node 22 it takes 46–79 ms. The Workers Free plan
> allows 10 ms of CPU per request, so every cold isolate starts over budget before any other work.
>
> The docs tell operators to generate the key with `openssl rand -base64 32`. That is 256 random bits, and key
> stretching only helps low-entropy passphrases, so for the documented key PBKDF2 costs CPU and adds no security.
>
> ### Proposal
>
> - When the key is standard base64 of exactly 32 bytes (`/^[A-Za-z0-9+/]{43}=$/`), derive the AES key with
>   HKDF-SHA256 (same salt, info `oomol-connect-worker-secret-store-v2`) and write records with a new
>   `enc:worker:v2:` prefix.
> - Derive the PBKDF2 key lazily, only when a `v1` record is read, so existing deployments keep reading their data
>   with no migration. New writes from a raw key are v2.
> - Passphrase keys are unchanged: they stay on v1 for writes and refuse v2 records with a clear error.
>
> Measured with the change (local `workerd`, per derivation): HKDF under 1 ms vs. PBKDF2 about 15 ms.
>
> ### Tests
>
> Fixtures sealed independently with `node:crypto` (`pbkdf2Sync`, `hkdfSync`, `aes-256-gcm`), not with the codec:
> a v2 round trip; reading a v2 fixture; reading a v1 fixture under the raw key; a passphrase key reading v1; and a
> passphrase key rejecting v2. All pass with the existing suite (`src/server/secrets`, `src/server/cloudflare`:
> 47 tests).
>
> A ready patch is in SplitMind's `patches/0001-worker-secret-codec-hkdf-for-raw-keys.patch`; happy to open it as a
> PR.
