// Finds hard-coded dates in OpenConnector's test files that are about to pass (or just have). A fixture such as
// `expiresAt: "2026-12-28"` is fine until the day it counts as expired, then it breaks every merge. Usage:
// node scripts/check-vendor-dates.ts. Add `// date-guard: ok` to a line whose date is intentionally fixed and harmless.

import { readdirSync, readFileSync } from "node:fs";
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

// An ISO date or date-time directly inside quotes or backticks, e.g. "2026-12-28" or `2026-12-28T10:00:00.000Z`.
const isoPattern = /(?<=["'`])(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}[^"'`]*)?(?=["'`])/g;
// new Date(2027, 0, 5 ...) and Date.UTC(2027, 0, 5 ...): the month is 0-based.
const numericPattern = /\b(?:new Date|Date\.UTC)\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\b[^)]*\)/g;

function dayNumber(year: number, month0: number, day: number): number {
  return Math.floor(Date.UTC(year, month0, day) / DAY_MS);
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
      const candidates: { literal: string; day: number }[] = [];
      for (const m of lineText.matchAll(isoPattern)) {
        candidates.push({ literal: m[0], day: dayNumber(Number(m[1]), Number(m[2]) - 1, Number(m[3])) });
      }
      for (const m of lineText.matchAll(numericPattern)) {
        candidates.push({ literal: m[0], day: dayNumber(Number(m[1]), Number(m[2]), Number(m[3])) });
      }
      for (const candidate of candidates) {
        if (candidate.day >= first && candidate.day <= last) {
          findings.push({ path: file.path, line: index + 1, literal: candidate.literal });
        }
      }
    });
  }

  return findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
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
  const files = readTestFiles(".", "vendor/open-connector/src");
  const findings = findExpiringDates(files, new Date());
  for (const finding of findings) console.log(`${finding.path}:${finding.line} ${finding.literal}`);
  if (findings.length === 0) {
    console.log(`check-vendor-dates: ${files.length} test files, no dates near expiry.`);
  } else {
    console.log(`check-vendor-dates: ${findings.length} date(s) near expiry; make them relative to Date.now() or add "// ${OPT_OUT}".`);
  }
  process.exitCode = findings.length === 0 ? 0 : 1;
}
