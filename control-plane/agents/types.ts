export type AgentType = "codex" | "opencode";

export type AgentEvent =
  | { type: "session.started"; sessionId: string; agentType: AgentType }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.completed"; turnId: string; status: string }
  | { type: "message.delta"; text: string }
  | { type: "message.completed"; text: string; role: "assistant" | "system" }
  | { type: "reasoning.delta"; text: string }
  | { type: "reasoning.completed"; text: string }
  | { type: "tool.started"; tool: string; input: unknown }
  | { type: "tool.output.delta"; text: string }
  | { type: "tool.completed"; tool: string; result: unknown }
  | { type: "file.changed"; path: string; diff: string }
  | { type: "approval.requested"; id: string; action: string; detail: unknown }
  | { type: "plan.updated"; steps: { text: string; done: boolean }[] }
  | { type: "session.info"; model?: string; provider?: string }
  | { type: "error"; message: string; code?: string };

export type AgentCommand =
  | { type: "message.send"; text: string }
  | { type: "turn.interrupt" }
  | { type: "approval.respond"; id: string; decision: "accept" | "decline" }
  | { type: "session.switch"; sessionId: string }
  | { type: "session.create" };

export interface AgentBridge {
  readonly agentType: AgentType;
  start(envSlugOrCid: string | number, options?: { model?: string }): Promise<string>; // returns thread/session ID from the agent
  sendMessage(text: string): Promise<void>;
  interrupt(): Promise<void>;
  destroy(): Promise<void>;
  onEvent(listener: (event: AgentEvent) => void): void;
}
