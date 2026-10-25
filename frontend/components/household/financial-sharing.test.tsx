import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FinancialSharing } from "./financial-sharing";
const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
const initial = { members: [{ id: "partner", name: "Jess" }], accounts: [{ id: "account", name: "Savings", sharedWith: [] }], netWorthSharedWith: [] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("financial sharing consent controls", () => {
  beforeEach(() => vi.clearAllMocks());
  it("shows pending selection immediately, retaining confirmed privacy and rolling back a denied change", async () => {
    let finish!: (result: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(initial)).mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render(<FinancialSharing />);
    const checkbox = await screen.findByRole("checkbox", { name: "Share Savings with Jess" });
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Saving sharing settings");
    expect(screen.getByText("Private · only you")).toBeInTheDocument();
    await act(async () => finish(response({ error: "Sharing denied" }, 403)));
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("Sharing denied");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("confirms account sharing only after the server confirms it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response({ ...initial, accounts: [{ ...initial.accounts[0], sharedWith: ["partner"] }] })));
    render(<FinancialSharing />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Share Savings with Jess" }));
    await waitFor(() => expect(screen.getByText("Shared · selected members can view and edit")).toBeInTheDocument());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({ resource: "account", accountId: "account", memberUserIds: ["partner"] });
    expect(screen.getByRole("checkbox", { name: "Share your net worth total with Jess" })).not.toBeChecked();
  });
  it("sharing net worth does not select or grant account sharing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(initial)).mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response({ ...initial, netWorthSharedWith: ["partner"] })));
    render(<FinancialSharing />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Share your net worth total with Jess" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({ resource: "net-worth", memberUserIds: ["partner"] });
    expect(screen.getByRole("checkbox", { name: "Share Savings with Jess" })).not.toBeChecked();
  });
  it("hides stale privacy claims when a save and its confirmation both lose connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(initial)).mockRejectedValue(new Error("Connection lost")));
    render(<FinancialSharing />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Share Savings with Jess" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not confirm sharing settings"));
    expect(screen.queryByText("Private · only you")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Share Savings with Jess" })).not.toBeInTheDocument();
  });

});

it("shares property explicitly while leaving linked mortgage account consent independent", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ ...initial, properties: [{ id: "home", name: "Home", sharedWith: [] }] }))
    .mockResolvedValueOnce(response({ success: true }))
    .mockResolvedValueOnce(response({ ...initial, properties: [{ id: "home", name: "Home", sharedWith: ["partner"] }] })));
  render(<FinancialSharing />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Share property Home with Jess" }));
  await waitFor(() => expect(screen.getByText("Shared · selected members can view and edit property details and valuations")).toBeInTheDocument());
  expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)).toEqual({ resource: "property", propertyId: "home", memberUserIds: ["partner"] });
  expect(screen.getByRole("checkbox", { name: "Share Savings with Jess" })).not.toBeChecked();
});
