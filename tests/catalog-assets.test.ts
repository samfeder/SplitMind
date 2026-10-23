import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Runs the real scripts/catalog-assets.ts against a stand-in engine. Its copy-catalog-assets.ts records which
// provider files it was handed, which is the only thing SplitMind's script decides.

const script = resolve(import.meta.dirname, "../scripts/catalog-assets.ts");

const FAKE_COPY_CATALOG = `import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function copyCatalogAssets({ sourceDir, targetDir }) {
  const files = (await readdir(sourceDir)).sort();
  const contents = await Promise.all(files.map((file) => readFile(join(sourceDir, file), "utf8")));
  await mkdir(targetDir, { recursive: true });
  await writeFile(join(targetDir, "index.json"), JSON.stringify({ files, contents }));
  return { providerCount: files.length, chunks: ["apps-0000.json"] };
}
`;

let engine: string;

beforeEach(() => {
  engine = mkdtempSync(join(tmpdir(), "splitmind-catalog-"));
  mkdirSync(join(engine, "catalog/apps"), { recursive: true });
  mkdirSync(join(engine, "scripts"), { recursive: true });
  writeFileSync(join(engine, "scripts/copy-catalog-assets.ts"), FAKE_COPY_CATALOG);
  for (const service of ["github", "gmail", "notion", "slack"]) {
    writeFileSync(join(engine, `catalog/apps/${service}.json`), `{"service":"${service}"}`);
  }
});

afterEach(() => {
  rmSync(engine, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

describe("scripts/catalog-assets.ts", () => {
  it("hands upstream's copier only the listed providers and leaves catalog/apps alone", () => {
    const result = run(engine, "slack, notion");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("catalog-assets: kept notion, slack (2 of 4 providers) in 1 chunk(s).");
    expect(JSON.parse(readFileSync(join(engine, "dist/web/catalog/index.json"), "utf8"))).toEqual({
      files: ["notion.json", "slack.json"],
      contents: ['{"service":"notion"}', '{"service":"slack"}'],
    });
    expect(readdirSync(join(engine, "catalog/apps")).sort()).toEqual([
      "github.json",
      "gmail.json",
      "notion.json",
      "slack.json",
    ]);
  });

  it("fails when a listed provider is not in the generated catalog", () => {
    const result = run(engine, "notion,slackbot");

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("catalog-assets: not in the generated catalog: slackbot");
    expect(existsSync(join(engine, "dist"))).toBe(false);
  });

  it("fails when the catalog has not been generated", () => {
    rmSync(join(engine, "catalog"), { recursive: true });

    const result = run(engine, "notion");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("run `npm run generate:catalog` in the engine first");
  });

  it("rejects a provider id that could escape the catalog directory", () => {
    const result = run(engine, "../secrets");

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe('catalog-assets: not a provider id: "../secrets"');
  });

  it("prints usage without arguments", () => {
    const result = run();

    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("usage: catalog-assets.ts <engine-dir> <service>[,<service>...]");
  });
});
