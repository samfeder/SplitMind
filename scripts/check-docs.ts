// Checks the public docs for two things: no real identifiers (Worker hosts, emails, account ids, tokens), and no
// broken relative links or anchors. Usage: node scripts/check-docs.ts [repo-dir]

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface Finding {
  file: string;
  line: number;
  problem: string;
}

// Each rule names what it catches. Placeholders are written in angle brackets, e.g. `<your-worker>.workers.dev`.
const identifierRules: { problem: string; pattern: RegExp; allowed?: (match: string) => boolean }[] = [
  {
    problem: "workers.dev host without a <placeholder>",
    pattern: /[A-Za-z0-9<>._-]+\.workers\.dev/g,
    allowed: (match) => match.includes("<"),
  },
  {
    problem: "email address",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allowed: (match) => /@example\.(?:com|org)$/i.test(match),
  },
  { problem: "32-hex id (Cloudflare account, KV or similar)", pattern: /\b[0-9a-f]{32}\b/gi },
  {
    problem: "UUID (D1 database or similar)",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    allowed: (match) => /^[0-]+$/.test(match),
  },
  {
    problem: "Slack token",
    pattern: /\bxox[a-z]-[A-Za-z0-9-]{8,}/g,
    allowed: (match) => /-(?:REDACTED|EXAMPLE)$/.test(match),
  },
  { problem: "Notion token", pattern: /\b(?:ntn|secret)_[A-Za-z0-9]{20,}/g },
];

export function findIdentifiers(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split("\n").forEach((content, index) => {
    for (const rule of identifierRules) {
      for (const match of content.matchAll(rule.pattern)) {
        if (!rule.allowed?.(match[0])) findings.push({ file, line: index + 1, problem: rule.problem });
      }
    }
  });
  return findings;
}

// GitHub's heading anchors: lower case, punctuation dropped, each space becomes a hyphen, repeats get -1, -2, ….
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = !inFence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

export function findBrokenLinks(repo: string, file: string, markdown: string): Finding[] {
  const findings: Finding[] = [];
  let inFence = false;
  markdown.split("\n").forEach((content, index) => {
    if (/^\s*(```|~~~)/.test(content)) inFence = !inFence;
    if (inFence) return;
    for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target)) continue;
      const [path, anchor] = target.split("#", 2);
      const resolved = path === "" ? join(repo, file) : resolve(dirname(join(repo, file)), path);
      const report = (problem: string) => findings.push({ file, line: index + 1, problem });
      if (!existsSync(resolved)) {
        report(`link to missing file ${path}`);
      } else if (anchor && resolved.endsWith(".md") && !headingAnchors(readFileSync(resolved, "utf8")).has(anchor)) {
        report(`link to missing heading #${anchor} in ${relative(repo, resolved)}`);
      }
    }
  });
  return findings;
}

// The repo's own public text: top-level docs, docs/, patches/README.md, the wrangler template and the Slack manifest.
export function publicFiles(repo: string): string[] {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "patches/README.md", "wrangler.template.jsonc"];
  for (const dir of ["docs", "slack"]) {
    for (const entry of readdirSync(join(repo, dir), { recursive: true }) as string[]) {
      const path = join(dir, entry);
      if (statSync(join(repo, path)).isFile() && /\.(md|json|jsonc)$/.test(path)) files.push(path);
    }
  }
  return files.filter((file) => existsSync(join(repo, file))).sort();
}

export function checkDocs(repo: string): Finding[] {
  return publicFiles(repo).flatMap((file) => {
    const text = readFileSync(join(repo, file), "utf8");
    return [...findIdentifiers(file, text), ...(file.endsWith(".md") ? findBrokenLinks(repo, file, text) : [])];
  });
}

if (import.meta.main) {
  const repo = resolve(process.argv[2] ?? ".");
  const findings = checkDocs(repo);
  for (const finding of findings) console.log(`${finding.file}:${finding.line}: ${finding.problem}`);
  console.log(findings.length === 0 ? `check-docs: ${publicFiles(repo).length} files clean.` : `check-docs: ${findings.length} problem(s).`);
  process.exitCode = findings.length === 0 ? 0 : 1;
}
