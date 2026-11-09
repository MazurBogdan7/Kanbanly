import { X } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";

import { t, useT } from "@/i18n";
import { ApiError } from "@/lib/api/client";

import { Button, cx } from "./index";

interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

interface ToastState {
  items: ToastItem[];
  push: (toast: Omit<ToastItem, "id">) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (toast) =>
    set((state) => ({ items: [...state.items.slice(-3), { ...toast, id: nextId++ }] })),
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}));

export const toast = {
  info: (message: string, action?: ToastItem["action"]) =>
    useToasts.getState().push({ message, tone: "info", action }),
  error: (error: unknown) =>
    useToasts.getState().push({
      message:
        error instanceof ApiError
          ? (error.problems[0]?.message ?? error.message)
          : t("common.error"),
      tone: "error",
    }),
};

function ToastView({ item }: { item: ToastItem }) {
  const { t } = useT();
  const dismiss = useToasts((state) => state.dismiss);
  useEffect(() => {
    const timer = setTimeout(() => dismiss(item.id), item.action ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [dismiss, item.action, item.id]);
  return (
    <div
      className={cx(
        "anim-pop flex items-center gap-3 rounded-md border bg-panel px-3 py-2 text-sm shadow-pop",
        item.tone === "error" ? "border-danger text-danger" : "border-line text-ink",
      )}
    >
      <span className="min-w-0 flex-1">{item.message}</span>
      {item.action && (
        <Button
          size="sm"
          onClick={() => {
            item.action?.run();
            dismiss(item.id);
          }}
        >
          {item.action.label}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label={t("common.close")}
        onClick={() => dismiss(item.id)}
      >
        <X className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}

export function Toaster() {
  const items = useToasts((state) => state.items);
  return (
    <div
      aria-live="polite"
      className="fixed right-4 bottom-20 z-[60] grid w-[min(380px,calc(100vw-32px))] gap-2 md:bottom-4"
    >
      {items.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
    </div>
  );
}
