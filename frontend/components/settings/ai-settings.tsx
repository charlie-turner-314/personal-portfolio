"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAiSettings, saveAiSettings, testAiConnection, removeAiKey, categorizeUncategorized, type AiSettings as Settings } from "@/lib/actions/ai-settings";

export function AiSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [key, setKey] = useState("");
  const [automatic, setAutomatic] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async (loadPreference = false) => {
    const result = await getAiSettings();
    if (!result.success) { setError(result.error); return; }
    setSettings(result.data);
    if (loadPreference) setAutomatic(result.data.configured ? result.data.automatic : true);
  }, []);
  useEffect(() => { void refresh(true); }, [refresh]);
  const active = settings?.job?.status === "queued" || settings?.job?.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  async function act(action: "save" | "test" | "remove" | "categorize") {
    setBusy(action); setError(""); setMessage("");
    try {
      const result = action === "save" ? await saveAiSettings(key, automatic)
        : action === "test" ? await testAiConnection(key)
        : action === "remove" ? await removeAiKey() : await categorizeUncategorized();
      if (!result.success) { setError(result.error); return; }
      if (action === "save" || action === "remove") setKey("");
      setMessage(action === "test" ? "Connection successful. OpenAI accepted a small test request."
        : action === "save" ? "AI settings saved." : action === "remove" ? "API key removed. Future AI requests are disabled; an in-flight request may finish." : "Categorisation queued. You can leave this page and return to check progress.");
      await refresh(action === "remove");
    } catch { setError("The request could not be completed. Please try again."); } finally { setBusy(null); }
  }
  const job = settings?.job;
  return <div className="max-w-2xl space-y-6">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {!settings ? <Button variant="outline" onClick={() => void refresh(true)}>Reload AI settings</Button> : <>
      <Card>
        <CardHeader><CardTitle>AI categorisation</CardTitle><CardDescription>Connect OpenAI to categorise your transactions. Your key is encrypted on the server and applies only to your Portfolio user.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">{settings.configured ? "An API key is saved. It is never displayed again." : "No API key saved."} Model: {settings.model}.</p>
          {!settings.encryption_available && <p role="alert" className="text-sm text-destructive">Server encryption must be configured before a key can be saved.</p>}
          <div className="space-y-2"><Label htmlFor="ai-api-key">OpenAI API key</Label>
            <Input id="ai-api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder={settings.configured ? "Enter a replacement key" : "Enter your API key"} />
          </div>
          <a className="text-sm underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Create or manage an OpenAI API key</a>
          <p className="text-sm text-muted-foreground">AI categorisation sends transaction descriptions, merchants, amounts and relevant categorisation context to OpenAI. Usage is billed to your OpenAI API account. Saving or testing a key makes a small test request without transaction data.</p>
          <div className="flex items-center justify-between gap-4"><Label htmlFor="ai-automatic">Automatically categorise future imports</Label><Switch id="ai-automatic" checked={automatic} onCheckedChange={setAutomatic} /></div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy || !settings.encryption_available || (!key.trim() && !settings.configured)} onClick={() => void act("save")}>{busy === "save" ? "Testing and saving…" : "Save settings"}</Button>
            <Button variant="outline" disabled={!!busy || (!key.trim() && !settings.configured)} onClick={() => void act("test")}>{busy === "test" ? "Testing…" : "Test connection"}</Button>
            {settings.configured && <Button variant="outline" disabled={!!busy} onClick={() => void act("remove")}>Remove key</Button>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Categorise existing transactions</CardTitle><CardDescription>Only uncategorised transactions included in analytics are eligible. Existing categories and internal transfers are left unchanged.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <p>{settings.uncategorized_count} eligible uncategorised transactions</p>
          <Button disabled={!!busy || active || !settings.configured || settings.uncategorized_count === 0} onClick={() => void act("categorize")}>{active ? "Categorisation in progress…" : "Categorise uncategorised transactions"}</Button>
          {job && <div role="status" className="space-y-2 text-sm">
            <p>{job.status === "queued" ? "Waiting for the background worker…" : job.status === "running" ? "Categorising…" : job.status === "failed" ? "Categorisation stopped" : "Categorisation complete"}</p>
            <progress className="w-full" value={job.processed} max={Math.max(1, job.total)} aria-label="Categorisation progress" />
            <p>{job.processed} of {job.total} processed · {job.categorized} categorised · {Math.max(0, job.processed - job.categorized - job.skipped)} unmatched · {job.skipped} skipped</p>
            {job.error && <p role="alert" className="text-destructive">{job.error}</p>}
            {job.status === "completed" && <p>Ambiguous transactions may still need manual review.</p>}
          </div>}
          <Link className="text-sm underline" href="/transactions?category=uncategorized">Review uncategorised transactions</Link>
        </CardContent>
      </Card>
    </>}
  </div>;
}
