import { useEffect, useRef, useState, useCallback } from "react";
import { api, type AgentSession, type AgentMessage } from "../lib/api";
import { useAgentSocket, type AgentEvent } from "../hooks/useAgentSocket";
import { ChatMessage, StreamingMessage } from "./ChatMessage";
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
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string>("idle");
  const [modelInfo, setModelInfo] = useState<{ model?: string; provider?: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
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

        case "message.completed":
          if (event.role === "assistant") {
            setStreamingText("");
            setMessages((prev) => [
              ...prev,
              {
                id: `live-${Date.now()}`,
                session_id: activeSessionId!,
                role: "assistant",
                content: event.text || "",
                metadata: null,
                created_at: new Date().toISOString(),
              },
            ]);
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
  }, [messages, streamingText, approvals]);

  const handleCreateSession = async () => {
    setLoading(true);
    try {
      const session = await api.createAgentSession(envId, agentType, selectedModel || undefined);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setMessages([]);
      setStreamingText("");
      setApprovals([]);
      setSessionStatus("idle");
      setModelInfo(null);
    } catch (err: any) {
      toast(`Failed to create session: ${err.message}`, "error");
    } finally {
      setLoading(false);
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
      await api.sendAgentMessage(envId, activeSessionId, text);
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
    async (approvalId: string, decision: "accept" | "decline") => {
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

  const modelOptions =
    agentType === "codex"
      ? [
          { value: "", label: "Default" },
          { value: "o4-mini", label: "o4-mini" },
          { value: "o3", label: "o3" },
          { value: "codex-mini-latest", label: "codex-mini" },
        ]
      : [{ value: "", label: "Default" }];

  // Show Codex login dialog if not authenticated
  if (agentType === "codex" && codexAuth.checked && !codexAuth.authenticated) {
    const lr = codexAuth.loginResult;
    // The login/start response for chatgpt mode returns device code info
    const deviceUrl = lr?.verificationUri || lr?.verification_uri || lr?.url;
    const deviceCode = lr?.userCode || lr?.user_code || lr?.code;

    return (
      <div className="flex items-center justify-center h-[calc(100vh-200px)] min-h-[400px]">
        <div className="bg-[#141414] border border-[#333] rounded-xl p-8 max-w-md w-full text-center">
          <h2 className="text-xl font-bold mb-2">Sign in to Codex</h2>
          <p className="text-sm text-[#999] mb-6">
            Codex requires authentication with your ChatGPT or OpenAI account.
          </p>

          {deviceUrl && deviceCode ? (
            <div>
              <p className="text-sm text-[#999] mb-4">
                1. Open this link and sign in:
              </p>
              <a
                href={deviceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-blue-400 hover:text-blue-300 underline text-sm mb-5"
              >
                {deviceUrl}
              </a>

              <p className="text-sm text-[#999] mb-3">
                2. Enter this device code:
              </p>
              <div className="bg-[#0a0a0a] border border-[#444] rounded-lg py-3 px-6 inline-block mb-6">
                <span className="text-2xl font-mono font-bold tracking-widest select-all">{deviceCode}</span>
              </div>

              <p className="text-xs text-[#666] mb-4">Expires in 15 minutes. Never share this code.</p>

              {codexAuth.authError && (
                <p className="text-sm text-yellow-400 mb-3">{codexAuth.authError}</p>
              )}

              <button
                onClick={handleCheckAuth}
                disabled={codexAuth.checkingAuth}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {codexAuth.checkingAuth ? "Checking..." : "I've completed sign in"}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <button
                onClick={handleChatGPTLogin}
                disabled={codexAuth.loggingIn}
                className="w-full px-5 py-3 bg-[#10a37f] hover:bg-[#0d8c6d] disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
              >
                {codexAuth.loggingIn ? "Starting login..." : "Sign in with ChatGPT"}
              </button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-[#333]" /></div>
                <div className="relative flex justify-center"><span className="bg-[#141414] px-3 text-xs text-[#666]">or</span></div>
              </div>

              {codexAuth.showApiKey ? (
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={codexAuth.apiKeyInput || ""}
                    onChange={(e) => setCodexAuth((prev) => ({ ...prev, apiKeyInput: e.target.value }))}
                    placeholder="sk-..."
                    className="flex-1 bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-500 font-mono"
                  />
                  <button
                    onClick={handleApiKeyLogin}
                    disabled={!codexAuth.apiKeyInput?.trim() || codexAuth.loggingIn}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setCodexAuth((prev) => ({ ...prev, showApiKey: true }))}
                  className="w-full px-5 py-3 bg-[#1a1a1a] hover:bg-[#222] border border-[#333] text-[#999] text-sm font-medium rounded-lg transition-colors cursor-pointer"
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
    <div className="flex h-[calc(100vh-200px)] min-h-[400px] gap-4">
      {/* Session sidebar */}
      <div className="w-56 shrink-0 bg-[#141414] border border-[#333] rounded-lg flex flex-col">
        <div className="p-3 border-b border-[#333] space-y-2">
          {modelOptions.length > 1 && (
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-2 py-1.5 text-xs text-[#ccc] focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              {modelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          )}
          <button
            onClick={handleCreateSession}
            disabled={loading}
            className="w-full px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded transition-colors cursor-pointer"
          >
            New Session
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="text-xs text-[#666] p-3">
              No sessions yet. Create one to start chatting with {agentLabel}.
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
                className={`w-full text-left px-3 py-2.5 text-sm border-b border-[#222] transition-colors cursor-pointer ${
                  s.id === activeSessionId
                    ? "bg-[#1a1a2e] text-[#e5e5e5]"
                    : "text-[#999] hover:bg-[#1a1a1a]"
                }`}
              >
                <div className="truncate text-xs font-medium">
                  {s.title || `Session ${s.id.slice(0, 8)}`}
                </div>
                <div className="text-[10px] text-[#666] mt-0.5">
                  {relativeTime(s.updated_at || s.created_at)}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col bg-[#0a0a0a] border border-[#333] rounded-lg overflow-hidden">
        {/* Header */}
        <div className="px-4 py-2.5 border-b border-[#333] flex items-center justify-between bg-[#141414]">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{agentLabel}</span>
            <span
              className={`w-2 h-2 rounded-full ${
                sessionStatus === "busy"
                  ? "bg-yellow-400 animate-pulse"
                  : sessionStatus === "error"
                    ? "bg-red-500"
                    : connected
                      ? "bg-green-500"
                      : "bg-gray-500"
              }`}
            />
            <span className="text-xs text-[#666]">{sessionStatus}</span>
            {modelInfo?.model && (
              <span className="text-xs text-[#555] ml-2 font-mono">{modelInfo.model}</span>
            )}
          </div>
          {sessionStatus === "busy" && (
            <button
              onClick={handleStop}
              className="px-2.5 py-1 bg-red-700 hover:bg-red-600 text-white text-xs rounded transition-colors cursor-pointer"
            >
              Stop
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!activeSessionId ? (
            <div className="h-full flex items-center justify-center text-[#666] text-sm">
              Create or select a session to start
            </div>
          ) : loading ? (
            <div className="h-full flex items-center justify-center text-[#666] text-sm">
              Loading messages...
            </div>
          ) : messages.length === 0 && !streamingText ? (
            <div className="h-full flex items-center justify-center text-[#666] text-sm">
              Send a message to start the conversation
            </div>
          ) : (
            <>
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
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
                  />
                ))}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Input */}
        {activeSessionId && (
          <div className="px-4 py-3 border-t border-[#333] bg-[#141414]">
            <div className="flex gap-2">
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${agentLabel}...`}
                rows={1}
                className="flex-1 bg-[#0a0a0a] border border-[#333] rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:border-blue-500 min-h-[38px] max-h-32"
              />
              <button
                onClick={handleSend}
                disabled={!inputText.trim() || sending || sessionStatus === "busy"}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer shrink-0"
              >
                Send
              </button>
            </div>
            <p className="text-[10px] text-[#666] mt-1.5">
              Shift+Enter for new line
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
