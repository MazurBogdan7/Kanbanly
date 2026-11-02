/** Черновик конструктора: live-preview, undo/redo, «грязное» состояние. */
import { create } from "zustand";

import type { BoardConfig } from "@/lib/api/types";

const HISTORY_LIMIT = 100;

interface DraftState {
  draft: BoardConfig | null;
  saved: string | null;
  past: BoardConfig[];
  future: BoardConfig[];
  open: (config: BoardConfig) => void;
  close: () => void;
  change: (update: (config: BoardConfig) => void) => void;
  replace: (config: BoardConfig) => void;
  undo: () => void;
  redo: () => void;
  markSaved: (config: BoardConfig) => void;
}

export const useDraft = create<DraftState>((set, get) => ({
  draft: null,
  saved: null,
  past: [],
  future: [],
  open: (config) =>
    set({ draft: structuredClone(config), saved: JSON.stringify(config), past: [], future: [] }),
  close: () => set({ draft: null, saved: null, past: [], future: [] }),
  change: (update) => {
    const { draft, past } = get();
    if (!draft) return;
    const next = structuredClone(draft);
    update(next);
    set({ draft: next, past: [...past.slice(-(HISTORY_LIMIT - 1)), draft], future: [] });
  },
  replace: (config) => {
    const { draft, past } = get();
    set({
      draft: structuredClone(config),
      past: draft ? [...past.slice(-(HISTORY_LIMIT - 1)), draft] : past,
      future: [],
    });
  },
  undo: () => {
    const { draft, past, future } = get();
    const previous = past.at(-1);
    if (!draft || !previous) return;
    set({ draft: previous, past: past.slice(0, -1), future: [draft, ...future] });
  },
  redo: () => {
    const { draft, past, future } = get();
    const [next, ...rest] = future;
    if (!draft || !next) return;
    set({ draft: next, past: [...past, draft], future: rest });
  },
  markSaved: (config) => set({ saved: JSON.stringify(config) }),
}));

export function isDirty(state: Pick<DraftState, "draft" | "saved">): boolean {
  return !!state.draft && JSON.stringify(state.draft) !== state.saved;
}
