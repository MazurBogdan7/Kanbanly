import type { BoardConfig, CardOut } from "@/lib/api/types";

export const config: BoardConfig = {
  theme: { mode: "dark", tokens: { accent: "#C9A84C", bg: "#0A0A0A", "brand-x": "#123456" } },
  columns: [
    { key: "todo", name: "К работе", kind: "todo", wip_limit: 1 },
    { key: "doing", name: "В работе", kind: "in_progress" },
    {
      key: "done",
      name: "Готово",
      kind: "done",
      card_style: { opacity: 0.65, title_strikethrough: true, strikethrough_color: "{border}" },
    },
  ],
  dimensions: [
    {
      key: "epic",
      name: "Эпик",
      required: true,
      values: [
        { key: "a", name: "Альфа", color: "#C9A84C", icon: "⚙️" },
        { key: "b", name: "Бета", color: "#FFFFFF" },
      ],
    },
    {
      key: "ms",
      name: "Веха",
      type: "ordered_select",
      values: [
        {
          key: "m1",
          name: "M1 · Срез",
          short: "M1",
          hint: "Подсказка",
          badge: { bg: "#111111", fg: "#EEEEEE" },
        },
        { key: "m2", name: "M2 · Альфа", short: "M2" },
      ],
    },
    {
      key: "who",
      name: "Исполнитель",
      type: "user",
      empty_value: "none",
      hide_empty: true,
      values: [
        { key: "none", name: "—" },
        { key: "ann", name: "Анна Белова" },
      ],
    },
  ],
  fields: [
    { key: "pts", name: "Оценка", type: "number", show_on_face: true, format: "sp" },
    { key: "due", name: "Дата", type: "date" },
  ],
  layout: {
    header: {
      subtitle: "Подзаголовок",
      widgets: [
        { type: "progress_by_dimension", dimension: "ms" },
        { type: "filter_bar", search: true, selects: ["ms"] },
        { type: "filter_chips", dimension: "epic" },
        { type: "stats", metrics: ["total", "in_progress", "overdue", "wip_exceeded"] },
        { type: "note", text: "Заметка" },
        { type: "legend", dimension: "epic" },
      ],
    },
    card: {
      accent: { source: "dimension:epic", style: "left-border", width: 3 },
      face: [
        "title",
        "description",
        "badges",
        "fields",
        "assignees",
        "due_date",
        "checklist_progress",
        "comments_count",
        "custom_text",
      ],
      custom_text: "Свой текст",
      badges: [
        { dimension: "ms", display: "short", style: "per-value" },
        { dimension: "epic", display: "icon+name", style: "neutral" },
        { dimension: "who", display: "name", style: "outlined" },
      ],
    },
  },
  rules: [
    { key: "w", type: "highlight_wip_exceeded" },
    { key: "m", type: "warn_missing_required" },
  ],
  views: [{ key: "t", name: "Таблица", type: "table", group_by: "ms" }],
};

export function card(overrides: Partial<CardOut> = {}): CardOut {
  return {
    id: "c1",
    board_id: "b",
    column: "todo",
    title: "Карточка",
    description: "Описание",
    position: "a0",
    version: 1,
    due_date: null,
    completed_at: null,
    cover_url: null,
    values: { epic: ["a"], ms: ["m1"], who: ["ann"] },
    fields: { pts: 5 },
    checklist_done: 1,
    checklist_total: 2,
    comments_count: 3,
    attachments_count: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
