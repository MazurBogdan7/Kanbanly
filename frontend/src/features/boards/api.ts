/** Серверное состояние досок и оптимистичные операции над карточками. */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { generateKeyBetween } from "fractional-indexing";

import { toast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type {
  BoardConfig,
  BoardOut,
  CardDetail,
  CardEventOut,
  CardOut,
  Page,
  ProjectOut,
} from "@/lib/api/types";
import { useUndo } from "@/lib/undo";

export const keys = {
  me: ["me"] as const,
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  board: (id: string) => ["boards", id] as const,
  cards: (id: string) => ["boards", id, "cards"] as const,
  card: (id: string) => ["cards", id] as const,
  activity: (id: string) => ["cards", id, "activity"] as const,
  templates: ["templates"] as const,
  presets: ["presets"] as const,
  trash: ["trash"] as const,
  sessions: ["sessions"] as const,
  backups: ["backups"] as const,
};

export function useProjects() {
  return useQuery({
    queryKey: keys.projects,
    queryFn: () => api.get<Page<ProjectOut>>("/projects", { limit: 200 }),
    select: (page) => page.items,
  });
}

export function useProject(id: string) {
  return useQuery({
    queryKey: keys.project(id),
    queryFn: () => api.get<ProjectOut>(`/projects/${id}`),
  });
}

export function useBoard(id: string) {
  return useQuery({ queryKey: keys.board(id), queryFn: () => api.get<BoardOut>(`/boards/${id}`) });
}

async function fetchAllCards(boardId: string): Promise<CardOut[]> {
  const cards: CardOut[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.get<Page<CardOut>>(`/boards/${boardId}/cards`, { cursor, limit: 500 });
    cards.push(...page.items);
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return cards;
}

export function useCards(boardId: string) {
  return useQuery({ queryKey: keys.cards(boardId), queryFn: () => fetchAllCards(boardId) });
}

export function useCardDetail(id: string | null) {
  return useQuery({
    queryKey: keys.card(id ?? ""),
    queryFn: () => api.get<CardDetail>(`/cards/${id}`),
    enabled: !!id,
  });
}

export function useCardActivity(id: string | null) {
  return useQuery({
    queryKey: keys.activity(id ?? ""),
    queryFn: () => api.get<Page<CardEventOut>>(`/cards/${id}/activity`),
    enabled: !!id,
    select: (page) => page.items,
  });
}

export interface MoveInput {
  cardId: string;
  column: string;
  beforeId: string | null;
  afterId: string | null;
}

function replaceCard(cards: CardOut[], next: CardOut): CardOut[] {
  return cards.map((card) => (card.id === next.id ? next : card));
}

function optimisticPosition(cards: CardOut[], move: MoveInput): string {
  const position = (id: string | null) => cards.find((card) => card.id === id)?.position ?? null;
  const low = position(move.beforeId);
  const high = position(move.afterId);
  try {
    if (low === null && high === null) {
      const last = cards
        .filter((card) => card.column === move.column && card.id !== move.cardId)
        .map((card) => card.position)
        .sort()
        .at(-1);
      return generateKeyBetween(last ?? null, null);
    }
    return generateKeyBetween(low, high);
  } catch {
    return cards.find((card) => card.id === move.cardId)?.position ?? "a0";
  }
}

function neighbours(
  cards: CardOut[],
  card: CardOut,
): { before: string | null; after: string | null } {
  const column = cards
    .filter((item) => item.column === card.column)
    .sort((a, b) => (a.position < b.position ? -1 : 1));
  const index = column.findIndex((item) => item.id === card.id);
  return { before: column[index - 1]?.id ?? null, after: column[index + 1]?.id ?? null };
}

export function useMoveCard(boardId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (move: MoveInput) =>
      api.post<CardOut>(`/cards/${move.cardId}/move`, {
        column: move.column,
        before_id: move.beforeId,
        after_id: move.afterId,
      }),
    onMutate: async (move) => {
      await queryClient.cancelQueries({ queryKey: keys.cards(boardId) });
      const previous = queryClient.getQueryData<CardOut[]>(keys.cards(boardId));
      queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) =>
        cards.map((card) =>
          card.id === move.cardId
            ? { ...card, column: move.column, position: optimisticPosition(cards, move) }
            : card,
        ),
      );
      return { previous };
    },
    onError: (error, _move, context) => {
      queryClient.setQueryData(keys.cards(boardId), context?.previous);
      toast.error(error);
      void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
    },
    onSuccess: (card) => {
      queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) =>
        replaceCard(cards, card),
      );
      void queryClient.invalidateQueries({ queryKey: keys.activity(card.id) });
    },
  });

  return (move: MoveInput) => {
    const cards = queryClient.getQueryData<CardOut[]>(keys.cards(boardId)) ?? [];
    const card = cards.find((item) => item.id === move.cardId);
    if (card) {
      const origin = neighbours(cards, card);
      useUndo.getState().push({
        label: t("card.moved"),
        undo: () =>
          mutation.mutateAsync({
            cardId: card.id,
            column: card.column,
            beforeId: origin.before,
            afterId: origin.after,
          }),
      });
    }
    return mutation.mutateAsync(move).catch(() => undefined);
  };
}

export function useDeleteCard(boardId: string) {
  const queryClient = useQueryClient();
  return (card: CardOut) => {
    queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) =>
      cards.filter((item) => item.id !== card.id),
    );
    const restore = async () => {
      const restored = await api.post<CardOut>(`/cards/${card.id}/restore`);
      queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) => [
        ...cards,
        restored,
      ]);
    };
    api.delete(`/cards/${card.id}`).catch((error: unknown) => {
      toast.error(error);
      void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
    });
    useUndo.getState().push({ label: t("card.deleted"), undo: restore });
    toast.info(t("card.deleted"), {
      label: t("common.undo"),
      run: () => void useUndo.getState().undo(),
    });
  };
}

export function useCreateCard(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post<CardOut>(`/boards/${boardId}/cards`, payload),
    onMutate: async (payload) => {
      await queryClient.cancelQueries({ queryKey: keys.cards(boardId) });
      const previous = queryClient.getQueryData<CardOut[]>(keys.cards(boardId));
      const now = new Date().toISOString();
      const id = `temp-${crypto.randomUUID()}`;
      queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) => {
        const positions = cards
          .filter((card) => card.column === payload.column)
          .map((card) => card.position)
          .sort();
        return [
          ...cards,
          {
            id,
            board_id: boardId,
            column: String(payload.column),
            title: String(payload.title),
            description: String(payload.description ?? ""),
            position: generateKeyBetween(positions.at(-1) ?? null, null),
            version: 1,
            due_date: null,
            completed_at: null,
            cover_url: null,
            values: {},
            fields: {},
            checklist_done: 0,
            checklist_total: 0,
            comments_count: 0,
            attachments_count: 0,
            created_at: now,
            updated_at: now,
          },
        ];
      });
      return { previous, id };
    },
    onError: (error, _payload, context) => {
      queryClient.setQueryData(keys.cards(boardId), context?.previous);
      toast.error(error);
    },
    onSuccess: (card, _payload, context) => {
      queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) =>
        cards.map((item) => (item.id === context.id ? card : item)),
      );
    },
  });
}

export function useSaveConfig(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ config, version }: { config: BoardConfig; version: number }) =>
      api.put<BoardOut>(`/boards/${boardId}/config`, config, { ifMatch: version }),
    onSuccess: (board) => {
      queryClient.setQueryData(keys.board(boardId), board);
      void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
      for (const warning of board.warnings ?? []) toast.info(warning);
    },
  });
}

export function refreshBoard(queryClient: QueryClient, boardId: string) {
  void queryClient.invalidateQueries({ queryKey: keys.board(boardId) });
}

export function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}
