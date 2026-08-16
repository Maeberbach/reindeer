import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type KeyStatus = {
  set: boolean;
  preview: string | null;
  liveMode?: boolean;
  provider?: "anthropic" | "openai" | "mock";
};

/**
 * AI key management panel.
 *
 * Supports both Anthropic (Claude) and OpenAI providers. Shows whichever
 * keys are set and lets the captain manage either. When both are set,
 * Anthropic takes priority (it's the preferred provider for this app).
 *
 * Sits quietly below the sign-in form. If no key is set, shows a small
 * "Enable AI" link that expands into a key-entry field. If a key is set,
 * shows the masked preview and a "Manage" link to change or clear it.
 */
export function OpenAIKeyPanel({
  keyStatus,
}: {
  keyStatus: KeyStatus | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"anthropic" | "openai">("anthropic");
  const [keyInput, setKeyInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // Fetch Anthropic key status
  const { data: anthropicStatus } = useQuery<KeyStatus>({
    queryKey: ["/api/settings/anthropic"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings/anthropic");
      return (await res.json()) as KeyStatus;
    },
    retry: false,
  });

  const saveKey = useMutation({
    mutationFn: async () => {
      const endpoint = activeTab === "anthropic" ? "/api/settings/anthropic" : "/api/settings/openai";
      const res = await apiRequest("PUT", endpoint, { apiKey: keyInput });
      return (await res.json()) as KeyStatus & { message?: string };
    },
    onSuccess: (data) => {
      setMessage(data.message ?? null);
      setKeyInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/settings/openai"] });
      queryClient.invalidateQueries({ queryKey: ["/api/settings/anthropic"] });
    },
    onError: (e: Error) => {
      setMessage(e.message.replace(/^\d+:\s*/, ""));
    },
  });

  const anyKeySet = keyStatus?.set || anthropicStatus?.set;
  const activeProvider = keyStatus?.provider || anthropicStatus?.provider || "mock";

  // Collapsed state: a quiet line below the sign-in card
  if (!expanded && !anyKeySet) {
    return (
      <div className="mt-6 text-center">
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => setExpanded(true)}
          data-testid="button-enable-ai"
        >
          Enable AI categorization
        </button>
      </div>
    );
  }

  if (!expanded && anyKeySet) {
    const preview = anthropicStatus?.set
      ? anthropicStatus.preview
      : keyStatus?.preview;
    return (
      <div className="mt-6 text-center text-xs text-muted-foreground">
        AI is <span className="font-medium text-foreground">live</span> ({activeProvider}: {preview})
        <button
          type="button"
          className="ml-2 underline underline-offset-2 hover:text-foreground"
          onClick={() => setExpanded(true)}
          data-testid="button-manage-ai-key"
        >
          Manage
        </button>
      </div>
    );
  }

  // Expanded state: key entry form with provider tabs
  return (
    <Card className="mt-4" data-testid="card-ai-key">
      <CardContent className="space-y-4 p-6">
        <div>
          <h2 className="font-serif text-lg font-semibold" data-testid="text-ai-key-title">
            AI Provider Key
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Paste your API key to enable live AI categorization and value estimates.
            Without a key, the app uses a built-in mock mode that still works but won't
            have real AI intelligence.
          </p>
          {activeProvider !== "mock" && (
            <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
              Active provider: {activeProvider}
            </p>
          )}
        </div>

        {/* Provider tabs */}
        <div className="flex gap-2 border-b border-border pb-2">
          <button
            type="button"
            className={`text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "anthropic"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => { setActiveTab("anthropic"); setKeyInput(""); setMessage(null); }}
          >
            Anthropic (Claude)
          </button>
          <button
            type="button"
            className={`text-sm font-medium px-3 py-1.5 rounded-md transition-colors ${
              activeTab === "openai"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => { setActiveTab("openai"); setKeyInput(""); setMessage(null); }}
          >
            OpenAI
          </button>
        </div>

        {/* Current key status for active tab */}
        {activeTab === "anthropic" && anthropicStatus?.set && (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm">
            Current Anthropic key: <span className="font-mono">{anthropicStatus.preview}</span>
          </div>
        )}
        {activeTab === "openai" && keyStatus?.set && (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-2 text-sm">
            Current OpenAI key: <span className="font-mono">{keyStatus.preview}</span>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="ai-key" className="text-sm font-medium">
            {activeTab === "anthropic" ? "Anthropic API Key" : "OpenAI API Key"}
          </Label>
          <Input
            id="ai-key"
            type="password"
            autoFocus
            placeholder={activeTab === "anthropic" ? "sk-ant-..." : "sk-..."}
            className="h-12 text-base"
            value={keyInput}
            data-testid="input-ai-key"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && keyInput.trim()) saveKey.mutate();
            }}
          />
          <p className="text-xs text-muted-foreground">
            {activeTab === "anthropic" ? (
              <>Get a key at{" "}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  console.anthropic.com/settings/keys
                </a>
              </>
            ) : (
              <>Get a key at{" "}
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                  platform.openai.com/api-keys
                </a>
              </>
            )}
            . The key is stored encrypted on this machine and never shared.
          </p>
        </div>

        {message && (
          <p
            className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
            role="alert"
          >
            {message}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={!keyInput.trim() || saveKey.isPending}
            data-testid="button-save-ai-key"
            onClick={() => saveKey.mutate()}
          >
            {saveKey.isPending ? "Saving…" : "Save key"}
          </Button>
          {(activeTab === "anthropic" ? anthropicStatus?.set : keyStatus?.set) && (
            <Button
              variant="outline"
              disabled={saveKey.isPending}
              data-testid="button-clear-ai-key"
              onClick={() => {
                setKeyInput("");
                saveKey.mutate({ apiKey: "" } as any);
              }}
            >
              Clear
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setExpanded(false);
              setKeyInput("");
              setMessage(null);
            }}
          >
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
