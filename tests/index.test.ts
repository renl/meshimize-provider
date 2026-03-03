import { describe, it, expect } from "vitest";

describe("meshimize-provider scaffold", () => {
  it("should have a passing test", () => {
    expect(true).toBe(true);
  });

  it("should use ESM modules", async () => {
    const types = await import("../src/types.js");
    expect(types).toBeDefined();
  });
});
