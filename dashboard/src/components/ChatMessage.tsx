import { useMemo } from "react";
import { marked } from "marked";
import type { AgentMessage } from "../lib/api";

// Configure marked for safe, minimal output
marked.setOptions({
  breaks: true,
  gfm: true,
});

function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

interface ChatMessageProps {
  message: AgentMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const metadata = message.metadata ? JSON.parse(message.metadata) : null;

  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-surface border border-neutral-200 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    const toolInput = metadata?.input;
    const toolName = metadata?.tool || "unknown";

    // Compact inline display for file.read events
    if (toolName === "file.read") {
      const path = toolInput?.path || message.content;
      const lineRange = toolInput?.lineStart ? `:${toolInput.lineStart}${toolInput.lineEnd ? `-${toolInput.lineEnd}` : ""}` : "";
      const symbol = toolInput?.symbolName ? ` (${toolInput.symbolName})` : "";
      return (
        <div className="mb-2 ml-2 px-3 py-1.5 text-xs text-neutral-400">
          Read <span className="text-neutral-500 font-mono">{path}{lineRange}</span>{symbol}
        </div>
      );
    }

    // Collapsible display for patch events
    if (toolName === "patch") {
      const fileCount = toolInput?.fileCount || message.content.split("\n").filter(Boolean).length;
      return (
        <div className="mb-3 ml-2">
          <details className="border border-neutral-200 overflow-hidden">
            <summary className="px-3 py-2 text-xs text-neutral-500 cursor-pointer transition-opacity hover:opacity-60">
              Modified {fileCount} file{fileCount !== 1 ? "s" : ""}
            </summary>
            <pre className="px-3 py-2 text-xs text-neutral-600 overflow-x-auto whitespace-pre-wrap border-t border-neutral-100 max-h-48 bg-surface">
              {message.content}
            </pre>
          </details>
        </div>
      );
    }

    // Extract a human-readable summary of the tool input (e.g. bash command)
    const inputSummary = toolInput
      ? (toolInput.command || toolInput.pattern || toolInput.file_path || toolInput.path || toolInput.query || (typeof toolInput === "string" ? toolInput : null))
      : null;

    return (
      <div className="mb-3 ml-2">
        <details className="border border-neutral-200 overflow-hidden">
          <summary className="px-3 py-2 text-xs text-neutral-500 cursor-pointer transition-opacity hover:opacity-60">
            {toolName}{inputSummary ? `: ${inputSummary}` : ""}
          </summary>
          <pre className="px-3 py-2 text-xs text-neutral-600 overflow-x-auto whitespace-pre-wrap border-t border-neutral-100 max-h-48 bg-surface">
            {message.content}
          </pre>
        </details>
      </div>
    );
  }

  if (message.role === "reasoning") {
    return (
      <div className="mb-3 ml-2">
        <details className="border border-neutral-200 overflow-hidden">
          <summary className="px-3 py-2 text-xs text-neutral-500 cursor-pointer transition-opacity hover:opacity-60">
            Thinking
          </summary>
          <div className="px-3 py-2 text-xs text-neutral-600 whitespace-pre-wrap border-t border-neutral-100 max-h-64 overflow-y-auto bg-surface">
            {message.content}
          </div>
        </details>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="mb-3 text-center">
        <span className="text-xs text-neutral-500 italic">{message.content}</span>
      </div>
    );
  }

  // assistant
  return (
    <div className="mb-3">
      <div className="px-1 py-1 text-sm font-chat">
        <MarkdownContent content={message.content} />
      </div>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content), [content]);
  return <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface StreamingMessageProps {
  text: string;
}

export function StreamingMessage({ text }: StreamingMessageProps) {
  if (!text) return null;
  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    <div className="mb-3">
      <div className="px-1 py-1 text-sm font-chat">
        <div className="markdown-content" dangerouslySetInnerHTML={{ __html: html }} />
        <span className="inline-block w-1.5 h-3.5 bg-foreground ml-0.5 animate-[pulseDot_1s_ease-in-out_infinite]" />
      </div>
    </div>
  );
}

export function StreamingReasoning({ text }: StreamingMessageProps) {
  if (!text) return null;

  return (
    <div className="mb-3 ml-2">
      <details open className="border border-neutral-200 overflow-hidden">
        <summary className="px-3 py-2 text-xs text-neutral-500 cursor-pointer transition-opacity hover:opacity-60">
          Thinking
          <span className="inline-block w-1 h-2.5 bg-neutral-400 ml-1 animate-[pulseDot_1s_ease-in-out_infinite]" />
        </summary>
        <div className="px-3 py-2 text-xs text-neutral-600 whitespace-pre-wrap border-t border-neutral-100 max-h-48 overflow-y-auto bg-surface">
          {text}
        </div>
      </details>
    </div>
  );
}
