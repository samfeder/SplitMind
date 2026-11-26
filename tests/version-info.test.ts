import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildVersionInfo, writeVersionFile } from "../scripts/deploy.ts";
import { commitAll, FIXTURE_AUTHOR, git, initFixtureRepo } from "./git-fixture.ts";

// #83. What a deploy publishes at /version.json, built from a real throwaway git repo (not a mock of git).
//
// Pinned API (scripts/deploy.ts):
//   buildVersionInfo(repoRoot: string, now: Date = new Date()): VersionInfo      synchronous, never throws for a
//                                                                                folder that is not a repo
//   writeVersionFile(repoRoot: string, webDist: string, info: VersionInfo = buildVersionInfo(repoRoot)): void
//                                                                                writes <webDist>/version.json

const NOW = new Date("2026-03-04T05:06:07.089Z");

let root: string;
let engine: string;
let gitlink: string;

const write = (path: string, content: string | Buffer) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "splitmind-version-"));
  engine = join(root, "vendor/open-connector");
  write(join(engine, "package.json"), JSON.stringify({ name: "open-connector", version: "1.9.2" }));
  write(join(engine, "src.txt"), "engine source\n");
  // Created out of name order on purpose. 0010 sorts after 0002 only if names are compared as strings, not numbers.
  write(join(root, "patches/0010-late.patch"), "a\r\nb\r\n");
  write(join(root, "patches/0001-first.patch"), "hello\n");
  write(join(root, "patches/0002-binary.patch"), Buffer.from([0x00, 0xff, 0x10, ...Buffer.from("binary")]));
  write(join(root, "patches/README.md"), "not a patch\n");
  write(join(root, "tracked.txt"), "tracked\n");
  write(join(root, ".gitignore"), "ignored.log\n");
  ({ gitlink } = initFixtureRepo(root));
  // The way a real checkout looks after bootstrap: the engine sits past the pinned commit with patched and new files.
  write(join(engine, "src.txt"), "engine source, patched\n");
  write(join(engine, "patched-new-file.ts"), "export {};\n");
  commitAll(engine, "local baseline");
  write(join(engine, "src.txt"), "engine source, patched again\n");
  write(join(engine, "untracked-in-engine.txt"), "x\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildVersionInfo (#83)", () => {
  it("V1: has exactly the documented shape, and nothing else", () => {
    const info = buildVersionInfo(root, NOW);

    expect(Object.keys(info).sort()).toEqual(["builtAt", "openconnector", "patches", "splitmind"]);
    expect(Object.keys(info.splitmind).sort()).toEqual(["commit", "dirty"]);
    expect(Object.keys(info.openconnector).sort()).toEqual(["commit", "version"]);
    for (const patch of info.patches) expect(Object.keys(patch).sort()).toEqual(["name", "sha256"]);
    // Survives a JSON round trip unchanged, so it is plain data.
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });

  it("V1: splitmind.commit is the 40-hex HEAD of the SplitMind repo", () => {
    const head = git(root, "rev-parse", "HEAD");

    const info = buildVersionInfo(root, NOW);

    expect(info.splitmind.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(info.splitmind.commit).toBe(head);
  });

  it("V1: openconnector.commit is the commit the superproject pins, not the engine checkout's own HEAD", () => {
    const engineHead = git(engine, "rev-parse", "HEAD");
    expect(engineHead).not.toBe(gitlink);
    expect(git(root, "ls-tree", "HEAD", "vendor/open-connector")).toBe(`160000 commit ${gitlink}\tvendor/open-connector`);

    const info = buildVersionInfo(root, NOW);

    expect(info.openconnector.commit).toBe(gitlink);
    expect(info.openconnector.commit).not.toBe(engineHead);
  });

  it("V1: openconnector.version comes from the engine's package.json", () => {
    expect(buildVersionInfo(root, NOW).openconnector.version).toBe("1.9.2");

    write(join(engine, "package.json"), JSON.stringify({ name: "open-connector", version: "2.0.0-rc.1" }));
    expect(buildVersionInfo(root, NOW).openconnector.version).toBe("2.0.0-rc.1");
  });

  it("V1: patches lists every patches/*.patch sorted by name, each with the sha256 of the file's bytes", () => {
    const info = buildVersionInfo(root, NOW);

    expect(info.patches).toEqual([
      { name: "0001-first.patch", sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03" },
      { name: "0002-binary.patch", sha256: "11a5f452581409e2398f3aaec3fe1e5709d1ef57837e3cb64fc45a64366ff6da" },
      { name: "0010-late.patch", sha256: "58055bdcc73787eb88c78d36f0b4939e9c5dc1c3ad17e25cc85a6833cf1a0cab" },
    ]);
  });

  it("V1: the hash follows the file: edit a patch and its sha256 changes, others stay", () => {
    const before = buildVersionInfo(root, NOW).patches;

    write(join(root, "patches/0001-first.patch"), "hello again\n");
    const after = buildVersionInfo(root, NOW).patches;

    expect(after.map((patch) => patch.name)).toEqual(before.map((patch) => patch.name));
    expect(after[0]!.sha256).not.toBe(before[0]!.sha256);
    expect(after[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  it("V1: a repo with no patches directory has an empty patches list", () => {
    rmSync(join(root, "patches"), { recursive: true });

    expect(buildVersionInfo(root, NOW).patches).toEqual([]);
  });

  it("V1: builtAt is the injected time as ISO 8601 UTC, and the output is deterministic for a fixed time", () => {
    const first = buildVersionInfo(root, NOW);

    expect(first.builtAt).toBe("2026-03-04T05:06:07.089Z");
    expect(buildVersionInfo(root, NOW)).toEqual(first);
    expect(buildVersionInfo(root, new Date("2030-01-01T00:00:00.000Z")).builtAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("V1: without an injected time, builtAt is the current time", () => {
    const before = Date.now();
    const info = buildVersionInfo(root);
    const after = Date.now();

    expect(info.builtAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Date.parse(info.builtAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(info.builtAt)).toBeLessThanOrEqual(after);
  });

  it("V1: nothing about the person or machine is in it", () => {
    const text = JSON.stringify(buildVersionInfo(root, NOW));

    expect(text).not.toContain(FIXTURE_AUTHOR.name);
    expect(text).not.toContain(FIXTURE_AUTHOR.email);
    expect(text).not.toContain(root);
    expect(text).not.toContain(tmpdir());
  });

  describe("V2: dirty", () => {
    it("a clean tree whose only change is the vendor submodule (new commit, modified and untracked files inside) is not dirty", () => {
      // beforeEach already leaves the engine ahead of the pin, with a modified tracked file and an untracked one.
      expect(git(root, "status", "--porcelain")).toBe(" M vendor/open-connector");

      const info = buildVersionInfo(root, NOW);

      expect(info.splitmind.dirty).toBe(false);
    });

    it("a freshly committed tree with the engine exactly at the pin is not dirty", () => {
      git(engine, "checkout", "-q", "--", ".");
      git(engine, "reset", "-q", "--hard", gitlink);
      git(engine, "clean", "-fdq");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(false);
    });

    it("a modified tracked file is dirty", () => {
      write(join(root, "tracked.txt"), "changed\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("a modified patch is dirty (the file is tracked)", () => {
      write(join(root, "patches/0001-first.patch"), "edited\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("a deleted tracked file is dirty", () => {
      rmSync(join(root, "tracked.txt"));

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("a staged but uncommitted change is dirty", () => {
      write(join(root, "staged.txt"), "staged\n");
      git(root, "add", "staged.txt");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("an untracked file that is not ignored is dirty", () => {
      write(join(root, "notes.txt"), "scratch\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("an untracked file inside an untracked directory is dirty", () => {
      write(join(root, "scratch/deep/notes.txt"), "scratch\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("an untracked .spec-*.md is not dirty", () => {
      write(join(root, ".spec-x.md"), "spec\n");
      write(join(root, ".spec-83.md"), "spec\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(false);
    });

    it("an untracked splitmind.local.json is not dirty", () => {
      write(join(root, "splitmind.local.json"), "{}\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(false);
    });

    it("a gitignored file is not dirty", () => {
      write(join(root, "ignored.log"), "noise\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(false);
    });

    it("the exceptions do not hide a real change next to them", () => {
      write(join(root, ".spec-x.md"), "spec\n");
      write(join(root, "splitmind.local.json"), "{}\n");
      write(join(root, "ignored.log"), "noise\n");
      write(join(root, "notes.txt"), "scratch\n");

      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);
    });

    it("dirty does not change what commit is reported", () => {
      const head = git(root, "rev-parse", "HEAD");
      write(join(root, "notes.txt"), "scratch\n");

      const info = buildVersionInfo(root, NOW);

      expect(info.splitmind.commit).toBe(head);
      expect(info.splitmind.dirty).toBe(true);
    });

    it("a new commit moves the reported commit; committing the change makes the tree clean again", () => {
      const before = buildVersionInfo(root, NOW).splitmind.commit;
      write(join(root, "notes.txt"), "scratch\n");
      expect(buildVersionInfo(root, NOW).splitmind.dirty).toBe(true);

      git(root, "add", "notes.txt");
      git(root, "commit", "-q", "-m", "notes");

      const info = buildVersionInfo(root, NOW);
      expect(info.splitmind.dirty).toBe(false);
      expect(info.splitmind.commit).toBe(git(root, "rev-parse", "HEAD"));
      expect(info.splitmind.commit).not.toBe(before);
    });
  });

  describe("when there is no usable git", () => {
    it("a folder that is not a repo reports commit unknown and dirty true, and still lists the patches and the engine version", () => {
      const plain = mkdtempSync(join(tmpdir(), "splitmind-notrepo-"));
      try {
        write(join(plain, "patches/0001-first.patch"), "hello\n");
        write(join(plain, "vendor/open-connector/package.json"), JSON.stringify({ version: "1.9.2" }));

        const info = buildVersionInfo(plain, NOW);

        expect(info.splitmind).toEqual({ commit: "unknown", dirty: true });
        expect(info.openconnector.version).toBe("1.9.2");
        expect(info.patches).toEqual([
          { name: "0001-first.patch", sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03" },
        ]);
        expect(info.builtAt).toBe("2026-03-04T05:06:07.089Z");
      } finally {
        rmSync(plain, { recursive: true, force: true });
      }
    });

    it("a repo with no commits yet reports commit unknown and dirty true", () => {
      const fresh = mkdtempSync(join(tmpdir(), "splitmind-fresh-"));
      try {
        git(fresh, "init", "-q");
        write(join(fresh, "vendor/open-connector/package.json"), JSON.stringify({ version: "1.9.2" }));

        const info = buildVersionInfo(fresh, NOW);

        expect(info.splitmind.commit).toBe("unknown");
        expect(info.splitmind.dirty).toBe(true);
      } finally {
        rmSync(fresh, { recursive: true, force: true });
      }
    });

    it("git missing from PATH: commit unknown, dirty true, and no throw", () => {
      const empty = mkdtempSync(join(tmpdir(), "splitmind-nogit-"));
      const savedPath = process.env.PATH;
      try {
        process.env.PATH = empty;

        const info = buildVersionInfo(root, NOW);

        expect(info.splitmind).toEqual({ commit: "unknown", dirty: true });
        expect(info.patches).toHaveLength(3);
      } finally {
        process.env.PATH = savedPath;
        rmSync(empty, { recursive: true, force: true });
      }
    });
  });
});

describe("writeVersionFile (#83)", () => {
  let webDist: string;

  beforeEach(() => {
    webDist = join(root, "vendor/open-connector/dist/web");
    mkdirSync(webDist, { recursive: true });
  });

  it("writes <webDist>/version.json holding exactly the info it is given, as JSON", () => {
    const info = {
      splitmind: { commit: "a".repeat(40), dirty: true },
      openconnector: { version: "9.9.9", commit: "b".repeat(40) },
      patches: [{ name: "0001-x.patch", sha256: "c".repeat(64) }],
      builtAt: "2026-01-02T03:04:05.000Z",
    };

    const returned = writeVersionFile(root, webDist, info);

    expect(returned).toBeUndefined();
    expect(JSON.parse(readFileSync(join(webDist, "version.json"), "utf8"))).toEqual(info);
  });

  it("builds the info from the repo when none is given", () => {
    writeVersionFile(root, webDist);

    const written = JSON.parse(readFileSync(join(webDist, "version.json"), "utf8")) as ReturnType<typeof buildVersionInfo>;
    expect(Object.keys(written).sort()).toEqual(["builtAt", "openconnector", "patches", "splitmind"]);
    expect(written.splitmind.commit).toBe(git(root, "rev-parse", "HEAD"));
    expect(written.openconnector.commit).toBe(gitlink);
    expect(written.patches.map((patch) => patch.name)).toEqual(["0001-first.patch", "0002-binary.patch", "0010-late.patch"]);
  });

  it("overwrites an earlier version.json instead of appending", () => {
    const info = buildVersionInfo(root, NOW);
    writeVersionFile(root, webDist, info);
    writeVersionFile(root, webDist, { ...info, builtAt: "2031-01-01T00:00:00.000Z" });

    expect(JSON.parse(readFileSync(join(webDist, "version.json"), "utf8")).builtAt).toBe("2031-01-01T00:00:00.000Z");
  });

  it("writes only version.json into the build output", () => {
    writeVersionFile(root, webDist, buildVersionInfo(root, NOW));

    expect(readdirSync(webDist).sort()).toEqual(["version.json"]);
  });
});
