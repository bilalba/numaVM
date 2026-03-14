export type AgentType = "codex" | "opencode";

export type ApprovalPolicy = "on-request" | "unless-allow-listed" | "never";
export type SandboxPolicy = "read-only" | "workspace-write" | "full-access";
export type ReasoningEffort = "low" | "medium" | "high";

export interface CodexModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEffort?: ReasoningEffort[];
  inputModalities?: string[];
  hidden?: boolean;
}

export interface CodexThread {
  id: string;
  title?: string;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type AgentEvent =
  | { type: "session.started"; sessionId: string; agentType: AgentType }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.completed"; turnId: string; status: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; text: string; role: "assistant" | "system" }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed"; text: string }
  | { type: "tool.started"; tool: string; partId?: string; input: unknown }
  | { type: "tool.output.delta"; text: string }
  | { type: "tool.completed"; tool: string; partId?: string; input: unknown; result: unknown }
  | { type: "file.changed"; path: string; diff: string }
  | { type: "approval.requested"; id: string; action: string; detail: unknown }
  | { type: "question.asked"; id: string; questions: QuestionInfo[] }
  | { type: "plan.updated"; steps: { text: string; done: boolean }[] }
  | { type: "todo.updated"; items: { id: string; content: string; status: string; priority: string }[] }
  | { type: "session.progress"; sessionId: string; step: string; message: string }
  | { type: "session.info"; model?: string; provider?: string }
  | { type: "opencode.ready" }
  | { type: "error"; message: string; code?: string };

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export type ApprovalDecision = "accept" | "acceptForSession" | "always" | "decline";

export type AgentCommand =
  | { type: "message.send"; text: string }
  | { type: "turn.interrupt" }
  | { type: "approval.respond"; id: string; decision: ApprovalDecision }
  | { type: "session.switch"; sessionId: string }
  | { type: "session.create" };

export interface AgentBridge {
  readonly agentType: AgentType;
  start(vmId: string, options?: { model?: string; cwd?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<string>;
  sendMessage(text: string, options?: { agent?: string; effort?: ReasoningEffort; approvalPolicy?: ApprovalPolicy; sandboxPolicy?: SandboxPolicy }): Promise<void>;
  interrupt(): Promise<void>;
  destroy(): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): void;
}
