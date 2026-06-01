import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/page.js", import.meta.url),
  "utf8"
);

describe("dashboard media provider demos", () => {
  it("send API keys through x-api-key for same-origin demo calls", () => {
    expect(source).toContain("function buildSameOriginApiHeaders");
    expect(source).toContain('headers["x-api-key"] = apiKey');
    expect(source).not.toContain('headers["Authorization"] = `Bearer ${apiKey}`');
  });
});
