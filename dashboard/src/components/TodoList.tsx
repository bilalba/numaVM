export interface TodoItem {
  id: string;
  content: string;
  status: string;
  priority: string;
}

interface TodoListProps {
  items: TodoItem[];
}

export function TodoList({ items }: TodoListProps) {
  if (items.length === 0) return null;

  const completed = items.filter((i) => i.status === "completed").length;

  return (
    <div className="border border-neutral-200 mb-2">
      <div className="px-3 py-1.5 border-b border-neutral-100 flex items-center justify-between">
        <span className="text-xs font-semibold">Tasks</span>
        <span className="text-[10px] text-neutral-500">
          {completed}/{items.length}
        </span>
      </div>
      <div className="px-3 py-1.5 space-y-1">
        {items.map((item) => (
          <div key={item.id} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0">
              {item.status === "completed" ? (
                <svg className="w-3.5 h-3.5 text-green-600" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="8" cy="8" r="6" />
                  <path d="M5.5 8l2 2 3.5-3.5" />
                </svg>
              ) : item.status === "in_progress" ? (
                <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-yellow-500 relative">
                  <span className="absolute inset-[3px] rounded-full bg-yellow-500 animate-[pulseDot_1s_ease-in-out_infinite]" />
                </span>
              ) : (
                <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-neutral-300" />
              )}
            </span>
            <span
              className={`text-xs leading-snug ${
                item.status === "completed"
                  ? "line-through text-neutral-400"
                  : "text-foreground"
              }`}
            >
              {item.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
