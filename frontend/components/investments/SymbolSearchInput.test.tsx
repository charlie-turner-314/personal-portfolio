import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SymbolSearchInput } from "./SymbolSearchInput";
import type { SymbolSearchResult } from "@/lib/api/investments";

function Input({ onSelect = vi.fn() }: { onSelect?: (result: SymbolSearchResult) => void }) {
  const [value, setValue] = useState("");
  return <SymbolSearchInput value={value} onChange={setValue} onSelect={onSelect} />;
}
afterEach(() => vi.unstubAllGlobals());
describe("Independent cancellable market lookup", () => {
  it("cancels an old lookup when manual text is cleared", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetcher);
    render(<Input />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "VAS" } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/investments/symbols/search?q=VAS");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(init.signal?.aborted).toBe(true);
    resolve(Response.json([{ symbol: "VAS.AX", name: "Australian ETF" }]));
    expect(screen.queryByRole("option")).toBeNull();
  });
  it("resolves the selected identity and quote currency independently", async () => {
    const onSelect = vi.fn();
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ symbol: "VAS.AX", name: "Australian ETF" }])).mockResolvedValueOnce(Response.json({ symbol: "VAS.AX", name: "Australian ETF", currency: "AUD", instrument_type: "etf" }));
    vi.stubGlobal("fetch", fetcher);
    render(<Input onSelect={onSelect} />);
    screen.getByRole("combobox").focus();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "VAS" } });
    fireEvent.mouseDown(await screen.findByRole("option"));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ symbol: "VAS.AX", currency: "AUD", instrument_type: "etf" })));
    expect(fetcher.mock.calls[1][0]).toBe("/api/investments/symbols/resolve?symbol=VAS.AX");
  });
  it("reports provider failure without manufacturing a matching instrument", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ detail: "Unavailable" }, { status: 503 })));
    render(<Input />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "VAS" } });
    expect(await screen.findByRole("status")).toHaveTextContent("Symbol search is unavailable");
    expect(screen.queryByRole("option")).toBeNull();
  });
});
