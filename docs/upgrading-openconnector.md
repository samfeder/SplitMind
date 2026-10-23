# Upgrading OpenConnector

SplitMind does not fork [OpenConnector](https://github.com/oomol-lab/open-connector).
It pins it as a git submodule at `vendor/open-connector`, on a release tag, and
carries any not-yet-merged upstream fixes as patches in `patches/`. This page
explains how to move that pin.

## How the pin works

- `.gitmodules` records where the submodule comes from.
- The commit SplitMind uses is recorded in the SplitMind tree itself (a
  "gitlink"). `git submodule status` shows it:

  ```sh
  git submodule status vendor/open-connector
  ```

- `scripts/bootstrap.sh` checks out that exact commit, applies every
  `patches/*.patch` in name order, and installs dependencies. Re-running it is
  safe: patches that are already applied are skipped.

## Upgrade steps

1. **Pick the release.** Read the upstream
   [releases](https://github.com/oomol-lab/open-connector/releases) between the
   current tag and the new one. Note anything about migrations, environment
   variables, OAuth, policy settings, Cloudflare bindings, or the Notion and
   Slack providers.

2. **Check the licence is still Apache-2.0.** If upstream's `LICENSE.txt`
   changed, stop and raise it before upgrading.

3. **Move the pin** on a new branch:

   ```sh
   git switch -c upgrade-openconnector-<new-tag>
   git -C vendor/open-connector fetch --depth 1 origin tag <new-tag>
   git -C vendor/open-connector checkout --force <new-tag>
   git add vendor/open-connector
   ```

   `--force` throws away patches that bootstrap applied to the submodule's
   working tree. They are re-applied in the next step. The submodule is a
   shallow clone (`shallow = true` in `.gitmodules`), so fetch only the new
   tag; `git -C vendor/open-connector fetch --unshallow` gets the full history
   if you need it.

4. **Re-apply patches.**

   ```sh
   scripts/bootstrap.sh
   ```

   For each patch in `patches/`:
   - If upstream merged the fix, delete the patch and say so in the pull
     request, linking the upstream pull request.
   - If bootstrap stops with `does not apply`, rebase the fix onto the new tag
     in the `samfeder/open-connector` fork, regenerate the patch with
     `git format-patch`, and update the link at the top of the patch file.

   Every patch must link to its upstream issue or pull request.

5. **Check the deployment config.** Compare upstream's `wrangler.example.jsonc`
   at the old and new tags and carry any new bindings, variables or
   compatibility settings into SplitMind's wrangler config template.

6. **Run migrations before deploying.** New releases may add D1 migrations.
   Apply them before the new code goes live:

   ```sh
   npx wrangler d1 migrations apply <database-name> --remote
   ```

7. **Open the pull request.** Title it `Upgrade OpenConnector to <new-tag>`,
   list the upstream changes that matter, the patches dropped or refreshed,
   and any config changes. CI must pass before merge.

## Rolling back

Move the gitlink back to the previous tag the same way (step 3), run
`scripts/bootstrap.sh`, and redeploy. D1 migrations are not rolled back
automatically; check the upstream release notes before rolling back across a
migration.
