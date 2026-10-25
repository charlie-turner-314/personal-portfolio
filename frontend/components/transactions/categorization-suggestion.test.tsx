import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CategorizationSuggestionPanel } from "./categorization-suggestion";
import { categorizationTrialAvailable, requestCategorizationSuggestion, reviewCategorizationSuggestion, getCategorizationTrialSummary } from "@/lib/actions/categorization-suggestions";

vi.mock("@/lib/actions/categorization-suggestions", () => ({
  categorizationTrialAvailable: vi.fn(), requestCategorizationSuggestion: vi.fn(), reviewCategorizationSuggestion: vi.fn(), getCategorizationTrialSummary: vi.fn(),
}));

const categories = [{ id: "food", name: "Food", color: null, icon: null }, { id: "transfer", name: "Transfer", color: null, icon: null }];
const suggestion = { id: "suggestion", transaction_id: "tx", category_id: "food", category_name: "Food", category_type: "expense",
  status: "needs_review" as const, review_outcome: null,
  evidence: [{ kind: "verified_precedent", transaction_id: "old", description: "Previous shop", accepted_category: "Food", amount: "-25", currency: "AUD", booked_at: "2026-10-20", account: { name: "Daily" } }],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(categorizationTrialAvailable).mockResolvedValue(true);
  vi.mocked(requestCategorizationSuggestion).mockResolvedValue(suggestion);
  vi.mocked(reviewCategorizationSuggestion).mockResolvedValue({ ...suggestion, status: "reviewed", review_outcome: "accepted" });
});

async function openSuggestion() {
  const saved = vi.fn();
  render(<CategorizationSuggestionPanel transactionId="tx" categories={categories} onCategorySaved={saved} />);
  fireEvent.click(await screen.findByRole("button", { name: "Suggest category" }));
  await screen.findByText("Needs review");
  return saved;
}

describe("categorisation trial", () => {
  it("stays hidden when disabled and never requests inference automatically", async () => {
    vi.mocked(categorizationTrialAvailable).mockResolvedValue(false);
    const { container } = render(<CategorizationSuggestionPanel transactionId="tx" categories={categories} onCategorySaved={vi.fn()} />);
    await waitFor(() => expect(categorizationTrialAvailable).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    expect(requestCategorizationSuggestion).not.toHaveBeenCalled();
  });

  it("shows evidence, then saves only after explicit acceptance", async () => {
    const saved = await openSuggestion();
    expect(saved).not.toHaveBeenCalled();
    expect(reviewCategorizationSuggestion).not.toHaveBeenCalled();
    expect(screen.getByText("Previous shop → Food")).toBeInTheDocument();
    expect(screen.queryByText(/95%/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(categories[0]));
    expect(reviewCategorizationSuggestion).toHaveBeenCalledWith("suggestion", "accepted", "food", expect.any(Number));
  });

  it("records corrections and dismissals separately", async () => {
    const saved = await openSuggestion();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "transfer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    await waitFor(() => expect(saved).toHaveBeenCalledWith(categories[1]));
    expect(reviewCategorizationSuggestion).toHaveBeenCalledWith("suggestion", "corrected", "transfer", expect.any(Number));
  });

  it("allows dismissing an abstention without assigning anything", async () => {
    vi.mocked(requestCategorizationSuggestion).mockResolvedValue({ ...suggestion, category_id: null, category_name: null });
    const saved = await openSuggestion();
    expect(screen.getByText("No clear category found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept suggestion" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await screen.findByText("Review recorded.");
    expect(saved).not.toHaveBeenCalled();
    expect(reviewCategorizationSuggestion).toHaveBeenCalledWith("suggestion", "dismissed", null, expect.any(Number));
  });

  it("keeps a failed or stale review unsaved and allows starting again", async () => {
    vi.mocked(reviewCategorizationSuggestion).mockRejectedValue(new Error("Transaction changed; request a fresh suggestion"));
    const saved = await openSuggestion();
    fireEvent.click(screen.getByRole("button", { name: "Accept suggestion" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Transaction changed");
    expect(saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start a fresh review" }));
    expect(screen.getByRole("button", { name: "Suggest category" })).toBeInTheDocument();
  });

  it("shows explicit outcome counts and labels elapsed time honestly", async () => {
    vi.mocked(getCategorizationTrialSummary).mockResolvedValue({ requested: 4, outcomes: { accepted: 2, corrected: 1, dismissed: 1 }, acceptance_among_category_reviews: 2/3, mean_review_duration_ms: 1200, duration_note: "includes idle time" });
    await openSuggestion();
    const details = screen.getByText("Your trial results").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(await screen.findByText("4 suggestions · 2 accepted · 1 corrected · 1 dismissed")).toBeInTheDocument();
    expect(screen.getByText(/1.2 seconds, including pauses/)).toBeInTheDocument();
  });
});
