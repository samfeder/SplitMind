import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real scripts/bootstrap.sh against throwaway git repositories: a
// stand-in "upstream" and a SplitMind checkout that pins it as a submodule.

const script = resolve(import.meta.dirname, "../scripts/bootstrap.sh");

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  // Local file:// submodules are off by default since git 2.38.1.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function bootstrap(cwd: string, ...args: string[]) {
  return spawnSync("bash", [join(cwd, "scripts/bootstrap.sh"), ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

const VALID_PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-hello from upstream
+hello from upstream, patched
`;

const BROKEN_PATCH = `diff --git a/greeting.txt b/greeting.txt
--- a/greeting.txt
+++ b/greeting.txt
@@ -1 +1 @@
-text that is not in the file
+replacement
`;

let dir: string;
let checkout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "splitmind-bootstrap-"));

  const upstream = join(dir, "upstream");
  mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  writeFileSync(join(upstream, "greeting.txt"), "hello from upstream\n");
  for (const f of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(upstream, f), `${f} original\n`);
  // Two identical six-line blocks, so a hunk's context also matches the other block.
  writeFileSync(join(upstream, "rep.txt"), "a\nb\nc\nd\ne\nf\na\nb\nc\nd\ne\nf\n");
  git(upstream, "add", "greeting.txt", "a.txt", "b.txt", "c.txt", "rep.txt");
  git(upstream, "commit", "-q", "-m", "upstream");
  git(upstream, "tag", "v1.0.0");

  const origin = join(dir, "origin");
  mkdirSync(join(origin, "scripts"), { recursive: true });
  git(origin, "init", "-q", "-b", "main");
  copyFileSync(script, join(origin, "scripts/bootstrap.sh"));
  git(origin, "submodule", "add", "-q", upstream, "vendor/open-connector");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "pin upstream");

  // A plain clone leaves the submodule uninitialised, like a fresh checkout.
  checkout = join(dir, "checkout");
  git(dir, "clone", "-q", origin, checkout);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function addPatch(name: string, body: string) {
  mkdirSync(join(checkout, "patches"), { recursive: true });
  writeFileSync(join(checkout, "patches", name), body);
}

function greeting(): string {
  return readFileSync(join(checkout, "vendor/open-connector/greeting.txt"), "utf8");
}

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasGit)("scripts/bootstrap.sh", () => {
  it("initialises the submodule and reports when there are no patches", () => {
    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("No patches to apply.");
    expect(run.stdout).toContain("v1.0.0");
    expect(greeting()).toBe("hello from upstream\n");
  });

  it("applies a patch, and skips it on a second run", () => {
    addPatch("0001-greeting.patch", VALID_PATCH);

    const first = bootstrap(checkout, "--skip-install");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("applied: patches/0001-greeting.patch");
    expect(greeting()).toBe("hello from upstream, patched\n");

    const second = bootstrap(checkout, "--skip-install");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already applied: patches/0001-greeting.patch");
    expect(greeting()).toBe("hello from upstream, patched\n");
  });

  it("skips stacked patches that no longer reverse one by one", () => {
    addPatch("0001-greeting.patch", VALID_PATCH);
    addPatch(
      "0002-greeting-again.patch",
      VALID_PATCH.replace("-hello from upstream\n", "-hello from upstream, patched\n").replace(
        "+hello from upstream, patched\n",
        "+hello from upstream, patched twice\n",
      ),
    );
    expect(bootstrap(checkout, "--skip-install").status).toBe(0);

    const second = bootstrap(checkout, "--skip-install");

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already applied: patches/0001-greeting.patch");
    expect(second.stdout).toContain("already applied: patches/0002-greeting-again.patch");
    expect(greeting()).toBe("hello from upstream, patched twice\n");
  });

  it("stops and names a patch that does not apply", () => {
    addPatch("0001-broken.patch", BROKEN_PATCH);

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("patches/0001-broken.patch does not apply");
    expect(greeting()).toBe("hello from upstream\n");
  });

  it("rejects an unknown option", () => {
    const run = bootstrap(checkout, "--bogus");

    expect(run.status).toBe(2);
    expect(run.stderr).toContain("unknown option: --bogus");
  });
});

// --- #118: a patch missing from the middle of the stack -------------------------------------------------------------

function filePatch(file: string, from: string, to: string): string {
  return `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
}

const P1 = "0001-a.patch";
const P2 = "0002-b.patch";
const P3 = "0003-c.patch";
const RESET = "git -C vendor/open-connector checkout -- . && git -C vendor/open-connector clean -fd";

function engineFile(name: string): string {
  return readFileSync(join(checkout, "vendor/open-connector", name), "utf8");
}

function engineStatus(): string {
  return git(join(checkout, "vendor/open-connector"), "status", "--porcelain");
}

function snapshot() {
  return { a: engineFile("a.txt"), b: engineFile("b.txt"), c: engineFile("c.txt"), status: engineStatus() };
}

// Three independent patches: 0001 edits a.txt, 0002 edits b.txt, 0003 edits c.txt.
function addIndependentStack() {
  addPatch(P1, filePatch("a.txt", "a.txt original", "a.txt one"));
  addPatch(P2, filePatch("b.txt", "b.txt original", "b.txt two"));
  addPatch(P3, filePatch("c.txt", "c.txt original", "c.txt three"));
}

// 0003 rewrites the line 0001 added, so once 0003 is on, 0001 neither reverses nor applies. 0002 is independent.
function addDependentStack() {
  addPatch(P1, filePatch("a.txt", "a.txt original", "a.txt one"));
  addPatch(P2, filePatch("b.txt", "b.txt original", "b.txt two"));
  addPatch(P3, filePatch("a.txt", "a.txt one", "a.txt three"));
}

// Initialise the submodule (no bootstrap, so nothing is applied), then apply the named patches by hand.
function applyByHand(...names: string[]) {
  git(checkout, "submodule", "update", "--init", "--", "vendor/open-connector");
  for (const name of names) git(join(checkout, "vendor/open-connector"), "apply", join(checkout, "patches", name));
}

const appliedLine = (name: string) => new RegExp(`^\\s*applied: patches/${name.replace(".", "\\.")}`, "m");

describe.skipIf(!hasGit)("scripts/bootstrap.sh: stacked patches", () => {
  it("applies every patch in order on a clean tree and exits 0", () => {
    addIndependentStack();

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(0);
    expect(run.stdout).not.toContain("already applied");
    const lines = run.stdout.split("\n").filter((l) => /^\s*applied: /.test(l));
    expect(lines.map((l) => l.trim())).toEqual([
      `applied: patches/${P1}`,
      `applied: patches/${P2}`,
      `applied: patches/${P3}`,
    ]);
    expect(snapshot()).toMatchObject({ a: "a.txt one\n", b: "b.txt two\n", c: "c.txt three\n" });
  });

  it("reports all three already applied on a second run", () => {
    addIndependentStack();
    expect(bootstrap(checkout, "--skip-install").status).toBe(0);
    const before = snapshot();

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(0);
    for (const name of [P1, P2, P3]) expect(run.stdout).toContain(`already applied: patches/${name}`);
    expect(run.stdout).not.toMatch(/^\s*applied: /m);
    expect(snapshot()).toEqual(before);
  });

  it("treats a patch that later patches rewrote as applied, and exits 0 on a fully patched tree", () => {
    addDependentStack();
    const first = bootstrap(checkout, "--skip-install");
    expect(first.status).toBe(0);
    expect(engineFile("a.txt")).toBe("a.txt three\n");

    const second = bootstrap(checkout, "--skip-install");

    expect(second.status).toBe(0);
    for (const name of [P1, P2, P3]) expect(second.stdout).toContain(`already applied: patches/${name}`);
  });

  it.each([
    ["independent stack", addIndependentStack, [P1, P3]],
    ["stack where 0003 rewrites 0001", addDependentStack, [P1, P3]],
  ])("stops, names the patch and the reset command when 0002 is missing (%s)", (_label, addStack, applied) => {
    addStack();
    applyByHand(...applied);
    const before = snapshot();

    const run = bootstrap(checkout, "--skip-install");
    const output = run.stdout + run.stderr;

    expect(run.status).not.toBe(0);
    expect(run.status).not.toBe(2); // 2 is the usage error
    expect(output).toContain(P2);
    expect(output).toContain(RESET);
    expect(output).toMatch(/bootstrap[^\n]*again|again[^\n]*bootstrap/i);
    expect(output).not.toContain(`already applied: patches/${P2}`);
    expect(run.stdout).not.toMatch(appliedLine(P2));
    expect(run.stdout).not.toContain("Bootstrap complete");
    expect(snapshot()).toEqual(before);
  });

  it("stops when the first patch is missing but later ones are on", () => {
    addIndependentStack();
    applyByHand(P2, P3);
    const before = snapshot();

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain(P1);
    expect(run.stdout + run.stderr).toContain(RESET);
    expect(run.stdout).not.toMatch(appliedLine(P1));
    expect(snapshot()).toEqual(before);
  });

  it("fails the same way when run again, and the printed reset command then lets bootstrap finish", () => {
    addIndependentStack();
    applyByHand(P1, P3);

    const once = bootstrap(checkout, "--skip-install");
    const twice = bootstrap(checkout, "--skip-install");
    expect(once.status).not.toBe(0);
    expect(twice.status).toBe(once.status);

    const reset = spawnSync("sh", ["-c", RESET], { cwd: checkout, env, encoding: "utf8" });
    expect(reset.status).toBe(0);
    expect(snapshot()).toMatchObject({ a: "a.txt original\n", b: "b.txt original\n", c: "c.txt original\n", status: "" });

    const retry = bootstrap(checkout, "--skip-install");
    expect(retry.status).toBe(0);
    for (const name of [P1, P2, P3]) expect(retry.stdout).toMatch(appliedLine(name));
    expect(snapshot()).toMatchObject({ a: "a.txt one\n", b: "b.txt two\n", c: "c.txt three\n" });
  });

  it("still applies a missing newest patch (nothing is skipped after it)", () => {
    addIndependentStack();
    applyByHand(P1, P2);

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`already applied: patches/${P1}`);
    expect(run.stdout).toContain(`already applied: patches/${P2}`);
    expect(run.stdout).toMatch(appliedLine(P3));
    expect(engineFile("c.txt")).toBe("c.txt three\n");
  });

  // 0001 inserts X into the SECOND block of rep.txt; its context (a b c / d e f) also appears in the first block, so on a
  // patched tree the patch still applies forward (at an offset, to the first block) as well as reversing.
  const REPEATED_CONTEXT_PATCH = [
    "diff --git a/rep.txt b/rep.txt",
    "--- a/rep.txt",
    "+++ b/rep.txt",
    "@@ -7,6 +7,7 @@",
    " a",
    " b",
    " c",
    "+X",
    " d",
    " e",
    " f",
    "",
  ].join("\n");
  const NEW_FILE_PATCH = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+new file",
    "",
  ].join("\n");
  const REP_PATCHED = "a\nb\nc\nd\ne\nf\na\nb\nc\nX\nd\ne\nf\n";
  const REP_ORIGINAL = "a\nb\nc\nd\ne\nf\na\nb\nc\nd\ne\nf\n";

  it("reports a patch as already applied when its context also appears elsewhere in the file", () => {
    addPatch(P1, REPEATED_CONTEXT_PATCH);
    addPatch(P2, NEW_FILE_PATCH);
    const first = bootstrap(checkout, "--skip-install");
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(appliedLine(P1));
    expect(first.stdout).toMatch(appliedLine(P2));
    expect(engineFile("rep.txt")).toBe(REP_PATCHED);

    const second = bootstrap(checkout, "--skip-install");

    expect(second.status).toBe(0);
    expect(second.stderr).not.toContain("not applied");
    expect(second.stdout).toContain(`already applied: patches/${P1}`);
    expect(second.stdout).toContain(`already applied: patches/${P2}`);
    expect(second.stdout).not.toMatch(/^\s*applied: /m);
    expect(engineFile("rep.txt")).toBe(REP_PATCHED);
  });

  it("still stops on a repeated-context patch that really is missing while a later one is on", () => {
    addPatch(P1, REPEATED_CONTEXT_PATCH);
    addPatch(P2, NEW_FILE_PATCH);
    applyByHand(P2);

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain(P1);
    expect(run.stdout + run.stderr).toContain(RESET);
    expect(run.stdout).not.toMatch(appliedLine(P1));
    expect(engineFile("rep.txt")).toBe(REP_ORIGINAL);
  });

  it("stops with the does-not-apply message on a conflicting patch in the middle of a clean tree", () => {
    addPatch(P1, filePatch("a.txt", "a.txt original", "a.txt one"));
    addPatch(P2, filePatch("b.txt", "text that is not in the file", "b.txt two"));
    addPatch(P3, filePatch("c.txt", "c.txt original", "c.txt three"));

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`patches/${P2} does not apply`);
    expect(run.stdout).not.toMatch(appliedLine(P3));
    expect(engineFile("c.txt")).toBe("c.txt original\n");
  });

  it("uses the does-not-apply message, not the recovery message, for a conflict after the applied prefix", () => {
    addPatch(P1, filePatch("a.txt", "a.txt original", "a.txt one"));
    addPatch(P2, filePatch("b.txt", "text that is not in the file", "b.txt two"));
    applyByHand(P1);

    const run = bootstrap(checkout, "--skip-install");

    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`patches/${P2} does not apply`);
    expect(run.stdout + run.stderr).not.toContain(RESET);
  });
});
