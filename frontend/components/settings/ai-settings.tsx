"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOllamaModels, getAiSettings, saveAiSettings, testAiConnection, removeAiKey, categorizeUncategorized, type AiSettings as Settings } from "@/lib/actions/ai-settings";

export function AiSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<"openai" | "ollama">("openai");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  async function loadModels() {
    setLoadingModels(true); setError("");
    try {
      const result = await getOllamaModels();
      if (result.success) setModels(result.data.models);
      else setError(result.error);
    } finally { setLoadingModels(false); }
  }
  useEffect(() => { if (provider === "ollama") void loadModels(); }, [provider]);
  const [key, setKey] = useState("");
  const [automatic, setAutomatic] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const refresh = useCallback(async (loadPreference = false) => {
    const result = await getAiSettings();
    if (!result.success) { setError(result.error); return; }
    setSettings(result.data);
    if (loadPreference) {
      setAutomatic(result.data.configured ? result.data.automatic : true);
      setProvider(result.data.provider ?? "openai");
      setModel(result.data.provider === "ollama" ? result.data.model ?? "" : "");
    }
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
      const result = action === "save" ? await saveAiSettings(provider === "openai" ? key : "", automatic, provider, model || undefined)
        : action === "test" ? await testAiConnection(provider === "openai" ? key : "", provider, model || undefined)
        : action === "remove" ? await removeAiKey() : await categorizeUncategorized();
      if (!result.success) {
        setError(result.error);
        if (action === "categorize") await refresh();
        return;
      }
      if (action === "save" || action === "remove") setKey("");
      setMessage(action === "test" ? "Connection successful. The selected model answered a small test request."
        : action === "save" ? "AI settings saved." : action === "remove" ? "AI disconnected. Future AI requests are disabled; an in-flight request may finish." : "Categorisation queued. You can leave this page and return to check progress.");
      await refresh(action === "remove");
    } catch { setError("The request could not be completed. Please try again."); } finally { setBusy(null); }
  }
  const job = settings?.job;
  return <div className="max-w-2xl space-y-6">
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {!settings ? <Button variant="outline" onClick={() => void refresh(true)}>Reload AI settings</Button> : <>
      <Card>
        <CardHeader><CardTitle>AI categorisation</CardTitle><CardDescription>Choose OpenAI or a local Ollama model to categorise your transactions. Settings apply only to your Portfolio user.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label htmlFor="ai-provider">AI provider</Label>
            <select id="ai-provider" className="w-full rounded-md border bg-background p-2" value={provider} onChange={e => { setProvider(e.target.value as "openai" | "ollama"); setKey(""); setMessage(""); }}>
              <option value="openai">OpenAI</option><option value="ollama">Ollama (local Mac)</option>
            </select>
          </div>
          {provider === "openai" ? <>
            <p className="text-sm">{settings.configured && settings.provider !== "ollama" ? "An API key is saved. It is never displayed again." : "Enter an OpenAI key to connect or switch providers."}</p>
            {!settings.encryption_available && <p role="alert" className="text-sm text-destructive">Server encryption must be configured before a key can be saved.</p>}
            <div className="space-y-2"><Label htmlFor="ai-api-key">OpenAI API key</Label>
              <Input id="ai-api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} placeholder="Enter your API key" />
            </div>
            <a className="text-sm underline" href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">Create or manage an OpenAI API key</a>
            <p className="text-sm text-muted-foreground">Your key is encrypted on the server. Transaction descriptions, merchants, amounts and categorisation context are sent to OpenAI. Usage is billed to your OpenAI API account.</p>
          </> : <>
            <div className="space-y-2"><Label htmlFor="ai-model">Ollama model</Label>
              <select id="ai-model" className="w-full rounded-md border bg-background p-2" value={model} onChange={e => setModel(e.target.value)}>
                <option value="">Select an installed model</option>
                {model && !models.includes(model) && <option value={model}>{model} (saved)</option>}
                {models.map(name => <option key={name} value={name}>{name}</option>)}
              </select>
            </div>
            <Button variant="outline" disabled={loadingModels} onClick={() => void loadModels()}>{loadingModels ? "Loading models…" : "Refresh models"}</Button>
            <p className="text-sm text-muted-foreground">Transactions are processed by the local model on your Mac through the server’s private connection. Keep the Mac awake and on the network. If unavailable, retry later; transactions are never automatically sent to a cloud provider.</p>
          </>}
          <p className="text-sm text-muted-foreground">Saving or testing makes a small request without transaction data. Loading a local model can take up to two minutes.</p>
          <div className="flex items-center justify-between gap-4"><Label htmlFor="ai-automatic">Automatically categorise future imports</Label><Switch id="ai-automatic" checked={automatic} onCheckedChange={setAutomatic} /></div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!!busy || (provider === "ollama" ? !model : !settings.encryption_available || (!key.trim() && !(settings.configured && settings.provider !== "ollama")))} onClick={() => void act("save")}>{busy === "save" ? "Testing and saving…" : "Save settings"}</Button>
            <Button variant="outline" disabled={!!busy || (provider === "ollama" ? !model : (!key.trim() && !(settings.configured && settings.provider !== "ollama")))} onClick={() => void act("test")}>{busy === "test" ? "Testing…" : "Test connection"}</Button>
            {settings.configured && <Button variant="outline" disabled={!!busy} onClick={() => void act("remove")}>Disconnect AI</Button>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Categorise existing transactions</CardTitle><CardDescription>Only uncategorised transactions included in analytics are eligible. Existing categories and internal transfers are left unchanged.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm">Uses your saved provider: {settings.provider === "ollama" ? "Ollama" : "OpenAI"}{settings.model ? ` · ${settings.model}` : ""}. Save settings above to change it.</p>
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
