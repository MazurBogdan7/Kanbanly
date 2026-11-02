/** Живая миниатюра: рендерит настоящий движок доски, уменьшенный CSS-трансформацией. */
import { useMemo } from "react";

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

export function TemplateThumbnail({
  template,
  width = 320,
}: {
  template: BoardTemplate;
  width?: number;
}) {
  const scale = width / CANVAS_WIDTH;
  const cards = useMemo(() => cardsFromTemplate(template), [template]);
  const config = template as BoardConfig;
  return (
    <div
      inert
      aria-hidden
      data-testid="template-thumbnail"
      className="pointer-events-none overflow-hidden rounded-sm border border-line"
      style={{ width, height: CANVAS_HEIGHT * scale }}
    >
      <div
        style={{
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        <BoardCanvas
          name={template.meta.name}
          config={config}
          cards={cards}
          filters={EMPTY_FILTERS}
          onFilters={NOOP}
          thumbnail
        />
      </div>
    </div>
  );
}
