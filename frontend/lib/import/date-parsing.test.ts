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

  it("parses an explicit date-fns format string", () => {
    expect(parseImportedDate("21 Aug 26", "CUSTOM", "dd MMM yy")?.toISOString())
      .toBe("2026-08-21T00:00:00.000Z");
    expect(parseImportedDate("10:56 01-08-26", "CUSTOM", "HH:mm dd-MM-yy")?.toISOString())
      .toBe("2026-08-01T00:00:00.000Z");
  });

  it("rejects a missing or invalid custom format", () => {
    expect(parseImportedDate("21 Aug 26", "CUSTOM")).toBeNull();
    expect(parseImportedDate("21 Aug 26", "CUSTOM", "yyyy-MM-dd")).toBeNull();
  });
});
