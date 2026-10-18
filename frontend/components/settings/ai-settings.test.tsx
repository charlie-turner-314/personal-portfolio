import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSettings } from "./ai-settings";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn(), remove: vi.fn(), categorize: vi.fn() }));
vi.mock("@/lib/actions/ai-settings", () => ({ getAiSettings: mocks.get, saveAiSettings: mocks.save, testAiConnection: mocks.test, removeAiKey: mocks.remove, categorizeUncategorized: mocks.categorize }));
const state = { configured: false, automatic: true, encryption_available: true, model: "gpt-4o-mini", uncategorized_count: 4, job: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ success: true, data: state });
  for (const method of [mocks.save,mocks.test,mocks.remove,mocks.categorize]) method.mockResolvedValue({ success: true, data: {} });
});
describe("AI settings", () => {
  it("saves a password field, clears it, and never repopulates a saved key", async () => {
    render(<AiSettings />);
    const input = await screen.findByLabelText("OpenAI API key");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "sk-synthetic" } });
    mocks.get.mockResolvedValue({ success: true, data: { ...state, configured: true } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("sk-synthetic", true));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(await screen.findByText(/An API key is saved/)).toBeVisible();
  });
  it("shows provider errors and leaves the entered key available for correction", async () => {
    mocks.test.mockResolvedValue({ success: false, error: "OpenAI quota or rate limit reached." });
    render(<AiSettings />);
    fireEvent.change(await screen.findByLabelText("OpenAI API key"), { target: { value: "sk-synthetic" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("quota or rate limit");
  });
  it("displays persisted progress and prevents duplicate starts", async () => {
    mocks.get.mockResolvedValue({ success: true, data: { ...state, configured: true, job: { id: "job", status: "running", total: 50, processed: 25, categorized: 20, skipped: 1, error: null } } });
    const { unmount } = render(<AiSettings />);
    expect(await screen.findByText(/25 of 50 processed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Categorisation in progress…" })).toBeDisabled();
    unmount();
  });
  it("offers retry after a failed job while retaining completed counts", async () => {
    mocks.get.mockResolvedValue({ success: true, data: { ...state, configured: true, job: { id: "job", status: "failed", total: 50, processed: 25, categorized: 20, skipped: 0, error: "Check API billing and retry." } } });
    render(<AiSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Check API billing");
    fireEvent.click(screen.getByRole("button", { name: "Categorise uncategorised transactions" }));
    await waitFor(() => expect(mocks.categorize).toHaveBeenCalledOnce());
  });
});
