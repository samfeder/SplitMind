# Contributing

Thanks for helping. SplitMind is small on purpose: OpenConnector does the work,
and this repository holds the overlay that deploys and configures it.

- **One issue, one branch, one pull request.** Reference the issue with
  `Closes #N`. CI must pass before merge.
- **Fix gaps upstream.** Provider code and engine changes go to
  [OpenConnector](https://github.com/oomol-lab/open-connector). If we need a
  fix before upstream merges it, add a patch under `patches/` that links to the
  upstream issue or pull request.
- **No secrets, nothing personal.** Docs use placeholders such as
  `<your-worker>.workers.dev` and `<workspace-alias>`. Local config lives in
  git-ignored files (`wrangler.local.jsonc`, `.env`, `.dev.vars`). CI runs
  gitleaks on every pull request, and `npm test` runs `npm run check:docs`'s
  checks: no real Worker hosts, emails, account ids or tokens in the docs, and
  no broken relative links.
- **Test behaviour at the seams.** Tests exercise the deployed Worker's HTTP
  surface and our scripts' command-line behaviour, not internal collaborators.
- **Tooling:** TypeScript, Node 22+, wrangler via `npx`.

Getting started:

```sh
git clone --recurse-submodules https://github.com/samfeder/SplitMind.git
cd SplitMind
```

Security issues: see [SECURITY.md](SECURITY.md).
