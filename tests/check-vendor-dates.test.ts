import { describe, expect, it } from "vitest";
import { findExpiringDates } from "../scripts/check-vendor-dates.ts";

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
