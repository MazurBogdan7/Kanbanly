/** Живая миниатюра: рендерит настоящий движок доски, уменьшенный CSS-трансформацией. */
import { useEffect, useMemo, useRef, useState } from "react";

import type { BoardConfig, BoardTemplate, CardOut } from "@/lib/api/types";

import { BoardCanvas } from "../boards/engine/BoardCanvas";
import { EMPTY_FILTERS } from "../boards/engine/model";

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 800;
const CARDS_PER_COLUMN = 6;

const NOOP = () => undefined;

export function cardsFromTemplate(template: BoardTemplate): CardOut[] {
  const perColumn = new Map<string, number>();
  const cards: CardOut[] = [];
  for (const sample of template.sample_cards ?? []) {
    const count = perColumn.get(sample.column) ?? 0;
    if (count >= CARDS_PER_COLUMN) continue;
    perColumn.set(sample.column, count + 1);
    const values = Object.fromEntries(
      Object.entries(sample.values ?? {}).map(([key, value]) => [
        key,
        Array.isArray(value) ? value : [value],
      ]),
    );
    cards.push({
      id: sample.key,
      board_id: "",
      column: sample.column,
      title: sample.title,
      description: sample.description ?? "",
      position: `a${String(cards.length).padStart(4, "0")}`,
      version: 1,
      due_date: sample.due_date ?? null,
      completed_at: null,
      cover_url: null,
      color: sample.color ?? null,
      tags: [],
      values,
      fields: sample.fields ?? {},
      checklist_done: 0,
      checklist_total: 0,
      comments_count: 0,
      attachments_count: 0,
      created_at: "",
      updated_at: "",
    });
  }
  return cards;
}

/** Ширина контейнера; null, пока элемент не измерен. */
function useWidth(fixed: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(fixed ?? null);
  useEffect(() => {
    if (fixed !== undefined) return;
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth || null);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fixed]);
  return { ref, width };
}

/**
 * Уменьшенная копия доски. Без `width` занимает всю ширину родителя (пропорции 16:10),
 * поэтому подходит для резиновых сеток.
 */
export function BoardMiniature({
  name,
  config,
  cards,
  width,
  testId = "template-thumbnail",
}: {
  name: string;
  config: BoardConfig;
  cards: CardOut[];
  width?: number;
  testId?: string;
}) {
  const { ref, width: measured } = useWidth(width);
  const scale = (measured ?? 0) / CANVAS_WIDTH;
  return (
    <div
      ref={ref}
      inert
      aria-hidden
      data-testid={testId}
      className="pointer-events-none relative overflow-hidden rounded-sm border border-line"
      style={
        width === undefined
          ? { width: "100%", aspectRatio: "16 / 10" }
          : { width, height: CANVAS_HEIGHT * (width / CANVAS_WIDTH) }
      }
    >
      {measured !== null && (
        <div
          className="absolute left-0 top-0"
          style={{
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          <BoardCanvas
            name={name}
            config={config}
            cards={cards}
            filters={EMPTY_FILTERS}
            onFilters={NOOP}
            thumbnail
          />
        </div>
      )}
    </div>
  );
}

export function TemplateThumbnail({
  template,
  width,
}: {
  template: BoardTemplate;
  width?: number;
}) {
  const cards = useMemo(() => cardsFromTemplate(template), [template]);
  return (
    <BoardMiniature
      name={template.meta.name}
      config={template as BoardConfig}
      cards={cards}
      width={width}
    />
  );
}
