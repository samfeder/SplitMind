// Builds the Worker's catalog static assets from only the providers SplitMind allowlists, so a cold isolate parses a
// few hundred KB of provider metadata instead of every provider (docs/adr/0001-deployment-shape.md, finding 2).
//
// Usage: node scripts/catalog-assets.ts <engine-dir> <service>[,<service>...]
//   e.g. node scripts/catalog-assets.ts vendor/open-connector notion,slack
//
// It replaces upstream's `node scripts/copy-catalog-assets.ts` step: it reads <engine-dir>/catalog/apps (from
// `npm run generate:catalog`) and writes <engine-dir>/dist/web/catalog with upstream's own chunking code, so the
// asset format stays whatever the pinned release expects. catalog/apps itself is left untouched.
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface CatalogAssetIndex {
  providerCount: number;
  chunks: string[];
}

type CopyCatalogAssets = (options: { sourceDir: string; targetDir: string }) => Promise<CatalogAssetIndex>;

export function parseServices(list: string): string[] {
  const services = [...new Set(list.split(",").map((service) => service.trim()).filter(Boolean))].sort();
  for (const service of services) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(service)) {
      throw new Error(`not a provider id: ${JSON.stringify(service)}`);
    }
  }
  if (services.length === 0) throw new Error("no providers given");
  return services;
}

async function main(argv: string[]): Promise<number> {
  const [engineArg, serviceList] = argv;
  if (!engineArg || !serviceList) {
    console.error("usage: catalog-assets.ts <engine-dir> <service>[,<service>...]");
    return 2;
  }

  let services: string[];
  try {
    services = parseServices(serviceList);
  } catch (error) {
    console.error(`catalog-assets: ${(error as Error).message}`);
    return 2;
  }

  const engine = resolve(engineArg);
  const appsDir = join(engine, "catalog/apps");
  let files: string[];
  try {
    files = (await readdir(appsDir)).filter((name) => name.endsWith(".json"));
  } catch {
    console.error(`catalog-assets: ${appsDir} not found; run \`npm run generate:catalog\` in the engine first`);
    return 1;
  }
  const present = new Set(files.map((name) => name.slice(0, -".json".length)));
  const missing = services.filter((service) => !present.has(service));
  if (missing.length > 0) {
    console.error(`catalog-assets: not in the generated catalog: ${missing.join(", ")}`);
    return 1;
  }

  const upstream = pathToFileURL(join(engine, "scripts/copy-catalog-assets.ts")).href;
  const { copyCatalogAssets } = (await import(upstream)) as { copyCatalogAssets: CopyCatalogAssets };

  const staging = await mkdtemp(join(tmpdir(), "splitmind-catalog-"));
  try {
    await Promise.all(services.map((service) => copyFile(join(appsDir, `${service}.json`), join(staging, `${service}.json`))));
    const index = await copyCatalogAssets({ sourceDir: staging, targetDir: join(engine, "dist/web/catalog") });
    console.log(
      `catalog-assets: kept ${services.join(", ")} (${index.providerCount} of ${files.length} providers) in ${index.chunks.length} chunk(s).`,
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
