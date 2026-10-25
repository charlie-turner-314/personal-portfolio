import { describe, expect, it } from "vitest";
import { invitationReturnPath } from "./return-path";
describe("invitation login navigation", () => {
  it("preserves only a valid invitation path", () => {
    const path = `/household/join?token=${"a".repeat(64)}`;
    expect(invitationReturnPath(path)).toBe(path);
    for (const value of [null, "//evil.example", "https://evil.example", "/admin", `${path}&next=//evil.example`]) expect(invitationReturnPath(value)).toBeNull();
  });
});
