import type { AgentMessage } from "../lib/api";

interface ChatMessageProps {
  message: AgentMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const metadata = message.metadata ? JSON.parse(message.metadata) : null;

  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-sm text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="mb-3 ml-2">
        <details className="bg-[#1a1a2e] border border-[#333] rounded-lg overflow-hidden">
          <summary className="px-3 py-2 text-xs text-[#999] cursor-pointer hover:bg-[#222]">
            Tool: {metadata?.tool || "unknown"}
          </summary>
          <pre className="px-3 py-2 text-xs text-[#ccc] overflow-x-auto whitespace-pre-wrap border-t border-[#333] max-h-48">
            {message.content}
          </pre>
        </details>
      </div>
    );
  }

  if (message.role === "system") {
    return (
      <div className="mb-3 text-center">
        <span className="text-xs text-[#666] italic">{message.content}</span>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] bg-[#1a1a1a] border border-[#333] px-4 py-2.5 rounded-2xl rounded-bl-sm text-sm whitespace-pre-wrap text-[#e5e5e5]">
        <AssistantContent content={message.content} />
      </div>
    </div>
  );
}

function AssistantContent({ content }: { content: string }) {
  // Basic rendering: preserve code blocks, render inline code
  const parts = content.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const inner = part.slice(3, -3);
          const newlineIdx = inner.indexOf("\n");
          const code = newlineIdx >= 0 ? inner.slice(newlineIdx + 1) : inner;
          return (
            <pre
              key={i}
              className="bg-[#0a0a0a] border border-[#333] rounded px-3 py-2 my-2 text-xs overflow-x-auto"
            >
              {code}
            </pre>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="bg-[#0a0a0a] px-1.5 py-0.5 rounded text-xs">
              {part.slice(1, -1)}
            </code>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

interface StreamingMessageProps {
  text: string;
}

export function StreamingMessage({ text }: StreamingMessageProps) {
  if (!text) return null;

  return (
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] bg-[#1a1a1a] border border-[#333] px-4 py-2.5 rounded-2xl rounded-bl-sm text-sm whitespace-pre-wrap text-[#e5e5e5]">
        {text}
        <span className="inline-block w-2 h-4 bg-blue-400 ml-0.5 animate-pulse" />
      </div>
    </div>
  );
}
