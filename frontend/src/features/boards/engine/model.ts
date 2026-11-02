/** Чистая логика доски: фильтры, группировка, прогресс, статистика, сортировка. */
import type {
  BoardConfig,
  CardOut,
  ColumnTemplate,
  DimensionTemplate,
  DimensionValueTemplate,
  ViewTemplate,
} from "@/lib/api/types";

export interface Filters {
  search: string;
  dimensions: Record<string, string[]>;
}

export const EMPTY_FILTERS: Filters = { search: "", dimensions: {} };

export function isFiltering(filters: Filters): boolean {
  return (
    filters.search.trim() !== "" ||
    Object.values(filters.dimensions).some((keys) => keys.length > 0)
  );
}

export function matchesFilters(card: CardOut, filters: Filters): boolean {
  for (const [dimension, selected] of Object.entries(filters.dimensions)) {
    if (selected.length === 0) continue;
    const values = card.values[dimension] ?? [];
    if (!selected.some((key) => values.includes(key))) return false;
  }
  const query = filters.search.trim().toLowerCase();
  return !query || `${card.title} ${card.description}`.toLowerCase().includes(query);
}

export function filtersFromView(view: ViewTemplate | undefined): Filters {
  return {
    search: view?.filters?.search ?? "",
    dimensions: { ...view?.filters?.dimensions },
  };
}

export function comparePosition(a: CardOut, b: CardOut): number {
  if (a.position === b.position) return a.id < b.id ? -1 : 1;
  return a.position < b.position ? -1 : 1;
}

export function groupByColumn(cards: CardOut[], columns: ColumnTemplate[]): Map<string, CardOut[]> {
  const groups = new Map<string, CardOut[]>(columns.map((column) => [column.key, []]));
  for (const card of cards) groups.get(card.column)?.push(card);
  for (const list of groups.values()) list.sort(comparePosition);
  return groups;
}

export function isDone(card: CardOut, rule: string, config: BoardConfig): boolean {
  if (rule.startsWith("column:")) return card.column === rule.slice("column:".length);
  const kind = rule.startsWith("column_kind:") ? rule.slice("column_kind:".length) : "done";
  return config.columns.find((column) => column.key === card.column)?.kind === kind;
}

export interface ProgressRow {
  value: DimensionValueTemplate;
  done: number;
  total: number;
  percent: number;
}

export function progressByDimension(
  cards: CardOut[],
  dimension: DimensionTemplate,
  rule: string,
  config: BoardConfig,
): ProgressRow[] {
  return (dimension.values ?? []).map((value) => {
    const inValue = cards.filter((card) => card.values[dimension.key]?.includes(value.key));
    const done = inValue.filter((card) => isDone(card, rule, config)).length;
    const total = inValue.length;
    return { value, done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  });
}

export type StatMetric = "total" | "in_progress" | "overdue" | "wip_exceeded";

export function isOverdue(card: CardOut, config: BoardConfig, today: string): boolean {
  if (!card.due_date || card.due_date >= today) return false;
  return config.columns.find((column) => column.key === card.column)?.kind !== "done";
}

export function computeStat(
  metric: StatMetric,
  cards: CardOut[],
  config: BoardConfig,
  today: string,
): number {
  switch (metric) {
    case "total":
      return cards.length;
    case "in_progress": {
      const keys = new Set(
        config.columns.filter((c) => c.kind === "in_progress").map((c) => c.key),
      );
      return cards.filter((card) => keys.has(card.column)).length;
    }
    case "overdue":
      return cards.filter((card) => isOverdue(card, config, today)).length;
    case "wip_exceeded":
      return config.columns.filter(
        (column) =>
          column.wip_limit != null &&
          cards.filter((card) => card.column === column.key).length > column.wip_limit,
      ).length;
  }
}

export function hasRule(config: BoardConfig, type: string): boolean {
  return (config.rules ?? []).some((rule) => rule.type === type && rule.enabled !== false);
}

export function missingRequired(card: CardOut, config: BoardConfig): string[] {
  const missing = (config.dimensions ?? [])
    .filter((dimension) => dimension.required && !(card.values[dimension.key]?.length ?? 0))
    .map((dimension) => dimension.name);
  const fields = (config.fields ?? [])
    .filter((field) => field.required && card.fields[field.key] == null)
    .map((field) => field.name);
  return [...missing, ...fields];
}

export function sortCards(cards: CardOut[], view: ViewTemplate | undefined, config: BoardConfig) {
  const sort = view?.sort;
  if (!sort) return cards;
  const direction = sort.direction === "desc" ? -1 : 1;
  const key = (card: CardOut): string | number => {
    if (sort.by === "title") return card.title.toLowerCase();
    if (sort.by === "due_date") return card.due_date ?? "9999";
    if (sort.by === "created_at") return card.created_at;
    if (sort.by.startsWith("field:")) {
      const value = card.fields[sort.by.slice("field:".length)];
      return typeof value === "number" ? value : String(value ?? "");
    }
    const dimension = config.dimensions?.find(
      (item) => item.key === sort.by.slice("dimension:".length),
    );
    const selected = card.values[dimension?.key ?? ""]?.[0];
    const rank = dimension?.values?.findIndex((value) => value.key === selected) ?? -1;
    return rank < 0 ? Number.MAX_SAFE_INTEGER : rank;
  };
  return [...cards].sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === right) return 0;
    return (left < right ? -1 : 1) * direction;
  });
}

export function groupCards(
  cards: CardOut[],
  dimension: DimensionTemplate | undefined,
): { key: string; value: DimensionValueTemplate | null; cards: CardOut[] }[] {
  if (!dimension) return [{ key: "__all", value: null, cards }];
  const groups = (dimension.values ?? []).map((value) => ({
    key: value.key,
    value,
    cards: cards.filter((card) => card.values[dimension.key]?.includes(value.key)),
  }));
  const none = cards.filter((card) => !(card.values[dimension.key]?.length ?? 0));
  return none.length ? [...groups, { key: "__none", value: null, cards: none }] : groups;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
