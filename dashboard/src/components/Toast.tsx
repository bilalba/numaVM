import { createContext, useCallback, useContext, useState, useRef, useEffect, type ReactNode } from "react";

type ToastType = "error" | "success" | "info";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

const ACCENT: Record<ToastType, string> = {
  error: "border-l-red-500",
  success: "border-l-green-500",
  info: "border-l-blue-500",
};

const DISMISS_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <ToastCard key={t.id} item={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(item.id), DISMISS_MS);
    return () => clearTimeout(timer);
  }, [item.id, onDismiss]);

  return (
    <div
      className={`bg-[#1a1a1a] border border-[#333] border-l-4 ${ACCENT[item.type]} rounded px-4 py-3 text-sm text-[#e5e5e5] shadow-lg flex items-start gap-2 animate-[slideIn_0.2s_ease-out]`}
    >
      <span className="flex-1 break-words">{item.message}</span>
      <button
        onClick={() => onDismiss(item.id)}
        className="text-[#666] hover:text-[#e5e5e5] shrink-0 cursor-pointer leading-none text-lg"
      >
        &times;
      </button>
    </div>
  );
}
