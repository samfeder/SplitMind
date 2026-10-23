# ADR-0002: Deploy path for others

- **Status:** Accepted (2026-10-23). Not yet tried from a clean clone by someone else; that is #36 (E7.3).
- **Issue:** #34 (E7.1)

## Decision

Self-hosters deploy with **`npm run deploy`** (`scripts/deploy.ts`), run from a clone after `scripts/bootstrap.sh`.
The kickoff named `scripts/deploy.sh`; the script is TypeScript instead because it parses wrangler's JSON output and
the repository's tests already run TypeScript. A **Deploy to Cloudflare button is not offered for v0.1**; issue #48
tracks trying it.

## What the deploy path has to do

1. Create a D1 database and two KV namespaces (transit files, `OAUTH_KV`).
2. Apply D1 migrations before every deploy. Upstream's deploy does not.
3. Build OpenConnector with SplitMind's patches and the trimmed catalog.
4. Set `OOMOL_CONNECT_ORIGIN` to the Worker's public URL.
5. Let the operator enter the admin token and encryption key without SplitMind ever seeing them.
6. Be safe to re-run, for upgrades.

## Options

### A. `scripts/deploy.ts` (chosen)

- Does all six. 1 and 6: it finds resources by name before creating them, and saves their ids in a git-ignored
  `splitmind.local.json`. 4: it reads the workers.dev URL from wrangler's output file and deploys a second time with
  it; until then every request gets 503. 5: it runs `wrangler secret put` interactively.
- Tested in CI against a stand-in wrangler (`tests/deploy.test.ts`): the first run creates three resources and
  deploys twice; a re-run creates nothing and deploys once.
- `--dry-run` builds and bundles with no Cloudflare login.
- Costs the operator a local Node 22 and git, and one `wrangler login`.

### B. Deploy to Cloudflare button

What Cloudflare's docs say it does (developers.cloudflare.com/workers/platform/deploy-buttons, last updated
2026-10-12): it copies the repository into the user's GitHub or GitLab account, provisions D1 and KV bindings it
finds in the wrangler config, prompts for secrets listed in `.dev.vars.example`, runs `package.json`'s `build` and
`deploy` scripts in Workers Builds, and redeploys on every push to the copy.

Why not for v0.1:

- **Origin.** `OOMOL_CONNECT_ORIGIN` must be the account's workers.dev URL, which the button cannot know before the
  first deploy. The operator would have to edit a variable afterwards, and OAuth fails closed until then.
- **Submodule and patches.** The build would have to fetch the pinned OpenConnector submodule and apply `patches/`
  inside Workers Builds. Untested; the button copies the repository, and it is not documented whether the copy keeps
  the submodule.
- **Config location.** The button reads a wrangler config at the repository (or subdirectory) root; ours is a
  template rendered into the submodule. It would need a second, committed config with placeholder ids, kept in step
  with the template.
- **Upgrades.** The copy diverges from SplitMind. Pulling a new OpenConnector pin means merging upstream SplitMind
  into the copy by hand.
- **Unverifiable here.** Trying it needs a Cloudflare account and a public test repository, i.e. Sam's logins.

The button could still become the friendlier path; #48 lists what a trial must show.

### C. Manual steps from upstream's `docs/cloudflare.md`

Works, but every step is a chance to drop a binding (upstream's example config silently loses one KV binding if both
commented blocks are uncommented; ADR-0001 finding 5) or skip migrations. Kept only as the troubleshooting reference.

## Consequences

- `docs/setup/cloudflare.md` documents A end to end; the README quickstart points to it.
- E7.3 (#36) runs A from a clean clone with a throwaway Worker name: `npm run deploy -- --name splitmind-dry-run`,
  then the teardown section.
