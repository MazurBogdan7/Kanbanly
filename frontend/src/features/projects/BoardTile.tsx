/** Плитка доски с живой миниатюрой: настоящая тема, колонки и первые карточки. */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useT } from "@/i18n";
import { api } from "@/lib/api/client";
import type { BoardPreview, BoardSummary } from "@/lib/api/types";

import { keys } from "../boards/api";
import { BoardMiniature } from "../templates/TemplateThumbnail";

/** Миниатюра грузится, только когда плитка подходит к экрану. */
function useNearScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || near) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return { ref, near };
}

/** Заглушка до загрузки: цвета темы доски и силуэт колонок. */
function Placeholder({ colors }: { colors: Record<string, string> }) {
  return (
    <div
      aria-hidden
      className="flex w-full gap-1.5 overflow-hidden rounded-sm border border-line p-2"
      style={{ background: colors.bg, aspectRatio: "16 / 10" }}
    >
      {[0.9, 0.6, 0.4, 0.7].map((height) => (
        <span
          key={height}
          className="flex-1 rounded-sm"
          style={{
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            height: `${height * 100}%`,
          }}
        >
          <span className="m-1 block h-1 rounded-sm" style={{ background: colors.accent }} />
        </span>
      ))}
    </div>
  );
}

export function BoardTile({ board }: { board: BoardSummary }) {
  const { plural } = useT();
  const { ref, near } = useNearScreen<HTMLAnchorElement>();
  const preview = useQuery({
    queryKey: keys.preview(board.id),
    queryFn: () => api.get<BoardPreview>(`/boards/${board.id}/preview`),
    enabled: near,
    staleTime: 60_000,
  });
  return (
    <Link
      ref={ref}
      to="/boards/$boardId"
      params={{ boardId: board.id }}
      data-testid="board-tile"
      className="group grid min-w-0 content-start gap-2 rounded-lg border border-line bg-panel p-2 transition-[box-shadow,border-color] duration-[var(--dur-base)] hover:border-line-strong hover:shadow-panel focus-visible:outline-2 focus-visible:outline-brand"
    >
      {preview.data ? (
        <BoardMiniature
          name={preview.data.name}
          config={preview.data.config}
          cards={preview.data.cards}
          testId="board-thumbnail"
        />
      ) : (
        <Placeholder colors={board.colors} />
      )}
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="truncate text-sm font-medium group-hover:text-brand">{board.name}</span>
        {board.is_favorite && <Star className="size-3.5 shrink-0 text-warning" aria-hidden />}
      </div>
      <span className="px-1 pb-1 text-xs text-ink-soft">
        {plural("plural.cards", board.card_count)} · {plural("plural.columns", board.column_count)}
      </span>
    </Link>
  );
}

/** Резиновая сетка плиток: столько колонок, сколько помещается. */
export const TILE_GRID =
  "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr))]";
