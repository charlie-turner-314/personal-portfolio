import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sidebar = vi.hoisted(() => ({
  isMobile: true,
  state: "collapsed",
  setOpen: vi.fn(),
  setOpenMobile: vi.fn(),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/transactions", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }), signOut: vi.fn() }));
vi.mock("@/components/walkthrough/help-button", () => ({ HelpButton: () => <button>Help</button> }));
vi.mock("@/components/ui/sidebar", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui/sidebar")>("@/components/ui/sidebar");
  return { ...actual, useSidebar: () => sidebar, Sidebar: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside> };
});
import { AppSidebar } from "./app-sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));

describe("mobile sidebar", () => {
  beforeEach(() => { vi.clearAllMocks(); sidebar.isMobile = true; });

  it("keeps all destinations labelled when the desktop preference is collapsed and closes after selection", () => {
    render(<SidebarProvider defaultOpen={false}><AppSidebar /></SidebarProvider>);
    for (const name of ["Home", "Transactions", "Subscriptions", "Budget", "Cashflow", "Investments", "Assets", "Reports", "Settings"]) {
      expect(screen.getByRole("link", { name })).toBeVisible();
    }
    const transactions = screen.getByRole("link", { name: "Transactions" });
    expect(transactions).toHaveAttribute("aria-current", "page");
    fireEvent.click(transactions);
    expect(sidebar.setOpenMobile).toHaveBeenCalledWith(false);
    expect(screen.getByText("Personal Portfolio")).toBeVisible();
  });

  it("retains the collapsed desktop presentation", () => {
    sidebar.isMobile = false;
    render(<SidebarProvider defaultOpen={false}><AppSidebar /></SidebarProvider>);
    expect(screen.queryByText("Transactions")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Transactions", current: "page" })).toHaveAttribute("title", "Transactions");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  });
});
