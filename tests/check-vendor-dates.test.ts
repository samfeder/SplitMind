import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findExpiringDates, vendorScanDirs } from "../scripts/check-vendor-dates.ts";

// Pure scanner tests: every input is injected, nothing here reads the vendor tree (the root `test` CI job does not
// bootstrap it). Window under test is [now - 1 day, now + 400 days]. Expected dates below are literals, worked out by
// hand: with now = 2026-11-15, yesterday is 2026-11-14 and now + 400 days is 2027-12-20 (365 days to 2027-11-15, then
// 35 more).

const now = new Date("2026-11-15T00:00:00Z");

function scan(text: string, path = "src/a.test.ts", at: Date = now) {
  return findExpiringDates([{ path, text }], at);
}

describe("findExpiringDates: ISO string literals", () => {
  it("flags a date-time string inside the window, with the 1-based line number", () => {
    const text = ['import { it } from "vitest";', "", "it('x', () => {", '  const expiresAt = "2026-12-28T00:00:00Z";', "});"].join("\n");
    expect(scan(text)).toEqual([{ path: "src/a.test.ts", line: 4, literal: "2026-12-28T00:00:00Z" }]);
  });

  it("flags a plain YYYY-MM-DD string", () => {
    expect(scan('const d = "2027-03-01";')).toEqual([{ path: "src/a.test.ts", line: 1, literal: "2027-03-01" }]);
  });

  it("flags dates in single-quoted and template literals", () => {
    const text = ["const a = '2026-12-01';", "const b = `2026-12-02T10:00:00.000Z`;"].join("\n");
    expect(scan(text)).toEqual([
      { path: "src/a.test.ts", line: 1, literal: "2026-12-01" },
      { path: "src/a.test.ts", line: 2, literal: "2026-12-02T10:00:00.000Z" },
    ]);
  });

  it("flags a date-time with an offset", () => {
    expect(scan('const a = "2026-12-28T09:30:00+02:00";')).toEqual([
      { path: "src/a.test.ts", line: 1, literal: "2026-12-28T09:30:00+02:00" },
    ]);
  });

  it("ignores past history and far-future sentinels", () => {
    expect(scan('const a = "2099-01-01";')).toEqual([]);
    expect(scan('const a = "2020-05-01";')).toEqual([]);
    expect(scan('const a = "2099-01-01T00:00:00Z";')).toEqual([]);
  });

  it("does not treat arithmetic that looks like a date as a literal", () => {
    expect(scan("const n = 2026-12-28;")).toEqual([]);
  });

  it("counts line numbers correctly in CRLF files", () => {
    expect(scan('a\r\nb\r\nconst d = "2026-12-28";\r\n')).toEqual([
      { path: "src/a.test.ts", line: 3, literal: "2026-12-28" },
    ]);
  });

  it("returns every literal when one line holds two", () => {
    const found = scan('const r = ["2026-12-01", "2026-12-02"];');
    expect(found.map((f) => f.literal)).toEqual(["2026-12-01", "2026-12-02"]);
    expect(found.every((f) => f.line === 1)).toBe(true);
  });
});

describe("findExpiringDates: numeric Date forms (month is 0-based)", () => {
  it("flags new Date(2027, 0, 5) (Jan 5 2027)", () => {
    const found = scan("const d = new Date(2027, 0, 5);");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "src/a.test.ts", line: 1 });
    expect(found[0].literal).toContain("2027, 0, 5");
  });

  it("flags Date.UTC(2026, 11, 30) (Dec 30 2026)", () => {
    const found = scan("const t = Date.UTC(2026, 11, 30);");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "src/a.test.ts", line: 1 });
    expect(found[0].literal).toContain("2026, 11, 30");
  });

  it("flags calls with time arguments and tolerates no spaces", () => {
    expect(scan("new Date(2027,0,5,12,30,0)")).toHaveLength(1);
    expect(scan("Date.UTC(2027,0,5,12,30,0,500)")).toHaveLength(1);
  });

  it("ignores new Date(2030, 0, 1), outside the window", () => {
    expect(scan("const d = new Date(2030, 0, 1);")).toEqual([]);
  });

  it("reads the month as 0-based at both window edges", () => {
    // 2026-11-14 is (2026, 10, 14): yesterday, in. (2026, 10, 13) is two days ago, out.
    expect(scan("new Date(2026, 10, 14)")).toHaveLength(1);
    expect(scan("new Date(2026, 10, 13)")).toEqual([]);
    // 2027-12-20 is (2027, 11, 20): now + 400, in. (2027, 11, 21) is now + 401, out. A 1-based reader would get both wrong.
    expect(scan("Date.UTC(2027, 11, 20)")).toHaveLength(1);
    expect(scan("Date.UTC(2027, 11, 21)")).toEqual([]);
  });

  it("does not flag numeric Date forms that are not full dates, such as new Date(0) or new Date(ms)", () => {
    expect(scan("new Date(0); new Date(1700000000000); new Date(Date.now() + 1000);")).toEqual([]);
  });

  it("does not read a non-literal day as day 1: new Date(2026, 11, d) and Date.UTC(2026, 11, day) give no finding", () => {
    expect(scan("const a = new Date(2026, 11, d);")).toEqual([]);
    expect(scan("const b = Date.UTC(2026, 11, day);")).toEqual([]);
    expect(scan("new Date(2026, 11, day + 1)")).toEqual([]);
    expect(scan("new Date(2026, 11, offset(3))")).toEqual([]);
    expect(scan("new Date(2026,11,d,12,0,0)")).toEqual([]);
  });

  it("still flags a literal-day call that follows a non-literal-day call on the same line", () => {
    const found = scan("const a = new Date(2026, 11, d), b = new Date(2026, 11, 30);");
    expect(found).toHaveLength(1);
    expect(found[0].literal).toContain("2026, 11, 30");
  });

  // #124: the two-argument form may end in a trailing comma and in /* ... */ block comments before the closing paren.
  // Both are still day 1 of the month; a third argument that is not a literal is still not read as day 1.
  describe("two-argument forms with a trailing comma or a block comment (#124)", () => {
    it.each([
      "new Date(2026, 11,)",
      "Date.UTC(2026, 11 ,)",
      "new Date(2026, 11 /* Dec */)",
      "new Date(2026, 11, )",
      "new Date(2026,11,)",
      "new Date(2026, 11, /* day 1 */)",
      "new Date(2026, 11 /* Dec */,)",
      "new Date(2026, 11 /* a */ /* b */)",
      "Date.UTC(2027, 0 /* Jan */,)",
    ])("flags %s as day 1 of the month, naming the whole call", (call) => {
      expect(scan(`const d = ${call};`)).toEqual([{ path: "src/a.test.ts", line: 1, literal: call }]);
    });

    it("flags the call on its own line of a multi-line file, with that line number", () => {
      const text = ["const a = 1;", "const b = [", "  new Date(2026, 11,),", "];"].join("\n");
      expect(scan(text)).toEqual([{ path: "src/a.test.ts", line: 3, literal: "new Date(2026, 11,)" }]);
    });

    it("flags a trailing-comma call that follows a non-literal-day call on the same line", () => {
      const found = scan("const a = new Date(2026, 11, d), b = new Date(2026, 11,);");
      expect(found).toHaveLength(1);
      expect(found[0].literal).toBe("new Date(2026, 11,)");
    });

    it("keeps the window: a trailing comma or a comment does not flag a month outside it", () => {
      expect(scan("new Date(2026, 10,)")).toEqual([]); // 2026-11-01, before yesterday
      expect(scan("new Date(2026, 10 /* Nov */)")).toEqual([]);
      expect(scan("new Date(2028, 0,)")).toEqual([]); // 2028-01-01, after now + 400 days
      expect(scan("new Date(2028, 0 /* Jan */)")).toEqual([]);
      expect(scan("new Date(2027, 11,)")).toHaveLength(1); // 2027-12-01, inside
    });

    it("does not read a non-literal day as day 1, with or without a comment or a trailing comma", () => {
      expect(scan("new Date(2026, 11, d)")).toEqual([]);
      expect(scan("new Date(2026, 11, /* day */ d)")).toEqual([]);
      expect(scan("new Date(2026, 11, d,)")).toEqual([]);
      expect(scan("new Date(2026, 11, d /* day */)")).toEqual([]);
      expect(scan("Date.UTC(2026, 11, /* day */ day + 1)")).toEqual([]);
      expect(scan("new Date(2026, 11 /* Dec */, d)")).toEqual([]);
    });

    it("does not read anything that is not a block comment as one: an unclosed comment, a line comment, other text", () => {
      expect(scan("new Date(2026, 11 /* Dec )")).toEqual([]);
      expect(scan("new Date(2026, 11 // Dec\n)")).toEqual([]);
      expect(scan("new Date(2026, 11 d)")).toEqual([]);
      expect(scan("new Date(2026, 11,,)")).toEqual([]);
      expect(scan("new Date(2026, 11 /* a */ d)")).toEqual([]);
    });

    it("a literal day with a trailing comma is still flagged by its own day (three arguments, unchanged)", () => {
      expect(scan("new Date(2026, 11, 5,)")).toHaveLength(1);
      expect(scan("new Date(2026, 10, 5,)")).toEqual([]); // 2026-11-05
    });

    it("an opt-out on the line still skips it", () => {
      expect(scan("new Date(2026, 11,) // date-guard: ok")).toEqual([]);
    });

    // Review follow-up: the pattern must not backtrack badly, and a comment must not swallow code after it.
    describe("no catastrophic backtracking, and comments stay comments", () => {
      const LIMIT_MS = 200;
      const scanner = pathToFileURL(resolve("scripts/check-vendor-dates.ts")).href;
      // A pattern that backtracks badly blocks the thread and a vitest timeout cannot interrupt it, so each timing
      // runs in a child process with a hard kill. The child measures only findExpiringDates, with performance.now().
      const childSource = [
        'import { readFileSync } from "node:fs";',
        "const { findExpiringDates } = await import(process.argv[1]);",
        'const text = readFileSync(0, "utf8");',
        "const start = performance.now();",
        'const found = findExpiringDates([{ path: "src/a.test.ts", text }], new Date("2026-11-15T00:00:00Z"));',
        "console.log(JSON.stringify({ ms: performance.now() - start, count: found.length }));",
      ].join("\n");
      function timed(text: string): { count: number; ms: number } {
        const run = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, scanner], { input: text, encoding: "utf8", timeout: 10_000 });
        if (run.error || run.status !== 0) {
          throw new Error(`the scan did not finish within 10 s (${run.error?.message ?? `status ${run.status}`}): ${run.stderr.slice(0, 200)}`);
        }
        return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as { count: number; ms: number };
      }
      const comments = (count: number) => " /* c */".repeat(count);

      it("30 block comments before the closing paren: still flagged, within 200 ms", () => {
        const { count, ms } = timed(`const d = new Date(2026, 11${comments(30)});`);
        expect(count).toBe(1);
        expect(ms).toBeLessThan(LIMIT_MS);
      });

      it("30 block comments and then something that is not a closing paren: no finding, within 200 ms", () => {
        for (const tail of [" d);", ";", " /* never closed )"]) {
          const { count, ms } = timed(`const d = new Date(2026, 11${comments(30)}${tail}`);
          expect(count, tail).toBe(0);
          expect(ms, tail).toBeLessThan(LIMIT_MS);
        }
      });

      it("30 block comments after a trailing comma, closed and not closed, within 200 ms", () => {
        const closed = timed(`new Date(2026, 11,${comments(30)})`);
        expect(closed.count).toBe(1);
        expect(closed.ms).toBeLessThan(LIMIT_MS);
        const open = timed(`new Date(2026, 11,${comments(30)} d)`);
        expect(open.count).toBe(0);
        expect(open.ms).toBeLessThan(LIMIT_MS);
      });

      it("40,000 spaces between the month and the closing paren: still flagged, within 200 ms", () => {
        const { count, ms } = timed(`new Date(2026, 11${" ".repeat(40_000)})`);
        expect(count).toBe(1);
        expect(ms).toBeLessThan(LIMIT_MS);
      });

      it("40,000 spaces and then something that is not a closing paren: no finding, within 200 ms", () => {
        for (const tail of ["d)", ";", ""]) {
          const { count, ms } = timed(`new Date(2026, 11${" ".repeat(40_000)}${tail}`);
          expect(count, JSON.stringify(tail)).toBe(0);
          expect(ms, JSON.stringify(tail)).toBeLessThan(LIMIT_MS);
        }
      });

      it("a comment ends at its own */: code after it is not part of it (no false positive from a later comment's */)", () => {
        // Month 0 of 2026 is outside the window, so this form can only be a finding by accident; the same shape with
        // month 11 (inside the window) is the one that shows the false positive.
        expect(scan("new Date(2026, 0 /* Jan */, d); /* x */)")).toEqual([]);
        expect(scan("new Date(2026, 11 /* Dec */, d); /* x */)")).toEqual([]);
        expect(scan("new Date(2026, 11 /* Dec */ d); /* x */)")).toEqual([]);
        expect(scan("new Date(2026, 11, /* day */ d); /* x */)")).toEqual([]);
      });

      it("a real comment-closed call is still flagged, and so is a trailing comma", () => {
        expect(scan("new Date(2026, 11 /* Dec */)")).toHaveLength(1);
        expect(scan("new Date(2026, 11,)")).toHaveLength(1);
      });

      it("a call followed by a comment on the same line is flagged once, naming only the call", () => {
        const found = scan("const a = new Date(2026, 11 /* Dec */); /* later */");
        expect(found).toHaveLength(1);
        expect(found[0].literal).toBe("new Date(2026, 11 /* Dec */)");
      });
    });
  });
});

describe("findExpiringDates: window boundaries", () => {
  it("flags yesterday's date (lower edge) but not the day before", () => {
    expect(scan('const a = "2026-11-14";')).toHaveLength(1);
    expect(scan('const a = "2026-11-13";')).toEqual([]);
  });

  it("flags today's date", () => {
    expect(scan('const a = "2026-11-15";')).toHaveLength(1);
  });

  it("flags now + 400 days (upper edge) but not now + 401 days", () => {
    expect(scan('const a = "2027-12-20";')).toHaveLength(1);
    expect(scan('const a = "2027-12-21";')).toEqual([]);
  });

  it("measures the window from the injected now, not the real clock", () => {
    const later = new Date("2030-06-01T00:00:00Z");
    // With now = 2030-06-01 the window is 2030-05-31 .. 2031-07-06.
    expect(scan('const a = "2026-12-28";', "src/a.test.ts", later)).toEqual([]);
    expect(scan('const a = "2030-05-31";', "src/a.test.ts", later)).toHaveLength(1);
    expect(scan('const a = "2031-07-06";', "src/a.test.ts", later)).toHaveLength(1);
    expect(scan('const a = "2031-07-07";', "src/a.test.ts", later)).toEqual([]);
  });
});

describe("findExpiringDates: opt-out comment", () => {
  it("skips a flagged literal with // date-guard: ok on the same line", () => {
    expect(scan('const a = "2026-12-28"; // date-guard: ok')).toEqual([]);
    expect(scan("const d = new Date(2027, 0, 5); // date-guard: ok")).toEqual([]);
  });

  it("only skips the line it is on", () => {
    const text = ['const a = "2026-12-28"; // date-guard: ok', 'const b = "2026-12-29";'].join("\n");
    expect(scan(text)).toEqual([{ path: "src/a.test.ts", line: 2, literal: "2026-12-29" }]);
  });

  it("does not let a comment on the next or previous line opt out", () => {
    expect(scan('const a = "2026-12-28";\n// date-guard: ok')).toHaveLength(1);
    expect(scan('// date-guard: ok\nconst a = "2026-12-28";')).toHaveLength(1);
  });

  it("skips every literal on an opted-out line", () => {
    expect(scan('const r = ["2026-12-01", "2026-12-02"]; // date-guard: ok')).toEqual([]);
  });
});

describe("findExpiringDates: which files are scanned", () => {
  const text = 'const a = "2026-12-28";';

  it("scans *.test.ts and *.spec.ts at any depth", () => {
    const found = findExpiringDates(
      [
        { path: "vendor/open-connector/src/oauth/x.test.ts", text },
        { path: "vendor/open-connector/src/y.spec.ts", text },
      ],
      now,
    );
    expect(found.map((f) => f.path)).toEqual(["vendor/open-connector/src/oauth/x.test.ts", "vendor/open-connector/src/y.spec.ts"]);
  });

  it("ignores non-test paths", () => {
    const found = findExpiringDates(
      [
        { path: "src/a.ts", text },
        { path: "src/helpers.ts", text },
        { path: "src/test-utils.ts", text },
        { path: "README.md", text },
        { path: "src/a.test.ts.snap", text },
        { path: "src/a.test.js", text },
        { path: "src/fixtures/token.json", text },
      ],
      now,
    );
    expect(found).toEqual([]);
  });

  it("returns nothing for an empty list or empty files", () => {
    expect(findExpiringDates([], now)).toEqual([]);
    expect(findExpiringDates([{ path: "src/a.test.ts", text: "" }], now)).toEqual([]);
  });
});

describe("findExpiringDates: ordering and aggregation", () => {
  it("returns findings from several files in path order, then line order", () => {
    const files = [
      { path: "src/b/z.test.ts", text: 'x\nconst a = "2026-12-01";' },
      { path: "src/a/m.test.ts", text: 'const a = "2026-12-03";\ny\nconst b = new Date(2027, 0, 5);' },
      { path: "src/a/c.spec.ts", text: 'const a = "2026-12-02";' },
    ];
    const found = findExpiringDates(files, now);
    expect(found.map((f) => [f.path, f.line])).toEqual([
      ["src/a/c.spec.ts", 1],
      ["src/a/m.test.ts", 1],
      ["src/a/m.test.ts", 3],
      ["src/b/z.test.ts", 2],
    ]);
  });

  it("does not mutate the input", () => {
    const files = [
      { path: "b.test.ts", text: 'const a = "2026-12-01";' },
      { path: "a.test.ts", text: 'const a = "2026-12-02";' },
    ];
    const copy = structuredClone(files);
    findExpiringDates(files, now);
    expect(files).toEqual(copy);
  });

  it("is repeatable: the same input gives the same output twice (no regex lastIndex carry-over)", () => {
    const files = [{ path: "a.test.ts", text: 'const a = "2026-12-01";\nconst b = new Date(2027, 0, 5);' }];
    expect(findExpiringDates(files, now)).toEqual(findExpiringDates(files, now));
    expect(findExpiringDates(files, now)).toHaveLength(2);
  });
});

describe("module import", () => {
  it("has no side effects: importing it does not scan the vendor tree or set an exit code", async () => {
    const before = process.exitCode;
    const mod = await import("../scripts/check-vendor-dates.ts");
    expect(typeof mod.findExpiringDates).toBe("function");
    expect(process.exitCode).toBe(before);
  });
});

// --- #116: more date forms --------------------------------------------------------------------------------------------
// Window is still [2026-11-14, 2027-12-20] for now = 2026-11-15.

describe("findExpiringDates: space-separated time inside quotes", () => {
  it("flags a date followed by a space and a time", () => {
    const found = scan('const a = "2026-12-28 10:00:00";');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "src/a.test.ts", line: 1 });
    expect(found[0].literal).toContain("2026-12-28");
  });

  it("flags it in single quotes and template literals, with fractional seconds", () => {
    expect(scan("const a = '2026-12-28 10:00:00';")).toHaveLength(1);
    expect(scan("const a = `2026-12-28 10:00:00.250`;")).toHaveLength(1);
  });

  it("applies the window edges to the date part", () => {
    expect(scan('const a = "2026-11-14 00:00:00";')).toHaveLength(1);
    expect(scan('const a = "2026-11-13 23:59:59";')).toEqual([]);
    expect(scan('const a = "2027-12-20 23:59:59";')).toHaveLength(1);
    expect(scan('const a = "2027-12-21 00:00:00";')).toEqual([]);
    expect(scan('const a = "2030-01-01 10:00:00";')).toEqual([]);
  });

  it("is skipped by the opt-out comment", () => {
    expect(scan('const a = "2026-12-28 10:00:00"; // date-guard: ok')).toEqual([]);
  });
});

describe("findExpiringDates: a date right after a template interpolation", () => {
  it("flags `${x}2026-12-28`", () => {
    const found = scan("const a = `${x}2026-12-28`;");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "src/a.test.ts", line: 1 });
    expect(found[0].literal).toContain("2026-12-28");
  });

  it("applies the window edges", () => {
    expect(scan("const a = `${x}2026-11-14`;")).toHaveLength(1);
    expect(scan("const a = `${x}2026-11-13`;")).toEqual([]);
    expect(scan("const a = `${x}2027-12-20`;")).toHaveLength(1);
    expect(scan("const a = `${x}2027-12-21`;")).toEqual([]);
  });

  it("is skipped by the opt-out comment", () => {
    expect(scan("const a = `${x}2026-12-28`; // date-guard: ok")).toEqual([]);
  });
});

describe("findExpiringDates: slash dates inside quotes (month is 1-based)", () => {
  it("flags \"2026/12/29\"", () => {
    const found = scan('const a = "2026/12/29";');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ path: "src/a.test.ts", line: 1 });
    expect(found[0].literal).toContain("2026/12/29");
  });

  it("accepts unpadded month and day: \"2027/1/5\" is January 5 2027", () => {
    const found = scan("const a = '2027/1/5';");
    expect(found).toHaveLength(1);
    expect(found[0].literal).toContain("2027/1/5");
  });

  it("reads the month as 1-based at the window edges", () => {
    expect(scan('const a = "2026/11/14";')).toHaveLength(1);
    expect(scan('const a = "2026/11/13";')).toEqual([]);
    expect(scan('const a = "2027/12/20";')).toHaveLength(1);
    expect(scan('const a = "2027/12/21";')).toEqual([]);
    // "2026/1/5" is January 2026, long past. A 0-based reader would call it February and still miss; "2026/12/1" under a
    // 0-based reader would be January 2027 and also be inside the window, so pin a case that only 1-based gets right:
    expect(scan('const a = "2026/1/5";')).toEqual([]);
    expect(scan('const a = "2028/1/5";')).toEqual([]);
  });

  it("ignores far-future and past slash dates", () => {
    expect(scan('const a = "2099/01/01";')).toEqual([]);
    expect(scan('const a = "2020/05/01";')).toEqual([]);
  });

  it("does not treat unquoted division as a date", () => {
    expect(scan("const n = 2026/12/29;")).toEqual([]);
  });

  it("is skipped by the opt-out comment", () => {
    expect(scan('const a = "2026/12/29"; // date-guard: ok')).toEqual([]);
  });
});

describe("findExpiringDates: two-argument new Date(year, month) and Date.UTC(year, month) (day 1)", () => {
  it("flags new Date(2026, 11) (Dec 1 2026) and Date.UTC(2026, 11)", () => {
    const a = scan("const d = new Date(2026, 11);");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ path: "src/a.test.ts", line: 1 });
    expect(a[0].literal).toContain("2026, 11");
    const b = scan("const t = Date.UTC(2026, 11);");
    expect(b).toHaveLength(1);
    expect(b[0].literal).toContain("2026, 11");
  });

  it("tolerates no spaces", () => {
    expect(scan("new Date(2026,11)")).toHaveLength(1);
    expect(scan("Date.UTC(2027,0)")).toHaveLength(1);
  });

  it("reads the month as 0-based with day 1 at the window edges", () => {
    // (2026, 10) is Nov 1 2026: before the window start of Nov 14.
    expect(scan("new Date(2026, 10)")).toEqual([]);
    // (2027, 0) is Jan 1 2027: in. (2027, 11) is Dec 1 2027: in. (2028, 0) is Jan 1 2028: after Dec 20 2027, out.
    expect(scan("new Date(2027, 0)")).toHaveLength(1);
    expect(scan("new Date(2027, 11)")).toHaveLength(1);
    expect(scan("new Date(2028, 0)")).toEqual([]);
  });

  it("flags a three-argument call once, not once per matching form", () => {
    expect(scan("new Date(2026, 11, 30)")).toHaveLength(1);
    expect(scan("Date.UTC(2026, 11, 30, 12, 0, 0)")).toHaveLength(1);
  });

  it("ignores calls whose month is not a literal", () => {
    expect(scan("new Date(2026, month)")).toEqual([]);
    expect(scan("new Date(year, 11)")).toEqual([]);
  });

  it("is skipped by the opt-out comment", () => {
    expect(scan("new Date(2026, 11); // date-guard: ok")).toEqual([]);
  });
});

describe("findExpiringDates: impossible dates are not flagged", () => {
  it("ignores impossible ISO dates, including ones that would roll into the window", () => {
    expect(scan('const a = "2026-13-45";')).toEqual([]);
    expect(scan('const a = "2026-02-30";')).toEqual([]);
    expect(scan('const a = "2026-11-31";')).toEqual([]); // would roll to Dec 1 2026
    expect(scan('const a = "2026-12-32";')).toEqual([]); // would roll to Jan 1 2027
    expect(scan('const a = "2026-13-01";')).toEqual([]); // would roll to Jan 1 2027
    expect(scan('const a = "2026-12-00";')).toEqual([]); // would roll to Nov 30 2026
    expect(scan('const a = "2026-00-10";')).toEqual([]);
  });

  it("ignores impossible dates in the new string forms", () => {
    expect(scan('const a = "2026-11-31 10:00:00";')).toEqual([]);
    expect(scan("const a = `${x}2026-12-32`;")).toEqual([]);
    expect(scan('const a = "2026/11/31";')).toEqual([]);
    expect(scan('const a = "2026/13/1";')).toEqual([]);
    expect(scan('const a = "2026/12/0";')).toEqual([]);
  });

  it("ignores impossible numeric Date calls", () => {
    expect(scan("new Date(2026, 12, 40)")).toEqual([]);
    expect(scan("new Date(2026, 12, 1)")).toEqual([]); // month 12 would roll to Jan 1 2027
    expect(scan("new Date(2026, 11, 32)")).toEqual([]); // would roll to Jan 1 2027
    expect(scan("new Date(2026, 11, 0)")).toEqual([]); // would roll to Nov 30 2026
    expect(scan("new Date(2026, 12)")).toEqual([]);
    expect(scan("Date.UTC(2026, 13)")).toEqual([]);
  });

  it("ignores impossible dates that roll into the window when now is later (leap-year rules)", () => {
    // With now = 2027-12-01 the window runs to 2029-01-05. 2028 is a leap year.
    const at = new Date("2027-12-01T00:00:00Z");
    expect(scan('const a = "2028-02-30";', "src/a.test.ts", at)).toEqual([]); // would roll to Mar 1 2028
    expect(scan('const a = "2028-04-31";', "src/a.test.ts", at)).toEqual([]); // would roll to May 1 2028
    expect(scan('const a = "2028-02-29";', "src/a.test.ts", at)).toHaveLength(1); // a real leap day
  });

  it("still flags the last real day of a month", () => {
    expect(scan('const a = "2026-11-30";')).toHaveLength(1);
    expect(scan("new Date(2026, 11, 31)")).toHaveLength(1);
  });
});

describe("findExpiringDates: several forms on one line", () => {
  it("reports each date, and one opt-out skips all of them", () => {
    const line = 'const r = ["2026-12-01 10:00:00", "2026/12/02", new Date(2026, 11)];';
    expect(scan(line)).toHaveLength(3);
    expect(scan(`${line} // date-guard: ok`)).toEqual([]);
  });
});

describe("vendorScanDirs: which directories the CLI scans", () => {
  function makeRepo(...dirs: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "splitmind-datedirs-"));
    for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
    return root;
  }

  it("lists src, web/src and scripts under the engine, in that order, when all exist", () => {
    const root = makeRepo("vendor/open-connector/src", "vendor/open-connector/web/src", "vendor/open-connector/scripts");
    try {
      expect(vendorScanDirs(root)).toEqual([
        "vendor/open-connector/src",
        "vendor/open-connector/web/src",
        "vendor/open-connector/scripts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves out directories that do not exist", () => {
    const root = makeRepo("vendor/open-connector/web/src");
    try {
      expect(vendorScanDirs(root)).toEqual(["vendor/open-connector/web/src"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an empty list when there is no engine at all, and never lists other directories", () => {
    const root = makeRepo("vendor/open-connector/docs", "vendor/open-connector/node_modules", "src");
    try {
      expect(vendorScanDirs(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("check-vendor-dates CLI: scans every covered directory", () => {
  const cli = resolve(import.meta.dirname, "../scripts/check-vendor-dates.ts");
  // A date 30 days out, built a different way from the scanner: epoch arithmetic then ISO string.
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const fixture = `const a = "${soon}";\n`;

  function runCli(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "splitmind-datecli-"));
    try {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(join(root, path, ".."), { recursive: true });
        writeFileSync(join(root, path), text);
      }
      return spawnSync(process.execPath, [cli], { cwd: root, encoding: "utf8" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("flags test and spec files under src, web/src and scripts, and nothing else", () => {
    const base = "vendor/open-connector";
    const run = runCli({
      [`${base}/src/a.test.ts`]: fixture,
      [`${base}/web/src/components/b.spec.ts`]: fixture,
      [`${base}/scripts/c.test.ts`]: fixture,
      [`${base}/web/src/node_modules/pkg/d.test.ts`]: fixture,
      [`${base}/docs/e.test.ts`]: fixture,
      [`${base}/web/src/f.ts`]: fixture,
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`${base}/src/a.test.ts:1`);
    expect(run.stdout).toContain(`${base}/web/src/components/b.spec.ts:1`);
    expect(run.stdout).toContain(`${base}/scripts/c.test.ts:1`);
    expect(run.stdout).not.toContain("d.test.ts");
    expect(run.stdout).not.toContain("e.test.ts");
    expect(run.stdout).not.toContain("f.ts");
    expect(run.stdout).toContain("3 date(s) near expiry");
  });

  it("works when only some of the directories exist, and exits 0 when nothing is near expiry", () => {
    const run = runCli({ "vendor/open-connector/scripts/c.test.ts": 'const a = "2020-01-01";\n' });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("no dates near expiry");
  });
});
