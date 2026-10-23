import { expect, it } from "vitest";

// Deliberately failing: proves branch protection blocks a red PR. Never merge.
it("fails on purpose", () => {
  expect(1).toBe(2);
});
