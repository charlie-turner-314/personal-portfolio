import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  createUpConnection: vi.fn(),
  disconnectBank: vi.fn(),
  disconnectUp: vi.fn(),
  triggerRecategorize: vi.fn(),
  triggerSync: vi.fn(),
  triggerUpSync: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));
vi.mock("@/lib/actions/bank-connections", () => ({
  createUpConnection: mocks.createUpConnection,
  disconnectBank: mocks.disconnectBank,
  disconnectUp: mocks.disconnectUp,
  triggerRecategorize: mocks.triggerRecategorize,
  triggerSync: mocks.triggerSync,
  triggerUpSync: mocks.triggerUpSync,
}));

import { BankConnectionsManager } from "./bank-connections-manager";

describe("BankConnectionsManager Up connection", () => {
  it("submits the token once and moves to account mapping", async () => {
    mocks.createUpConnection.mockResolvedValue({ success: true, connectionId: "up-connection-1" });
    render(<BankConnectionsManager connections={[]} countryCode="AU" />);

    fireEvent.change(screen.getByLabelText("Up personal access token"), {
      target: { value: "up:pat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Up" }));

    await waitFor(() => expect(mocks.createUpConnection).toHaveBeenCalledWith("up:pat"));
    expect(mocks.push).toHaveBeenCalledWith(
      "/settings/connect-bank/map-accounts?connectionId=up-connection-1"
    );
    expect(screen.getByLabelText("Up personal access token")).toHaveValue("");
  });

  it("shows an action error without displaying the token", async () => {
    mocks.createUpConnection.mockResolvedValue({ success: false, error: "Token was rejected" });
    render(<BankConnectionsManager connections={[]} countryCode="AU" />);

    fireEvent.change(screen.getByLabelText("Up personal access token"), {
      target: { value: "secret-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect Up" }));

    expect(await screen.findByText("Token was rejected")).toBeTruthy();
    expect(screen.queryByText("secret-token")).toBeNull();
  });
});
