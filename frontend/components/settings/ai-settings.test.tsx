import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiSettings } from "./ai-settings";
const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), test: vi.fn(), remove: vi.fn(), categorize: vi.fn(), models: vi.fn() }));
vi.mock("@/lib/actions/ai-settings", () => ({ getAiSettings: mocks.get, getOllamaModels: mocks.models, saveAiSettings: mocks.save, testAiConnection: mocks.test, removeAiKey: mocks.remove, categorizeUncategorized: mocks.categorize }));
const state = { provider: "openai", configured: false, automatic: true, encryption_available: true, model: "gpt-4o-mini", uncategorized_count: 4, job: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.models.mockResolvedValue({ success: true, data: { models: ["qwen3:8b"] } });
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
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("sk-synthetic", true, "openai", undefined));
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
  it("loads the existing job when another tab already started categorisation", async () => {
    mocks.get.mockResolvedValue({ success: true, data: { ...state, configured: true } });
    mocks.categorize.mockResolvedValue({ success: false, error: "Categorisation is already running." });
    const { unmount } = render(<AiSettings />);
    const start = await screen.findByRole("button", { name: "Categorise uncategorised transactions" });
    mocks.get.mockResolvedValue({ success: true, data: { ...state, configured: true, job: { id: "job", status: "running", total: 4, processed: 1, categorized: 1, skipped: 0, error: null } } });
    fireEvent.click(start);
    expect(await screen.findByText(/1 of 4 processed/)).toBeVisible();
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

it("selects and saves a local model without a cloud key", async () => {
  render(<AiSettings />);
  fireEvent.change(await screen.findByLabelText("AI provider"), { target: { value: "ollama" } });
  await screen.findByRole("option", { name: "qwen3:8b" });
  fireEvent.change(screen.getByLabelText("Ollama model"), { target: { value: "qwen3:8b" } });
  expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("", true, "ollama", "qwen3:8b"));
});
it("shows an offline Mac error and permits refreshing the model list", async () => {
  mocks.models.mockResolvedValue({ success: false, error: "Mac/Ollama unavailable. Retry later." });
  render(<AiSettings />);
  fireEvent.change(await screen.findByLabelText("AI provider"), { target: { value: "ollama" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Mac/Ollama unavailable");
  expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await waitFor(() => expect(mocks.models).toHaveBeenCalledTimes(2));
});
