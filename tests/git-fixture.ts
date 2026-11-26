import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A throwaway git repo shaped like SplitMind: the engine under vendor/open-connector is its own repo, recorded in the
// superproject as a gitlink (mode 160000), the way the real submodule is. Used by the version-info and deploy tests.

export const FIXTURE_AUTHOR = { name: "Version Fixture Person", email: "person@fixture.example" };

/** Runs git in `cwd` with a fixed identity and no user or system config. Throws if git fails. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: FIXTURE_AUTHOR.name,
      GIT_AUTHOR_EMAIL: FIXTURE_AUTHOR.email,
      GIT_COMMITTER_NAME: FIXTURE_AUTHOR.name,
      GIT_COMMITTER_EMAIL: FIXTURE_AUTHOR.email,
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.replace(/\n$/, "");
}

/** Stages and commits everything in `repoDir` (an empty commit if nothing changed). Returns the new HEAD. */
export function commitAll(repoDir: string, message = "fixture"): string {
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "--allow-empty", "-m", message);
  return git(repoDir, "rev-parse", "HEAD");
}

/**
 * Commits the superproject's own changes before a deploy run, as a developer would: everything except the engine
 * gitlink (whose pin only moves on purpose), and no commit at all when nothing changed, so HEAD stays stable across runs.
 */
export function commitSuperproject(repoDir: string, message = "fixture"): string {
  git(repoDir, "add", "-A", "--", ".", ":(exclude)vendor/open-connector");
  const staged = git(repoDir, "diff", "--cached", "--name-only");
  if (staged) git(repoDir, "commit", "-q", "-m", message);
  return git(repoDir, "rev-parse", "HEAD");
}

/**
 * Turns `root` into a git repo with everything currently in it committed, and `root/vendor/open-connector` into its
 * own repo recorded as a gitlink. Returns the commit the superproject pins for the engine.
 */
export function initFixtureRepo(root: string): { gitlink: string } {
  const engine = join(root, "vendor/open-connector");
  mkdirSync(engine, { recursive: true });
  git(engine, "init", "-q");
  const gitlink = commitAll(engine, "engine baseline");
  git(root, "init", "-q");
  writeFileSync(
    join(root, ".gitmodules"),
    '[submodule "vendor/open-connector"]\n\tpath = vendor/open-connector\n\turl = https://example.invalid/open-connector.git\n',
  );
  commitAll(root, "superproject");
  return { gitlink };
}
