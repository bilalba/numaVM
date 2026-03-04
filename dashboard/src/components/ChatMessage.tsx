import type { AgentMessage } from "../lib/api";

interface ChatMessageProps {
  message: AgentMessage;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const metadata = message.metadata ? JSON.parse(message.metadata) : null;

  if (message.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[80%] bg-white border border-neutral-200 px-4 py-2.5 text-sm whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="mb-3 ml-2">
        <details className="border border-neutral-200 overflow-hidden">
          <summary className="px-3 py-2 text-xs text-neutral-500 cursor-pointer transition-opacity hover:opacity-60">
            Tool: {metadata?.tool || "unknown"}
          </summary>
          <pre className="px-3 py-2 text-xs text-neutral-600 overflow-x-auto whitespace-pre-wrap border-t border-neutral-100 max-h-48 bg-white">
            {message.content}
          </pre>
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
    <div className="flex justify-start mb-3">
      <div className="max-w-[80%] border border-neutral-100 bg-[#faf7f2] px-4 py-2.5 text-sm whitespace-pre-wrap">
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
              className="bg-white border border-neutral-200 px-3 py-2 my-2 text-xs overflow-x-auto"
            >
              {code}
            </pre>
          );
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} className="bg-white border border-neutral-100 px-1.5 py-0.5 text-xs">
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
      <div className="max-w-[80%] border border-neutral-100 bg-[#faf7f2] px-4 py-2.5 text-sm whitespace-pre-wrap">
        {text}
        <span className="inline-block w-1.5 h-3.5 bg-black ml-0.5 animate-[pulseDot_1s_ease-in-out_infinite]" />
      </div>
    </div>
  );
}
