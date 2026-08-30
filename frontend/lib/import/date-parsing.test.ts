import { describe, expect, it } from "vitest";
import { parseImportedDate } from "@/lib/import/date-parsing";

describe("parseImportedDate", () => {
  it("applies the selected format when time precedes an ambiguous numeric date", () => {
    expect(parseImportedDate("14:35 03-08-2026", "DD-MM-YYYY")?.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(parseImportedDate("14:35 03-08-2026", "MM-DD-YYYY")?.toISOString()).toBe("2026-03-08T00:00:00.000Z");
  });

  it("handles times on either side of supported numeric dates", () => {
    expect(parseImportedDate("03-08-2026 14:35", "DD-MM-YYYY")?.toISOString()).toBe("2026-08-03T00:00:00.000Z");
    expect(parseImportedDate("14:35 2026-08-03")?.toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });

  it("rejects impossible dates instead of letting Date normalize them", () => {
    expect(parseImportedDate("31-02-2026", "DD-MM-YYYY")).toBeNull();
  });
});
