import { useEffect, useRef, useState, useCallback } from "react";
import { api, wsUrlToHttp, type AgentSession, type AgentMessage, type OpenCodeProvider, type OpenCodePopularProvider, type FileEntry, type CodexModel, type ApprovalDecision, type ReasoningEffort, type ApprovalPolicy, type SandboxPolicy, type NodeConnection } from "../lib/api";
import { useAgentSocket, type AgentEvent } from "../hooks/useAgentSocket";
import { ChatMessage, StreamingMessage, StreamingReasoning } from "./ChatMessage";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { TodoList, type TodoItem } from "./TodoList";
import { CommandPalette } from "./CommandPalette";
import { useCommandPalette } from "../hooks/useCommandPalette";
import { useToast } from "./Toast";
import { relativeTime } from "../lib/time";

interface AgentTabProps {
  vmId: string;
  agentType: "codex" | "opencode";
  vmName?: string;
  vmStatus?: string;
  /** True when a session is being auto-created in the backend (e.g. VM created with initial prompt) */
  pendingSession?: boolean;
  /** If set, VM is on a remote node — resolve node connection eagerly */
  hostId?: string | null;
}

interface PendingApproval {
  id: string;
  action: string;
  detail: unknown;
  responded: boolean;
}

interface PendingQuestion {
  id: string;
  questions: { question: string; header: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }[];
  responded: boolean;
}

export function AgentTab({ vmId, agentType, vmName, vmStatus, pendingSession, hostId }: AgentTabProps) {
  const [sessions, setSessionsRaw] = useState<AgentSession[]>([]);
  /** Wrapper that deduplicates sessions by ID (prevents duplicates from racing sources) */
  const setSessions: typeof setSessionsRaw = useCallback((update) => {
    setSessionsRaw((prev) => {
      const next = typeof update === "function" ? update(prev) : update;
      const seen = new Set<string>();
      return next.filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
    });
  }, []);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [reasoningText, setReasoningText] = useState("");
  const [runningTools, setRunningTools] = useState<{ tool: string; partId?: string; input?: unknown }[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<PendingQuestion[]>([]);
  const [todoItems, setTodoItems] = useState<TodoItem[]>([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [initProgress, setInitProgress] = useState<string | null>(null);
  const [opencodeReady, setOpencodeReady] = useState(false);
  const [sending, setSending] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<string>("idle");
  const [modelInfo, setModelInfo] = useState<{ model?: string; provider?: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [openCodeProviders, setOpenCodeProviders] = useState<OpenCodeProvider[]>([]);
  const [openCodePopular, setOpenCodePopular] = useState<OpenCodePopularProvider[]>([]);
  const [selectedOpenCodeModel, setSelectedOpenCodeModel] = useState("");
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [sessionCwd, setSessionCwd] = useState<string>(() => {
    if (!vmName) return "/home/dev";
    const safe = vmName.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "workspace";
    return `/home/dev/${safe}`;
  });
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
  const initTimeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const { toast } = useToast();
  const { isOpen: paletteOpen, open: openPalette, close: closePalette } = useCommandPalette();

  // Direct node agent connection (multi-node) — used for all agent HTTP calls
  const nodeRef = useRef<NodeConnection | null>(null);
  const [nodeReady, setNodeReady] = useState(!hostId); // true immediately for local VMs

  const { connected, addListener, reconnectToNode, connectToCP, getNodeToken, getNodeWsUrl } = useAgentSocket(vmId);

  /** Get the current node connection (uses latest token from WS hook). */
  const getNode = useCallback((): NodeConnection | undefined => {
    if (!nodeRef.current) return undefined;
    // Always use the latest token (may have been refreshed by the WS hook)
    const latestToken = getNodeToken();
    if (latestToken) nodeRef.current.token = latestToken;
    return nodeRef.current;
  }, [getNodeToken]);

  // Eagerly resolve node connection for remote VMs — fetch connect token from CP
  // so all subsequent API calls go directly to the node agent.
  useEffect(() => {
    if (!hostId) {
      setNodeReady(true);
      return;
    }
    api.refreshConnectToken(vmId).then((data) => {
      nodeRef.current = { httpUrl: wsUrlToHttp(data.agentWsUrl), token: data.connectToken };
      reconnectToNode(data.agentWsUrl, data.connectToken, data.expiresAt);
      setNodeReady(true);
    }).catch(() => {
      // Fall back to CP if token fetch fails
      setNodeReady(true);
    });
  }, [vmId, hostId]);

  // Check OpenCode readiness on mount (covers page reload after server is already up).
  // Also connects WS early so we receive the opencode.ready event if still booting.
  useEffect(() => {
    if (agentType !== "opencode") {
      setOpencodeReady(true);
      return;
    }
    if (vmStatus && vmStatus !== "running") return;
    if (!nodeReady) return;

    // Connect WS early so we receive opencode.ready
    if (hostId) {
      // Node WS already connected by eagerly-resolved token above
    } else {
      connectToCP();
    }

    // Poll the HTTP endpoint to check if already ready
    const node = getNode();
    const promise = node
      ? api.getNodeOpenCodeStatus(node, vmId)
      : api.getOpenCodeStatus(vmId);
    promise.then((data) => {
      if (data.opencode_status === "ready") {
        setOpencodeReady(true);
      }
    }).catch(() => {});
  }, [vmId, agentType, vmStatus, nodeReady]);

  /** Catch up from node event log — recover in-flight streaming data on reconnect/reload. */
  const catchUpFromEventLog = useCallback((node: NodeConnection, vmId: string, sessionId: string) => {
    api.pollEvents(node, vmId, sessionId, 0, 1).then((result) => {
      if (result.events.length > 0) {
        let pendingText = "";
        let pendingReasoning = "";
        for (const evt of result.events) {
          const e = evt.data as any;
          switch (evt.type) {
            case "message.delta":
              pendingText += e.text || "";
              break;
            case "reasoning.delta":
              pendingReasoning += e.text || "";
              break;
            case "turn.started":
              setSessionStatus("busy");
              break;
          }
        }
        if (pendingText) setStreamingText(pendingText);
        if (pendingReasoning) setReasoningText(pendingReasoning);
      }
    }).catch(() => {}); // Best effort — WS will deliver live events
  }, []);

  // Check Codex auth status once VM is running + node is ready
  useEffect(() => {
    if (agentType !== "codex") {
      setCodexAuth({ checked: true, authenticated: true });
      return;
    }
    if (vmStatus && vmStatus !== "running") return;
    if (!nodeReady) return;
    const node = getNode();
    const promise = node
      ? api.getNodeCodexAuthStatus(node, vmId)
      : api.getCodexAuthStatus(vmId);
    promise.then((data) => {
      setCodexAuth({ checked: true, authenticated: data.authenticated });
    }).catch(() => {
      setCodexAuth({ checked: true, authenticated: false });
    });
  }, [vmId, agentType, vmStatus, nodeReady]);

  // Fetch Codex models when authenticated and VM is running
  useEffect(() => {
    if (agentType !== "codex" || !codexAuth.authenticated) return;
    if (vmStatus && vmStatus !== "running") return;
    if (!nodeReady) return;
    const node = getNode();
    const promise = node
      ? api.getNodeCodexModels(node, vmId)
      : api.getCodexModels(vmId);
    promise.then((data) => {
      setCodexModels(data.models || []);
    }).catch(() => {});
  }, [vmId, agentType, codexAuth.authenticated, vmStatus, nodeReady]);

  // Fetch OpenCode providers once OpenCode server is ready
  useEffect(() => {
    if (agentType !== "opencode") return;
    if (!opencodeReady) return;
    if (!nodeReady) return;
    const node = getNode();
    const promise = node
      ? api.getNodeOpenCodeProviders(node, vmId)
      : api.getOpenCodeProviders(vmId);
    promise.then((data) => {
      setOpenCodeProviders(data.connected || []);
      setOpenCodePopular(data.popular || []);
    }).catch(() => {});
  }, [vmId, agentType, opencodeReady, nodeReady]);

  // Track whether we're waiting for a backend-created session
  const [awaitingSession, setAwaitingSession] = useState(!!pendingSession);

  // Load sessions on mount. Poll when a pending session is expected but hasn't appeared yet.
  // Uses direct node call when connected to a node, falls back to CP.
  // For OpenCode: wait for opencode.ready before loading (server must be up to list sessions).
  useEffect(() => {
    if (!nodeReady) return;
    if (agentType === "opencode" && !opencodeReady) return;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const fetchSessions = () => {
      const node = getNode();
      const sessionsPromise = node
        ? api.listNodeAgentSessions(node, vmId, agentType)
        : api.listAgentSessions(vmId, agentType);

      sessionsPromise
        .then((data) => {
          if (cancelled) return;
          setSessions(data.sessions);
          if (data.sessions.length > 0) {
            setActiveSessionId((prev) => prev || data.sessions[0].id);
            setAwaitingSession(false);
          } else if (awaitingSession) {
            // Session not yet created — poll again
            pollTimer = setTimeout(fetchSessions, 3000);
          }
        })
        .catch(() => {
          if (!cancelled && awaitingSession) {
            pollTimer = setTimeout(fetchSessions, 3000);
          }
        });
    };
    fetchSessions();

    return () => { cancelled = true; clearTimeout(pollTimer); };
  }, [vmId, agentType, awaitingSession, nodeReady, opencodeReady]);

  // Load messages when active session changes
  // Uses direct node call when connected, falls back to CP (which includes connectToken).
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    if (!nodeReady) return;
    setLoading(true);

    const node = getNode();
    const sessionPromise = node
      ? api.getNodeAgentSession(node, vmId, activeSessionId)
      : api.getAgentSession(vmId, activeSessionId);

    sessionPromise
      .then((data) => {
        setMessages(data.messages);
        setSessionStatus(data.session.status);
        if (data.session.cwd) setSessionCwd(data.session.cwd);
        // Restore model info from persisted session data
        if (data.session.model || data.session.provider) {
          setModelInfo({ model: data.session.model || undefined, provider: data.session.provider || undefined });
        }
        // If session is busy with no assistant messages yet, it's still initializing
        // (e.g. auto-created session where bridge is starting up)
        const hasAssistantMsg = data.messages.some((m: any) => m.role === "assistant" || m.role === "tool");
        if (data.session.status === "busy" && !hasAssistantMsg) {
          setCreating(true);
          setInitProgress("Initializing...");
        } else {
          setCreating(false);
          setInitProgress(null);
        }
        // Restore pending approvals/questions from OpenCode API
        if (data.pendingApprovals?.length) {
          setApprovals(data.pendingApprovals.map((a) => ({ ...a, responded: false })));
        } else {
          setApprovals([]);
        }
        if (data.pendingQuestions?.length) {
          setQuestions(data.pendingQuestions.map((q) => ({ ...q, responded: false })));
        } else {
          setQuestions([]);
        }
        setTodoItems(data.todos || []);

        // Connect WS + HTTP: direct to node agent if remote, or CP if local
        const cpData = data as any; // CP response may include connectToken fields
        if (node) {
          // Already connected to node — just catch up from event log
          catchUpFromEventLog(node, vmId, activeSessionId);
        } else if (cpData.connectToken && cpData.agentWsUrl && cpData.connectTokenExpiresAt) {
          // First connection to remote VM — set up direct node connection
          nodeRef.current = { httpUrl: wsUrlToHttp(cpData.agentWsUrl), token: cpData.connectToken };
          reconnectToNode(cpData.agentWsUrl, cpData.connectToken, cpData.connectTokenExpiresAt);

          // Catch up from event log after node connection is established
          catchUpFromEventLog(nodeRef.current, vmId, activeSessionId);
        } else {
          nodeRef.current = null;
          connectToCP();
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [vmId, activeSessionId, nodeReady]);

  // Listen for backend-created sessions (e.g. auto-created with initial prompt during VM creation)
  // This handles sessions created by the backend (e.g. VM created with initial prompt).
  // Sessions created via handleCreateSession are already in the list — use a ref to track them.
  const clientCreatedSessionsRef = useRef(new Set<string>());
  useEffect(() => {
    return addListener((event: AgentEvent) => {
      if (event.type !== "session.created") return;
      const e = event as any;
      // Only pick up sessions for our agent type
      if (e.agentType && e.agentType !== agentType) return;
      const newSessionId = event.sessionId;
      if (!newSessionId) return;
      // Skip if this session was already created by the client (handleCreateSession)
      if (clientCreatedSessionsRef.current.has(newSessionId)) return;
      setSessions((prev) => [{
        id: newSessionId,
        vm_id: vmId,
        agent_type: agentType,
        thread_id: null,
        title: null,
        cwd: e.cwd || null,
        model: null,
        provider: null,
        status: "idle",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, ...prev]);
      setActiveSessionId(newSessionId);
      setAwaitingSession(false);
      setCreating(true);
      setInitProgress("Initializing...");
      setSessionStatus("busy");
      // Show user message optimistically if prompt was included
      if (e.prompt) {
        setMessages([{
          id: `user-${Date.now()}`,
          session_id: newSessionId,
          role: "user",
          content: e.prompt,
          metadata: null,
          created_at: new Date().toISOString(),
        }]);
      }
    });
  }, [addListener, agentType, vmId, setSessions]);

  // Listen for WebSocket events
  useEffect(() => {
    return addListener((event: AgentEvent) => {
      // opencode.ready is a VM-level event (no session) — always handle it
      if (event.type === "opencode.ready") {
        setOpencodeReady(true);
        return;
      }

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

        case "tool.started":
          setRunningTools((prev) => [...prev, { tool: event.tool || "tool", partId: event.partId, input: event.input }]);
          break;

        case "tool.completed":
          setRunningTools((prev) => {
            // Remove by partId for precise matching, fall back to tool name
            const idx = event.partId
              ? prev.findIndex((t) => t.partId === event.partId)
              : prev.findIndex((t) => t.tool === (event.tool || "tool"));
            return idx >= 0 ? [...prev.slice(0, idx), ...prev.slice(idx + 1)] : prev;
          });
          setMessages((prev) => [
            ...prev,
            {
              id: `tool-${Date.now()}`,
              session_id: activeSessionId!,
              role: "tool",
              content: typeof event.result === "string" ? event.result : JSON.stringify(event.result),
              metadata: JSON.stringify({ tool: event.tool, input: event.input }),
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
          setRunningTools([]);
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

        case "question.asked":
          setQuestions((prev) => [
            ...prev,
            {
              id: event.id || "",
              questions: (event as any).questions || [],
              responded: false,
            },
          ]);
          break;

        case "todo.updated":
          setTodoItems((event as any).items || []);
          break;

        case "session.progress":
          if (event.step === "ready") {
            initTimeoutsRef.current.forEach(clearTimeout);
            initTimeoutsRef.current = [];
            setCreating(false);
            setInitProgress(null);
            setSessionStatus("idle");
          } else {
            setInitProgress(event.message || event.step || "Initializing...");
          }
          break;

        case "session.info":
          // Merge — don't let subsequent events (e.g. account/updated) overwrite model with undefined
          setModelInfo((prev) => ({
            model: event.model || prev?.model,
            provider: event.provider || prev?.provider,
          }));
          if (event.model || event.provider) {
            setSessions((prev) => prev.map((s) =>
              s.id === activeSessionId
                ? { ...s, model: event.model || s.model, provider: event.provider || s.provider }
                : s
            ));
          }
          break;

        case "error":
          if (event.code === "init_error") {
            initTimeoutsRef.current.forEach(clearTimeout);
            initTimeoutsRef.current = [];
            setCreating(false);
            setInitProgress(null);
          }
          setSessionStatus("error");
          // Show the error message to the user
          if (event.message) {
            // Try to extract readable message from JSON error strings
            let errorText = event.message;
            try {
              const parsed = JSON.parse(errorText);
              if (parsed.detail) errorText = parsed.detail;
            } catch {}
            toast(errorText, "error");
          }
          break;
      }
    });
  }, [addListener, activeSessionId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText, reasoningText, runningTools, approvals, questions, initProgress]);

  const handleCreateSession = async (promptOverride?: string) => {
    setCreating(true);
    setInitProgress("Initializing...");
    try {
      // Use override prompt (from auto-create) or capture from input
      const prompt = promptOverride?.trim() || inputText.trim() || undefined;
      if (prompt) setInputText("");

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
        prompt,
      });
      clientCreatedSessionsRef.current.add(session.id);
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      setStreamingText("");
      setReasoningText("");
      setRunningTools([]);
      setApprovals([]);
      setQuestions([]);
      setTodoItems([]);
      setSessionStatus("busy");
      setModelInfo(null);

      // Connect WS + HTTP: direct to node agent if remote, or CP if local
      if (session.connectToken && session.agentWsUrl && session.connectTokenExpiresAt) {
        nodeRef.current = { httpUrl: wsUrlToHttp(session.agentWsUrl), token: session.connectToken };
        reconnectToNode(session.agentWsUrl, session.connectToken, session.connectTokenExpiresAt);
      } else {
        nodeRef.current = null;
        connectToCP();
      }

      // Add optimistic user message if prompt was provided
      if (prompt) {
        setMessages([{
          id: `user-${Date.now()}`,
          session_id: session.id,
          role: "user",
          content: prompt,
          metadata: null,
          created_at: new Date().toISOString(),
        }]);
      } else {
        setMessages([]);
      }

      // Client-side timeout for initialization
      initTimeoutsRef.current.forEach(clearTimeout);
      const timeoutId = setTimeout(() => {
        setInitProgress((prev) => prev ? "Taking longer than expected..." : prev);
      }, 20000);
      const errorTimeoutId = setTimeout(() => {
        setCreating((prev) => {
          if (prev) {
            setInitProgress(null);
            setSessionStatus("error");
            toast("Session initialization timed out", "error");
          }
          return false;
        });
      }, 30000);
      initTimeoutsRef.current = [timeoutId, errorTimeoutId];
    } catch (err: any) {
      toast(`Failed to create session: ${err.message}`, "error");
      setCreating(false);
      setInitProgress(null);
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
      }, getNode());
    } catch (err: any) {
      setSessionStatus("error");
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    if (!activeSessionId) return;
    try {
      await api.stopAgent(vmId, activeSessionId, getNode());
      setSessionStatus("idle");
      setStreamingText("");
    } catch {}
  };

  const handleApproval = useCallback(
    async (approvalId: string, decision: ApprovalDecision) => {
      if (!activeSessionId) return;
      try {
        await api.respondToApproval(vmId, activeSessionId, approvalId, decision, getNode());
        setApprovals((prev) =>
          prev.map((a) => (a.id === approvalId ? { ...a, responded: true } : a))
        );
      } catch {}
    },
    [vmId, activeSessionId]
  );

  const handleQuestionAnswer = useCallback(
    async (questionId: string, answers: string[][]) => {
      if (!activeSessionId) return;
      try {
        await api.respondToQuestion(vmId, activeSessionId, questionId, answers, getNode());
        setQuestions((prev) =>
          prev.map((q) => (q.id === questionId ? { ...q, responded: true } : q))
        );
      } catch {}
    },
    [vmId, activeSessionId]
  );

  const handleQuestionReject = useCallback(
    async (questionId: string) => {
      if (!activeSessionId) return;
      try {
        await api.rejectQuestion(vmId, activeSessionId, questionId, getNode());
        setQuestions((prev) =>
          prev.map((q) => (q.id === questionId ? { ...q, responded: true } : q))
        );
      } catch {}
    },
    [vmId, activeSessionId]
  );

  const handleUndo = async () => {
    if (!activeSessionId) return;
    try {
      await api.revertMessage(vmId, activeSessionId, undefined, getNode());
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
      await api.unrevertSession(vmId, activeSessionId, getNode());
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
      if (activeSessionId) {
        handleSend();
      } else if (inputText.trim() && !creating) {
        handleCreateSession();
      }
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
      await api.deleteAgentSession(vmId, activeSessionId, getNode());
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
    // Fallback if model list hasn't loaded yet
    codexModelOptions.push(
      { value: "gpt-5.3-codex", label: "gpt-5.3-codex" },
      { value: "gpt-5.2-codex", label: "gpt-5.2-codex" },
      { value: "gpt-5.1-codex-mini", label: "gpt-5.1-codex-mini" },
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
      <div className="flex items-center justify-center h-full min-h-[400px] px-4">
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
    <div className="flex flex-col md:flex-row h-full min-h-[400px] gap-0 md:gap-4">
      {/* History sidebar overlay on mobile */}
      {showHistory && (
        <div className="fixed inset-0 z-50 md:hidden" onClick={() => setShowHistory(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <div className="absolute right-0 top-0 bottom-0 w-64 bg-panel-sidebar border-l border-neutral-200 flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-3 border-b border-neutral-200 flex items-center justify-between">
              <span className="text-xs font-semibold">History</span>
              <button onClick={() => setShowHistory(false)} className="text-xs text-neutral-400 hover:text-foreground cursor-pointer">&times;</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sessions.length === 0 ? (
                <p className="text-xs text-neutral-500 p-3">No sessions yet.</p>
              ) : (
                sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      setActiveSessionId(s.id);
                      setStreamingText("");
                      setReasoningText("");
                      setRunningTools([]);
                      setApprovals([]);
                      setQuestions([]);
                      setTodoItems([]);
                      setCreating(false);
                      setInitProgress(null);
                      setSessionStatus("idle");
                      setModelInfo(s.model || s.provider ? { model: s.model || undefined, provider: s.provider || undefined } : null);
                      if (s.cwd) setSessionCwd(s.cwd);
                      setShowHistory(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 text-xs border-b border-neutral-100 transition-opacity cursor-pointer ${
                      s.id === activeSessionId
                        ? "font-semibold opacity-100 bg-panel-chat"
                        : "opacity-60 hover:opacity-80"
                    }`}
                  >
                    <div className="truncate">
                      {s.title || `Session ${s.id.slice(0, 8)}`}
                    </div>
                    <div className="text-[10px] text-neutral-500 mt-0.5 flex items-center gap-1.5">
                      <span>{relativeTime(s.updated_at || s.created_at)}</span>
                      {s.model && <span className="opacity-70">{s.model}</span>}
                    </div>
                    {s.cwd && (
                      <div className="text-[10px] text-neutral-400 mt-0.5 truncate" title={s.cwd}>
                        {s.cwd.replace(/^\/home\/dev\/?/, "~/")}
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Session sidebar — hidden on mobile (use History button), vertical sidebar on desktop */}
      <div className="hidden md:flex md:w-56 shrink-0 bg-panel-sidebar border border-neutral-200 flex-col">
        <div className="p-3 border-b border-neutral-200 flex md:flex-col items-center md:items-stretch gap-2">
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
            onClick={() => handleCreateSession()}
            disabled={creating || (agentType === "opencode" && !opencodeReady)}
            className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer py-1 whitespace-nowrap shrink-0 md:w-full"
          >
            {creating ? `Initializing ${agentLabel}...` : "New Session"}
          </button>
        </div>
        <div className="flex-col flex-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="text-xs text-neutral-500 p-3">
              No sessions yet.
            </p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => {
                  setActiveSessionId(s.id);
                  setStreamingText("");
                  setReasoningText("");
                  setRunningTools([]);
                  setApprovals([]);
                  setQuestions([]);
                  setTodoItems([]);
                  setCreating(false);
                  setInitProgress(null);
                  setSessionStatus("idle");
                  setModelInfo(s.model || s.provider ? { model: s.model || undefined, provider: s.provider || undefined } : null);
                  if (s.cwd) setSessionCwd(s.cwd);
                }}
                className={`w-full text-left px-3 py-2.5 text-xs border-b border-neutral-100 transition-opacity cursor-pointer ${
                  s.id === activeSessionId
                    ? "font-semibold opacity-100 bg-panel-chat"
                    : "opacity-60 hover:opacity-80"
                }`}
              >
                <div className="truncate">
                  {s.title || `Session ${s.id.slice(0, 8)}`}
                </div>
                <div className="text-[10px] text-neutral-500 mt-0.5 flex items-center gap-1.5">
                  <span>{relativeTime(s.updated_at || s.created_at)}</span>
                  {s.model && <span className="opacity-70">{s.model}</span>}
                </div>
                {s.cwd && (
                  <div className="text-[10px] text-neutral-400 mt-0.5 truncate" title={s.cwd}>
                    {s.cwd.replace(/^\/home\/dev\/?/, "~/")}
                  </div>
                )}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Mobile controls — New Session + History buttons */}
      <div className="flex md:hidden items-center gap-2 p-2 bg-panel-sidebar border border-neutral-200">
        {agentType === "opencode" ? (
          <div className="relative min-w-0 flex-1">
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
                  <button
                    onClick={() => { setSelectedOpenCodeModel(""); setShowModelPicker(false); }}
                    className={`w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 cursor-pointer ${!selectedOpenCodeModel ? "font-semibold" : ""}`}
                  >
                    Default
                  </button>
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
            className="border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-xs text-foreground focus:border-foreground focus:outline-none cursor-pointer min-w-0 flex-1"
          >
            {modelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : <div className="flex-1" />}
        <button
          onClick={() => handleCreateSession()}
          disabled={creating || (agentType === "opencode" && !opencodeReady)}
          className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer py-1 whitespace-nowrap shrink-0"
        >
          {creating ? "Creating..." : "New Session"}
        </button>
        <button
          onClick={() => setShowHistory(true)}
          className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 cursor-pointer py-1 whitespace-nowrap shrink-0"
        >
          History
        </button>
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
                    : (agentType === "opencode" && !opencodeReady)
                      ? "bg-neutral-400 animate-pulse"
                      : connected
                        ? "bg-green-500"
                        : "bg-neutral-400"
              }`}
            />
            <span className="text-xs text-neutral-500 hidden sm:inline">{agentType === "opencode" && !opencodeReady ? "Waiting for OpenCode..." : initProgress || sessionStatus}</span>
            {modelInfo?.model && (
              <span className="text-xs text-neutral-500 ml-2 hidden sm:inline">{modelInfo.model}</span>
            )}
            {sessionCwd && (
              <span className="text-xs text-neutral-400 ml-2 hidden sm:inline truncate max-w-[200px]" title={sessionCwd}>
                {sessionCwd.replace(/^\/home\/dev\/?/, "~/")}
              </span>
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
          {agentType === "opencode" && !opencodeReady ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500 text-xs gap-2">
              <div className="animate-pulse">Waiting for OpenCode server...</div>
            </div>
          ) : !activeSessionId ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-xs">
              Create or select a session to start
            </div>
          ) : loading ? (
            <div className="h-full flex items-center justify-center text-neutral-500 text-xs">
              Loading messages...
            </div>
          ) : awaitingSession ? (
            <div className="h-full flex flex-col items-center justify-center text-neutral-500 text-xs gap-2">
              <div className="animate-pulse">Setting up session...</div>
            </div>
          ) : messages.length === 0 && !streamingText && !reasoningText && !creating ? (
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
              {runningTools.filter((t) => t.tool !== "question").length > 0 && (
                <div className="mb-3 ml-2">
                  {runningTools.filter((t) => t.tool !== "question").map((entry, i) => {
                    const inp = entry.input as Record<string, unknown> | undefined;
                    const summary = inp
                      ? (inp.command || inp.pattern || inp.file_path || inp.path || inp.query || null)
                      : null;
                    return (
                      <div key={`running-${i}`} className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500 border border-neutral-200 mb-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
                        Running: {entry.tool}{summary ? `: ${String(summary)}` : ""}
                      </div>
                    );
                  })}
                </div>
              )}
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
              {questions
                .filter((q) => !q.responded)
                .map((q) => (
                  <QuestionCard
                    key={q.id}
                    questionId={q.id}
                    questions={q.questions}
                    onAnswer={handleQuestionAnswer}
                    onReject={handleQuestionReject}
                  />
                ))}
              {creating && initProgress && (
                <div className="mb-3 ml-2">
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500 border border-neutral-200">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
                    {initProgress}
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        {/* Todo list */}
        {todoItems.length > 0 && (
          <div className="px-3 sm:px-4 pt-2">
            <TodoList items={todoItems} />
          </div>
        )}

        {/* Input — always visible so users can type a prompt before creating a session */}
        <div className="px-3 sm:px-4 py-2 sm:py-3 border-t border-neutral-200">
          <div className="flex gap-2 sm:gap-3 items-end">
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={activeSessionId ? `Message ${agentLabel}...` : `Start a new ${agentLabel} session...`}
              rows={1}
              className="flex-1 border-0 border-b border-neutral-300 bg-transparent px-0 py-1 text-base sm:text-sm text-foreground placeholder:text-neutral-500 focus:border-foreground focus:outline-none resize-none min-h-[28px] max-h-32"
            />
            <button
              onClick={activeSessionId ? handleSend : () => handleCreateSession()}
              disabled={!inputText.trim() || sending || creating || sessionStatus === "busy" || (agentType === "opencode" && !opencodeReady)}
              className="text-xs underline underline-offset-4 transition-opacity hover:opacity-60 disabled:opacity-30 cursor-pointer shrink-0 pb-1"
            >
              {activeSessionId ? "Send" : "New Session"}
            </button>
          </div>
          <div className="flex items-center gap-3 mt-1.5">
            <p className="text-[10px] text-neutral-500 hidden sm:block">
              {activeSessionId ? "Shift+Enter for new line" : "Enter to create session with prompt"}
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
        onNewSession={() => handleCreateSession()}
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
