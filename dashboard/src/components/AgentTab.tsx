import { useEffect, useRef, useState, useCallback } from "react";
import { api, type AgentSession, type AgentMessage, type OpenCodeProvider } from "../lib/api";
import { useAgentSocket, type AgentEvent } from "../hooks/useAgentSocket";
import { ChatMessage, StreamingMessage, StreamingReasoning } from "./ChatMessage";
import { ApprovalCard } from "./ApprovalCard";
import { useToast } from "./Toast";
import { relativeTime } from "../lib/time";

interface AgentTabProps {
  envId: string;
  agentType: "codex" | "opencode";
}

interface PendingApproval {
  id: string;
  action: string;
  detail: unknown;
  responded: boolean;
}

export function AgentTab({ envId, agentType }: AgentTabProps) {
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
  const [selectedOpenCodeModel, setSelectedOpenCodeModel] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
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

  const { connected, addListener } = useAgentSocket(envId);

  // Check Codex auth status on mount
  useEffect(() => {
    if (agentType !== "codex") {
      setCodexAuth({ checked: true, authenticated: true });
      return;
    }
    api.getCodexAuthStatus(envId).then((data) => {
      setCodexAuth({ checked: true, authenticated: data.authenticated });
    }).catch(() => {
      setCodexAuth({ checked: true, authenticated: false });
    });
  }, [envId, agentType]);

  // Fetch OpenCode providers on mount
  useEffect(() => {
    if (agentType !== "opencode") return;
    api.getOpenCodeProviders(envId).then((data) => {
      setOpenCodeProviders(data.all || []);
    }).catch(() => {});
  }, [envId, agentType]);

  // Load sessions on mount
  useEffect(() => {
    api
      .listAgentSessions(envId, agentType)
      .then((data) => {
        setSessions(data.sessions);
        if (data.sessions.length > 0) {
          setActiveSessionId(data.sessions[0].id);
        }
      })
      .catch(() => {});
  }, [envId, agentType]);

  // Load messages when active session changes
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    api
      .getAgentSession(envId, activeSessionId)
      .then((data) => {
        setMessages(data.messages);
        setSessionStatus(data.session.status);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [envId, activeSessionId]);

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
      const session = await api.createAgentSession(envId, agentType, selectedModel || undefined, providerID, modelID);
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
      await api.sendAgentMessage(envId, activeSessionId, text, agentMode);
    } catch (err: any) {
      setSessionStatus("error");
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!activeSessionId) return;
    try {
      await api.stopAgent(envId, activeSessionId);
      setSessionStatus("idle");
      setStreamingText("");
    } catch {}
  };

  const handleApproval = useCallback(
    async (approvalId: string, decision: "accept" | "always" | "decline") => {
      if (!activeSessionId) return;
      try {
        await api.respondToApproval(envId, activeSessionId, approvalId, decision);
        setApprovals((prev) =>
          prev.map((a) => (a.id === approvalId ? { ...a, responded: true } : a))
        );
      } catch {}
    },
    [envId, activeSessionId]
  );

  const handleUndo = async () => {
    if (!activeSessionId) return;
    try {
      await api.revertMessage(envId, activeSessionId);
      // Reload messages after revert
      const data = await api.getAgentSession(envId, activeSessionId);
      setMessages(data.messages);
      toast("Reverted last changes", "success");
    } catch (err: any) {
      toast(`Revert failed: ${err.message}`, "error");
    }
  };

  const handleRedo = async () => {
    if (!activeSessionId) return;
    try {
      await api.unrevertSession(envId, activeSessionId);
      const data = await api.getAgentSession(envId, activeSessionId);
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
      const result = await api.startCodexLogin(envId, "chatgpt");
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
      await api.startCodexLogin(envId, "apikey", key);
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
      const data = await api.getCodexAuthStatus(envId, true);
      if (data.authenticated) {
        setCodexAuth({ checked: true, authenticated: true });
      } else {
        setCodexAuth((prev) => ({ ...prev, checkingAuth: false, authError: "Not authenticated yet. Complete sign-in in the browser tab, then try again." }));
      }
    } catch {
      setCodexAuth((prev) => ({ ...prev, checkingAuth: false, authError: "Failed to check auth status." }));
    }
  };

  const agentLabel = agentType === "codex" ? "Codex" : "OpenCode";

  const codexModelOptions = [
    { value: "", label: "Default" },
    { value: "o4-mini", label: "o4-mini" },
    { value: "o3", label: "o3" },
    { value: "codex-mini-latest", label: "codex-mini" },
  ];

  // Build OpenCode model options from providers (grouped by provider)
  const openCodeModelOptions: { value: string; label: string }[] = [{ value: "", label: "Default" }];
  for (const provider of openCodeProviders) {
    for (const model of provider.models) {
      openCodeModelOptions.push({
        value: `${provider.id}:${model.id}`,
        label: `${model.name || model.id}`,
      });
    }
  }

  const modelOptions = agentType === "codex" ? codexModelOptions : openCodeModelOptions;
  const noOpenCodeProviders = agentType === "opencode" && openCodeProviders.length === 0;

  // Show Codex login dialog if not authenticated
  if (agentType === "codex" && codexAuth.checked && !codexAuth.authenticated) {
    const lr = codexAuth.loginResult;
    // The login/start response for chatgpt mode returns device code info
    const deviceUrl = lr?.verificationUri || lr?.verification_uri || lr?.url;
    const deviceCode = lr?.userCode || lr?.user_code || lr?.code;

    return (
      <div className="flex items-center justify-center h-[calc(100vh-200px)] min-h-[400px] px-4">
        <div className="border border-neutral-300 bg-white p-5 max-w-sm w-full text-center">
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
              <div className="border border-neutral-300 bg-[#f8f4ee] py-3 px-6 inline-block mb-6">
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
                <div className="relative flex justify-center"><span className="bg-white px-3 text-[10px] text-neutral-500">or</span></div>
              </div>

              {codexAuth.showApiKey ? (
                <div className="flex gap-2 items-end">
                  <input
                    type="password"
                    value={codexAuth.apiKeyInput || ""}
                    onChange={(e) => setCodexAuth((prev) => ({ ...prev, apiKeyInput: e.target.value }))}
                    placeholder="sk-..."
                    className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none"
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
          {modelOptions.length > 1 ? (
            <select
              value={agentType === "opencode" ? selectedOpenCodeModel : selectedModel}
              onChange={(e) => agentType === "opencode" ? setSelectedOpenCodeModel(e.target.value) : setSelectedModel(e.target.value)}
              className="border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-black focus:border-black focus:outline-none cursor-pointer min-w-0 flex-1 md:flex-none md:w-full"
            >
              {modelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : noOpenCodeProviders ? (
            <p className="text-[10px] text-neutral-400 py-1 hidden md:block">
              No providers configured. Set API keys in the VM to enable model selection.
            </p>
          ) : null}
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
                className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-sm text-black placeholder:text-neutral-500 focus:border-black focus:outline-none resize-none min-h-[28px] max-h-32"
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
                  className="border-0 border-b border-neutral-200 bg-transparent px-0 py-0 text-[10px] text-neutral-500 focus:border-black focus:outline-none cursor-pointer"
                >
                  <option value="">build</option>
                  <option value="plan">plan</option>
                  <option value="general">general</option>
                </select>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
