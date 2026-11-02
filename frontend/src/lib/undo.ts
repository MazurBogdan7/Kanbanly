import { create } from "zustand";

import { toast } from "@/components/ui/toast";

export interface UndoEntry {
  label: string;
  undo: () => Promise<unknown>;
}

interface UndoState {
  stack: UndoEntry[];
  push: (entry: UndoEntry) => void;
  undo: () => Promise<void>;
  clear: () => void;
}

const LIMIT = 30;

export const useUndo = create<UndoState>((set, get) => ({
  stack: [],
  push: (entry) => set((state) => ({ stack: [...state.stack.slice(-(LIMIT - 1)), entry] })),
  undo: async () => {
    const entry = get().stack.at(-1);
    if (!entry) return;
    set((state) => ({ stack: state.stack.slice(0, -1) }));
    try {
      await entry.undo();
    } catch (error) {
      toast.error(error);
    }
  },
  clear: () => set({ stack: [] }),
}));
