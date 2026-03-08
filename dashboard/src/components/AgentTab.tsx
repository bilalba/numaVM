import { useEffect, useRef, useState, useCallback } from "react";
import { api, type AgentSession, type AgentMessage, type OpenCodeProvider, type OpenCodePopularProvider, type FileEntry, type CodexModel, type ApprovalDecision, type ReasoningEffort, type ApprovalPolicy, type SandboxPolicy } from "../lib/api";
import { useAgentSocket, type AgentEvent } from "../hooks/useAgentSocket";
import { ChatMessage, StreamingMessage, StreamingReasoning } from "./ChatMessage";
import { ApprovalCard } from "./ApprovalCard";
import { CommandPalette } from "./CommandPalette";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { useToast } from "./Toast";
import { relativeTime } from "../lib/time";

interface AgentTabProps {
  vmId: string;
  agentType: "codex" | "opencode";
}

interface PendingApproval {
  id: string;
  action: string;
  detail: unknown;
  responded: boolean;
}

export function AgentTab({ vmId, agentType }: AgentTabProps) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [reasoningText, setReasoningText] = useState("");
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [sending, setSending] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string>("idle");
  const [modelInfo, setModelInfo] = useState<{ model?: string; provider?: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [openCodeProviders, setOpenCodeProviders] = useState<OpenCodeProvider[]>([]);
  const [openCodePopular, setOpenCodePopular] = useState<OpenCodePopularProvider[]>([]);
  const [selectedOpenCodeModel, setSelectedOpenCodeModel] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [sessionCwd, setSessionCwd] = useState<string>("/home/dev");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [folderPath, setFolderPath] = useState("/home/dev");
  const [folderEntries, setFolderEntries] = useState<FileEntry[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>("on-request");
  const [sandboxPolicy, setSandboxPolicy] = useState<SandboxPolicy>("full-access");
  const [codexAuth, setCodexAuth] = useState<{
    checked: boolean;
    authenticated: boolean;
    loginResult?: any;
    loggingIn?: boolean;
    apiKeyInput?: string;
    showApiKey?: boolean;
    checkingAuth?: boolean;
    authError?: string;
  }>({ checked: false, authenticated: false });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { isOpen: paletteOpen, open: openPalette, close: closePalette } = useCommandPalette();

  const { connected, addListener } = useAgentSocket(vmId);

  // Check Codex auth status on mount
  useEffect(() => {
    if (agentType !== "codex") {
      setCodexAuth({ checked: true, authenticated: true });
      return;
    }
    api.getCodexAuthStatus(vmId).then((data) => {
      setCodexAuth({ checked: true, authenticated: data.authenticated });
    }).catch(() => {
      setCodexAuth({ checked: true, authenticated: false });
    });
  }, [vmId, agentType]);

  // Fetch Codex models when authenticated
  useEffect(() => {
    if (agentType !== "codex" || !codexAuth.authenticated) return;
    api.getCodexModels(vmId).then((data) => {
      setCodexModels(data.models || []);
    }).catch(() => {});
  }, [vmId, agentType, codexAuth.authenticated]);

  // Fetch OpenCode providers on mount
  useEffect(() => {
    if (agentType !== "opencode") return;
    api.getOpenCodeProviders(vmId).then((data) => {
      setOpenCodeProviders(data.connected || []);
      setOpenCodePopular(data.popular || []);
    }).catch(() => {});
  }, [vmId, agentType]);

  // Load sessions on mount
  useEffect(() => {
    api
      .listAgentSessions(vmId, agentType)
      .then((data) => {
        setSessions(data.sessions);
        if (data.sessions.length > 0) {
          setActiveSessionId(data.sessions[0].id);
        }
      })
      .catch(() => {});
  }, [vmId, agentType]);

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    api
      .getAgentSession(vmId, activeSessionId)
      .then((data) => {
        setMessages(data.messages);
        setSessionStatus(data.session.status);
        if (data.session.cwd) setSessionCwd(data.session.cwd);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [vmId, activeSessionId]);

  // Listen for WebSocket events
  useEffect(() => {
    return addListener((event: AgentEvent) => {
      if (event.sessionId !== activeSessionId) return;

      switch (event.type) {
        case "message.delta":
          setStreamingText((prev) => prev + (event.text || ""));
          break;

        case "reasoning.delta":
          setReasoningText((prev) => prev + (event.text || ""));
          break;

        case "reasoning.completed":
          // Finalize reasoning — keep it available until turn ends
          setReasoningText(event.text || "");
          break;

        case "message.completed":
          if (event.role === "assistant") {
            // Add reasoning + assistant in a single atomic update to guarantee order
            setReasoningText((prevReasoning) => {
              setMessages((msgs) => {
                const newMsgs = [...msgs];
                if (prevReasoning) {
                  newMsgs.push({
                    id: `reasoning-${Date.now()}`,
                    session_id: activeSessionId!,
                    role: "reasoning" as const,
                    content: prevReasoning,
                    metadata: null,
                    created_at: new Date().toISOString(),
                  });
                }
                newMsgs.push({
                  id: `live-${Date.now() + 1}`,
                  session_id: activeSessionId!,
                  role: "assistant",
                  content: event.text || "",
                  metadata: null,
                  created_at: new Date().toISOString(),
                });
                return newMsgs;
              });
              return "";
            });
            setStreamingText("");
          }
          break;

        case "tool.completed":
          setMessages((prev) => [
            ...prev,
            {
              id: `tool-${Date.now()}`,
              session_id: activeSessionId!,
              role: "tool",
              content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
              metadata: JSON.stringify({ tool: event.tool }),
              created_at: new Date().toISOString(),
            },
          ]);
          break;

        case "turn.started":
          setSessionStatus("busy");
          break;

        case "turn.completed":
          setSessionStatus("idle");
          setStreamingText("");
          setReasoningText("");
          break;

        case "approval.requested":
          setApprovals((prev) => [
            ...prev,
            {
              id: event.id || "",
              action: event.action || "",
              detail: event.detail,
              responded: false,
            },
          ]);
          break;

        case "session.info":
          setModelInfo({ model: event.model, provider: event.provider });
          break;

        case "error":
          setSessionStatus("error");
          break;
      }
    });
  }, [addListener, activeSessionId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, reasoningText, approvals]);

  const handleCreateSession = async () => {
    setCreating(true);
    try {
      // Parse OpenCode model selection (format: "providerID:modelID")
      let providerID: string | undefined;
      let modelID: string | undefined;
      if (agentType === "opencode" && selectedOpenCodeModel) {
        const [p, ...m] = selectedOpenCodeModel.split(":");
        providerID = p;
        modelID = m.join(":");
      }
      const session = await api.createAgentSession(vmId, agentType, {
        model: selectedModel || undefined,
        providerID,
        modelID,
        cwd: sessionCwd || undefined,
        effort: selectedEffort || undefined,
        approvalPolicy: agentType === "codex" ? approvalPolicy : undefined,
        sandboxPolicy: agentType === "codex" ? sandboxPolicy : undefined,
      });
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      setStreamingText("");
      setReasoningText("");
      setApprovals([]);
      setSessionStatus("idle");
      setModelInfo(null);
    } catch (err: any) {
      toast(`Failed to create session: ${err.message}`, "error");
    } finally {
      setCreating(false);
    }
  };

  const handleSend = async () => {
    if (!inputText.trim() || !activeSessionId || sending) return;
    const text = inputText.trim();
    setInputText("");
    setSending(true);

    // Optimistic: add user message immediately
    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        session_id: activeSessionId,
        role: "user",
        content: text,
        metadata: null,
        created_at: new Date().toISOString(),
      },
    ]);
    setSessionStatus("busy");

    try {
      const agentMode = agentType === "opencode" && selectedAgent ? selectedAgent : undefined;
      await api.sendAgentMessage(vmId, activeSessionId, text, {
        agent: agentMode,
        effort: agentType === "codex" && selectedEffort ? selectedEffort : undefined,
        approvalPolicy: agentType === "codex" ? approvalPolicy : undefined,
        sandboxPolicy: agentType === "codex" ? sandboxPolicy : undefined,
      });
    } catch (err: any) {
      setSessionStatus("error");
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!activeSessionId) return;
    try {
      await api.stopAgent(vmId, activeSessionId);
      setSessionStatus("idle");
      setStreamingText("");
    } catch {}
  };

  const handleApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      if (!activeSessionId) return;
      try {
        await api.respondToApproval(vmId, activeSessionId, approvalId, decision);
        setApprovals((prev) =>
          prev.map((a) => (a.id === approvalId ? { ...a, responded: true } : a))
        );
      } catch {}
    },
    [vmId, activeSessionId]
  );

  const handleUndo = async () => {
    if (!activeSessionId) return;
    try {
      await api.revertMessage(vmId, activeSessionId);
      // Reload messages after revert
      const data = await api.getAgentSession(vmId, activeSessionId);
      setMessages(data.messages);
      toast("Reverted last changes", "success");
    } catch (err: any) {
      toast(`Revert failed: ${err.message}`, "error");
    }
  };

  const handleRedo = async () => {
    if (!activeSessionId) return;
    try {
      await api.unrevertSession(vmId, activeSessionId);
      const data = await api.getAgentSession(vmId, activeSessionId);
      setMessages(data.messages);
      toast("Restored reverted changes", "success");
    } catch (err: any) {
      toast(`Unrevert failed: ${err.message}`, "error");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleChatGPTLogin = async () => {
    setCodexAuth((prev) => ({ ...prev, loggingIn: true }));
    try {
      const result = await api.startCodexLogin(vmId, "chatgpt");
      setCodexAuth((prev) => ({ ...prev, loginResult: result, loggingIn: false }));
    } catch (err: any) {
      toast(`Login failed: ${err.message}`, "error");
      setCodexAuth((prev) => ({ ...prev, loggingIn: false }));
    }
  };

  const handleApiKeyLogin = async () => {
    const key = codexAuth.apiKeyInput?.trim();
    if (!key) return;
    setCodexAuth((prev) => ({ ...prev, loggingIn: true }));
    try {
      await api.startCodexLogin(vmId, "apikey", key);
      setCodexAuth({ checked: true, authenticated: true });
    } catch (err: any) {
      toast(`Login failed: ${err.message}`, "error");
      setCodexAuth((prev) => ({ ...prev, loggingIn: false }));
    }
  };

  const handleCheckAuth = async () => {
    setCodexAuth((prev) => ({ ...prev, checkingAuth: true }));
    try {
      // refresh=true destroys the stale auth bridge so a fresh app-server picks up new creds
      const data = await api.getCodexAuthStatus(vmId, true);
      if (data.authenticated) {
        setCodexAuth({ checked: true, authenticated: true });
      } else {
        setCodexAuth((prev) => ({ ...prev, checkingAuth: false, authError: "Not authenticated yet. Complete sign-in in the browser tab, then try again." }));
      }
    } catch {
      setCodexAuth((prev) => ({ ...prev, checkingAuth: false, authError: "Failed to check auth status." }));
    }
  };

  const handleSignOut = async () => {
    try {
      await api.logoutCodex(vmId);
      setCodexAuth({ checked: true, authenticated: false });
    } catch (err: any) {
      toast(`Sign out failed: ${err.message}`, "error");
    }
  };

  const handleArchiveSession = async () => {
    if (!activeSessionId) return;
    try {
      await api.deleteAgentSession(vmId, activeSessionId);
      setSessions((prev) => prev.filter((s) => s.id !== activeSessionId));
      setActiveSessionId(sessions.length > 1 ? sessions.find((s) => s.id !== activeSessionId)?.id || null : null);
      setMessages([]);
      setStreamingText("");
      setApprovals([]);
    } catch (err: any) {
      toast(`Archive failed: ${err.message}`, "error");
    }
  };

  const browseFolders = useCallback(async (path: string) => {
    setLoadingFolders(true);
    try {
      const data = await api.listFiles(vmId, path);
      setFolderPath(path);
      setFolderEntries(data.entries.filter((e) => e.type === "dir"));
    } catch {
      toast("Failed to list directories", "error");
    } finally {
      setLoadingFolders(false);
    }
  }, [vmId, toast]);

  const openFolderPicker = useCallback(() => {
    setShowFolderPicker(true);
    browseFolders(sessionCwd || "/home/dev");
  }, [sessionCwd, browseFolders]);

  const agentLabel = agentType === "codex" ? "Codex" : "OpenCode";

  // Build Codex model options from dynamic list, with hardcoded fallback
  const codexModelOptions: { value: string; label: string }[] = [{ value: "", label: "Default" }];
  if (codexModels.length > 0) {
    for (const m of codexModels) {
      codexModelOptions.push({ value: m.id, label: m.displayName });
    }
  } else {
    codexModelOptions.push(
      { value: "o4-mini", label: "o4-mini" },
      { value: "o3", label: "o3" },
      { value: "codex-mini-latest", label: "codex-mini" },
    );
  }

  // Build OpenCode model options from connected providers
  const openCodeModelOptions: { value: string; label: string; group?: string }[] = [];
  for (const provider of openCodeProviders) {
    for (const model of provider.models) {
      openCodeModelOptions.push({
        value: `${provider.id}:${model.id}`,
        label: model.name || model.id,
        group: provider.name || provider.id,
      });
    }
  }

  // Get display name for selected OpenCode model
  const selectedOpenCodeModelLabel = openCodeModelOptions.find((o) => o.value === selectedOpenCodeModel)?.label || "Default";

  const modelOptions = agentType === "codex" ? codexModelOptions : [{ value: "", label: "Default" }, ...openCodeModelOptions];

  // Show Codex login dialog if not authenticated
  if (agentType === "codex" && codexAuth.checked && !codexAuth.authenticated) {
    const lr = codexAuth.loginResult;
    // The login/start response for chatgpt mode returns device code info
    const deviceUrl = lr?.verificationUri || lr?.verification_uri || lr?.url;
    const deviceCode = lr?.userCode || lr?.user_code || lr?.code;

    return (
      <div className="flex items-center justify-center h-[calc(100vh-200px)] min-h-[400px] px-4">
        <div className="border border-neutral-300 bg-surface p-5 max-w-sm w-full text-center">
          <h2 className="text-sm font-semibold mb-2">Sign in to Codex</h2>
          <p className="text-xs text-neutral-500 mb-6">
            Codex requires authentication with your ChatGPT or OpenAI account.
          </p>

          {deviceUrl && deviceCode ? (
            <div>
              <p className="text-xs text-neutral-500 mb-4">
                1. Open this link and sign in:
              </p>
              <a
                href={deviceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-xs underline underline-offset-4 transition-opacity hover:opacity-60 mb-5"
              >
                {deviceUrl}
              </a>

              <p className="text-xs text-neutral-500 mb-3">
                2. Enter this device code:
              </p>
              <div className="border border-neutral-300 bg-background py-3 px-6 inline-block mb-6">
                <span className="text-2xl font-semibold tracking-widest select-all">{deviceCode}</span>
              </div>

              <p className="text-[10px] text-neutral-500 mb-4">Expires in 15 minutes. Never share this code.</p>

              {codexAuth.authError && (
                <p className="text-xs text-red-600 mb-3">{codexAuth.authError}</p>
              )}

              <button
                onClick={handleCheckAuth}
                disabled={codexAuth.checkingAuth}
                className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer"
              >
                {codexAuth.checkingAuth ? "Checking..." : "I've completed sign in"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <button
                onClick={handleChatGPTLogin}
                disabled={codexAuth.loggingIn}
                className="w-full text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer py-2"
              >
                {codexAuth.loggingIn ? "Starting login..." : "Sign in with ChatGPT"}
              </button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-neutral-200" /></div>
                <div className="relative flex justify-center"><span className="bg-surface px-3 text-[10px] text-neutral-500">or</span></div>
              </div>

              {codexAuth.showApiKey ? (
                <div className="flex gap-2 items-end">
                  <input
                    type="password"
                    value={codexAuth.apiKeyInput || ""}
                    onChange={(e) => setCodexAuth((prev) => ({ ...prev, apiKeyInput: e.target.value }))}
                    placeholder="sk-..."
                    className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none"
                  />
                  <button
                    onClick={handleApiKeyLogin}
                    disabled={!codexAuth.apiKeyInput?.trim() || codexAuth.loggingIn}
                    className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer pb-1"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setCodexAuth((prev) => ({ ...prev, showApiKey: true }))}
                  className="w-full text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer py-2"
                >
                  Use API Key
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-[calc(100vh-200px)] min-h-[400px] gap-0 md:gap-4">
      {/* Session sidebar — horizontal scrollable strip on mobile, vertical sidebar on desktop */}
      <div className="md:w-56 shrink-0 bg-panel-sidebar border border-neutral-200 flex flex-col">
        <div className="p-2 sm:p-3 border-b border-neutral-200 flex md:flex-col items-center md:items-stretch gap-2">
          {agentType === "opencode" ? (
            <div className="relative min-w-0 flex-1 md:flex-none md:w-full">
              <button
                onClick={() => setShowModelPicker(!showModelPicker)}
                className="w-full border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground text-left cursor-pointer hover:border-foreground transition-colors truncate"
              >
                {selectedOpenCodeModelLabel}
              </button>
              {showModelPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowModelPicker(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 w-64 bg-surface border border-neutral-200 shadow-lg max-h-80 overflow-y-auto">
                    {/* Default option */}
                    <button
                      onClick={() => { setSelectedOpenCodeModel(""); setShowModelPicker(false); }}
                      className={`w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 cursor-pointer ${!selectedOpenCodeModel ? "font-semibold" : ""}`}
                    >
                      Default
                    </button>
                    {/* Connected providers with models */}
                    {openCodeProviders.map((provider) => (
                      <div key={provider.id}>
                        <div className="px-3 pt-3 pb-1 text-[10px] text-neutral-400 uppercase tracking-wider">
                          {provider.name || provider.id}
                        </div>
                        {provider.models.map((model) => {
                          const val = `${provider.id}:${model.id}`;
                          return (
                            <button
                              key={val}
                              onClick={() => { setSelectedOpenCodeModel(val); setShowModelPicker(false); }}
                              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100 cursor-pointer flex items-center justify-between ${selectedOpenCodeModel === val ? "font-semibold" : ""}`}
                            >
                              <span>{model.name || model.id}</span>
                              {selectedOpenCodeModel === val && <span className="text-neutral-400">&#10003;</span>}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {/* Popular unconnected providers */}
                    {openCodePopular.length > 0 && (
                      <>
                        <div className="px-3 pt-4 pb-1 text-[10px] text-neutral-400 uppercase tracking-wider border-t border-neutral-100 mt-2">
                          Add provider
                        </div>
                        {openCodePopular.map((p) => (
                          <div
                            key={p.id}
                            className="px-3 py-1.5 text-xs text-neutral-400 flex items-center justify-between"
                            title={`Set ${p.env[0] || "API key"} in the VM terminal`}
                          >
                            <span>{p.name}</span>
                            <span className="text-[10px]">{p.env[0]?.replace(/_API_KEY|_TOKEN/, "")}</span>
                          </div>
                        ))}
                        <p className="px-3 py-2 text-[10px] text-neutral-400 border-t border-neutral-100 mt-1">
                          Set API keys in terminal to connect
                        </p>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : modelOptions.length > 1 ? (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground focus:border-foreground focus:outline-none cursor-pointer min-w-0 flex-1 md:flex-none md:w-full"
            >
              {modelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : null}
          <button
            onClick={openFolderPicker}
            className="text-[10px] text-neutral-500 truncate py-0.5 cursor-pointer hover:text-foreground transition-colors text-left hidden md:block"
            title={`Working directory: ${sessionCwd}`}
          >
            cwd: {sessionCwd.replace("/home/dev/", "~/")}
          </button>
          <button
            onClick={handleCreateSession}
            disabled={creating}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer py-1 whitespace-nowrap shrink-0 md:w-full"
          >
            {creating ? `Initializing ${agentLabel}...` : "New Session"}
          </button>
        </div>
        <div className="flex md:flex-col md:flex-1 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="text-xs text-neutral-500 p-2 sm:p-3 whitespace-nowrap">
              No sessions yet.
            </p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setActiveSessionId(s.id);
                  setStreamingText("");
                  setApprovals([]);
                }}
                className={`text-left px-3 py-2 md:py-2.5 text-xs border-r md:border-r-0 md:border-b border-neutral-100 transition-opacity cursor-pointer shrink-0 ${
                  s.id === activeSessionId
                    ? "font-semibold opacity-100 bg-panel-chat"
                    : "opacity-60 hover:opacity-80"
                }`}
              >
                <div className="truncate max-w-[150px] md:max-w-none">
                  {s.title || `Session ${s.id.slice(0, 8)}`}
                </div>
                <div className="text-[10px] text-neutral-500 mt-0.5">
                  {relativeTime(s.updated_at || s.created_at)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col bg-panel-chat border border-neutral-200 overflow-hidden min-h-0">
        {/* Header */}
        <div className="px-3 sm:px-4 py-2 border-b border-neutral-200 flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-semibold">{agentLabel}</span>
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                sessionStatus === "busy"
                  ? "bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]"
                  : sessionStatus === "error"
                    ? "bg-red-500"
                    : connected
                      ? "bg-green-500"
                      : "bg-neutral-400"
              }`}
            />
            <span className="text-xs text-neutral-500 hidden sm:inline">{sessionStatus}</span>
            {modelInfo?.model && (
              <span className="text-xs text-neutral-500 ml-2 hidden sm:inline">{modelInfo.model}</span>
            )}
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <button
              onClick={openPalette}
              className="text-[10px] text-neutral-400 border border-neutral-200 px-1.5 py-0.5 hover:border-neutral-400 hover:text-neutral-600 cursor-pointer transition-colors hidden sm:inline-flex items-center gap-1"
              title="Command palette"
            >
              <kbd className="text-[9px]">{navigator.platform?.includes("Mac") ? "\u2318" : "Ctrl+"}K</kbd>
            </button>
            {agentType === "opencode" && sessionStatus !== "busy" && messages.length > 0 && (
              <>
                <button
                  onClick={handleUndo}
                  className="text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer"
                >
                  Undo
                </button>
                <button
                  onClick={handleRedo}
                  className="text-xs underline underline-offset-4 opacity-60 transition-opacity hover:opacity-80 cursor-pointer"
                >
                  Redo
                </button>
              </>
            )}
            {sessionStatus === "busy" && (
              <button
                onClick={handleStop}
                className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
              >
                Stop
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 sm:py-4">
          {creating ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-xs">
              Initializing {agentLabel}...
            </div>
          ) : !activeSessionId ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-xs">
              Create or select a session to start
            </div>
          ) : loading ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-xs">
              Loading messages...
            </div>
          ) : messages.length === 0 && !streamingText && !reasoningText ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-xs">
              Send a message to start the conversation
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
              {reasoningText && <StreamingReasoning text={reasoningText} />}
              {streamingText && <StreamingMessage text={streamingText} />}
              {approvals
                .filter((a) => !a.responded)
                .map((a) => (
                  <ApprovalCard
                    key={a.id}
                    approvalId={a.id}
                    action={a.action}
                    detail={a.detail}
                    onRespond={handleApproval}
                    agentType={agentType}
                  />
                ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        {activeSessionId && (
          <div className="px-3 sm:px-4 py-2 sm:py-3 border-t border-neutral-200">
            <div className="flex gap-2 sm:gap-3 items-end">
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${agentLabel}...`}
                rows={1}
                className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none resize-none min-h-[28px] max-h-32"
              />
              <button
                onClick={handleSend}
                disabled={!inputText.trim() || sending || sessionStatus === "busy"}
                className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer shrink-0 pb-1"
              >
                Send
              </button>
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <p className="text-[10px] text-neutral-500 hidden sm:block">
                Shift+Enter for new line
              </p>
              {agentType === "opencode" && (
                <select
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="border-0 border-b border-neutral-200 bg-transparent px-0 py-0 text-[10px] text-neutral-500 focus:border-foreground focus:outline-none cursor-pointer"
                >
                  <option value="">build</option>
                  <option value="plan">plan</option>
                  <option value="general">general</option>
                </select>
              )}
              {agentType === "codex" && selectedEffort && (
                <span className="text-[10px] text-neutral-400">effort: {selectedEffort}</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Command Palette */}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={closePalette}
        agentType={agentType}
        codexModels={codexModels}
        sessions={sessions}
        currentModel={selectedModel}
        currentEffort={selectedEffort}
        currentApprovalPolicy={approvalPolicy}
        currentSandboxPolicy={sandboxPolicy}
        isAuthenticated={codexAuth.authenticated}
        onSelectModel={(id) => setSelectedModel(id)}
        onSelectEffort={(e) => setSelectedEffort(e)}
        onNewSession={handleCreateSession}
        onSwitchSession={(id) => {
          setActiveSessionId(id);
          setStreamingText("");
          setApprovals([]);
        }}
        onArchiveSession={handleArchiveSession}
        onChangeCwd={openFolderPicker}
        onApprovalPolicy={(p) => setApprovalPolicy(p)}
        onSandboxPolicy={(p) => setSandboxPolicy(p)}
        onSignOut={handleSignOut}
      />

      {/* Folder picker modal */}
      {showFolderPicker && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowFolderPicker(false)}>
          <div className="bg-surface border border-neutral-300 w-80 max-h-96 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-3 py-2 border-b border-neutral-200 flex items-center justify-between">
              <span className="text-xs font-semibold">Select working directory</span>
              <button onClick={() => setShowFolderPicker(false)} className="text-xs text-neutral-500 hover:text-foreground cursor-pointer">&times;</button>
            </div>
            <div className="px-3 py-2 border-b border-neutral-200">
              <p className="text-[10px] text-neutral-500 truncate">{folderPath}</p>
            </div>
            <div className="flex-1 overflow-y-auto">
              {folderPath !== "/" && (
                <button
                  onClick={() => browseFolders(folderPath.split("/").slice(0, -1).join("/") || "/")}
                  className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100 cursor-pointer text-neutral-500"
                >
                  ..
                </button>
              )}
              {loadingFolders ? (
                <p className="text-xs text-neutral-500 px-3 py-2">Loading...</p>
              ) : folderEntries.length === 0 ? (
                <p className="text-xs text-neutral-500 px-3 py-2">No subdirectories</p>
              ) : (
                folderEntries.map((entry) => (
                  <button
                    key={entry.name}
                    onClick={() => browseFolders(`${folderPath === "/" ? "" : folderPath}/${entry.name}`)}
                    className="w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-100 cursor-pointer flex items-center gap-1.5"
                  >
                    <span className="text-neutral-400">/</span>
                    {entry.name}
                  </button>
                ))
              )}
            </div>
            <div className="px-3 py-2 border-t border-neutral-200 flex justify-end gap-2">
              <button
                onClick={() => setShowFolderPicker(false)}
                className="text-xs text-neutral-500 hover:text-foreground cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setSessionCwd(folderPath);
                  setShowFolderPicker(false);
                }}
                className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer"
              >
                Select
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
