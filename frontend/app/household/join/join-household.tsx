"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
export function JoinHousehold({ token, email }: { token: string; email: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/household", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "accept", token }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not accept invitation");
      window.location.assign("/");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not accept invitation"); setBusy(false); }
  }
  async function switchLogin() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Could not sign out. Please try again.");
      window.location.assign(`/login?redirect=${encodeURIComponent(`/household/join?token=${token}`)}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not switch accounts"); setBusy(false); }
  }
  return <div className="space-y-4"><p>Signed in as <strong>{email}</strong>. This must match the invited email.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={accept}>{busy ? "Please wait…" : "Accept invitation"}</Button>
    <Button variant="outline" disabled={busy} onClick={switchLogin}>Sign in with a different account</Button></div>
  </div>;
}
