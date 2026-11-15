// Finds hard-coded dates in OpenConnector's test files that are about to pass (or just have). A fixture such as
// `expiresAt: "2026-12-28"` is fine until the day it counts as expired, then it breaks every merge. Scans test and spec
// files under vendor/open-connector/{src,web/src,scripts}. Usage: node scripts/check-vendor-dates.ts. Add
// `// date-guard: ok` to a line whose date is intentionally fixed and harmless.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Finding {
  path: string;
  line: number;
  literal: string;
}

const DAY_MS = 86_400_000;
const WINDOW_BEFORE_DAYS = 1;
const WINDOW_AFTER_DAYS = 400;
const OPT_OUT = "date-guard: ok";

// An ISO date or date-time directly inside quotes or backticks, or right after a `${...}` interpolation, e.g.
// "2026-12-28", `2026-12-28T10:00:00.000Z`, "2026-12-28 10:00:00" or `${x}2026-12-28`.
const isoPattern = /(?<=["'`]|\$\{[^}]*\})(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}[^"'`]*)?(?=["'`])/g;
// A slash date directly inside quotes, e.g. "2026/12/29" or "2027/1/5". The month is 1-based.
const slashPattern = /(?<=["'`])(\d{4})\/(\d{1,2})\/(\d{1,2})(?=["'`])/g;
// new Date(2027, 0, 5 ...), Date.UTC(2027, 0, 5 ...) and the two-argument new Date(2027, 0) (day 1). The month is 0-based.
const numericPattern = /\b(?:new Date|Date\.UTC)\(\s*(\d{4})\s*,\s*(\d{1,2})\b(?:\s*,\s*(\d{1,2})\b)?[^)]*\)/g;

// Returns the day number, or undefined when year, month and day do not map back to themselves (2026-02-30, day 0).
function dayNumber(year: number, month0: number, day: number): number | undefined {
  const ms = Date.UTC(year, month0, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month0 || d.getUTCDate() !== day) return undefined;
  return Math.floor(ms / DAY_MS);
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.ts$/.test(path);
}

export function findExpiringDates(files: { path: string; text: string }[], now: Date): Finding[] {
  const today = Math.floor(now.getTime() / DAY_MS);
  const first = today - WINDOW_BEFORE_DAYS;
  const last = today + WINDOW_AFTER_DAYS;
  const findings: Finding[] = [];

  for (const file of files) {
    if (!isTestFile(file.path)) continue;
    file.text.split(/\r?\n/).forEach((lineText, index) => {
      if (lineText.includes(OPT_OUT)) return;
      const candidates: { literal: string; day: number | undefined }[] = [];
      for (const m of lineText.matchAll(isoPattern)) {
        candidates.push({ literal: m[0], day: dayNumber(Number(m[1]), Number(m[2]) - 1, Number(m[3])) });
      }
      for (const m of lineText.matchAll(slashPattern)) {
        candidates.push({ literal: m[0], day: dayNumber(Number(m[1]), Number(m[2]) - 1, Number(m[3])) });
      }
      for (const m of lineText.matchAll(numericPattern)) {
        candidates.push({ literal: m[0], day: dayNumber(Number(m[1]), Number(m[2]), m[3] === undefined ? 1 : Number(m[3])) });
      }
      for (const candidate of candidates) {
        if (candidate.day !== undefined && candidate.day >= first && candidate.day <= last) {
          findings.push({ path: file.path, line: index + 1, literal: candidate.literal });
        }
      }
    });
  }

  return findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

const SCAN_DIRS = ["vendor/open-connector/src", "vendor/open-connector/web/src", "vendor/open-connector/scripts"];

// The directories the CLI scans, relative to repo: whichever of SCAN_DIRS exist.
export function vendorScanDirs(repo: string): string[] {
  return SCAN_DIRS.filter((dir) => existsSync(join(repo, dir)));
}

function readTestFiles(repo: string, dir: string): { path: string; text: string }[] {
  const entries = readdirSync(join(repo, dir), { recursive: true }) as string[];
  return entries
    .map((entry) => join(dir, entry))
    .filter((path) => isTestFile(path) && !path.split("/").includes("node_modules"))
    .sort()
    .map((path) => ({ path, text: readFileSync(join(repo, path), "utf8") }));
}

if (import.meta.main) {
  const files = vendorScanDirs(".").flatMap((dir) => readTestFiles(".", dir));
  const findings = findExpiringDates(files, new Date());
  for (const finding of findings) console.log(`${finding.path}:${finding.line} ${finding.literal}`);
  if (findings.length === 0) {
    console.log(`check-vendor-dates: ${files.length} test files, no dates near expiry.`);
  } else {
    console.log(`check-vendor-dates: ${findings.length} date(s) near expiry; make them relative to Date.now() or add "// ${OPT_OUT}".`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
