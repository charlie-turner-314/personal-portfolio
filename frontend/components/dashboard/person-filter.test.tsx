import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PersonFilter } from "./person-filter";
vi.mock("@/components/household/person-avatar", () => ({ PersonAvatar: () => null }));
afterEach(() => vi.unstubAllGlobals());
it("offers an explicit whole-account scope even for a single-person list", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => ({ people: [{ id: "self", name: "Jessica" }] }) }));
  const onChange = vi.fn();
  render(<PersonFilter value={[]} onChange={onChange} single personalDefault />);
  await screen.findByRole("button", { name: "Jessica" });
  expect(screen.getByRole("button", { name: "My share" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Whole accounts" }));
  expect(onChange).toHaveBeenLastCalledWith(["all"]);
  fireEvent.click(screen.getByRole("button", { name: "My share" }));
  expect(onChange).toHaveBeenLastCalledWith([]);
});
