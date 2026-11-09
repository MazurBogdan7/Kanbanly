/** Чистая логика доски: фильтры, группировка, прогресс, статистика, сортировка. */
import type {
  BoardConfig,
  CardOut,
  ColumnOverflow,
  ColumnTemplate,
  DimensionTemplate,
  DimensionValueTemplate,
  TagOut,
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

// ---------- длинные колонки ----------

export const OVERFLOW_DEFAULTS: Required<ColumnOverflow> = {
  enabled: true,
  threshold: 20,
  visible: 5,
  by: "auto",
};

export type OverflowSource =
  { type: "dimension"; dimension: DimensionTemplate } | { type: "tags" } | null;

export interface OverflowGroup {
  key: string;
  label: string | null;
  color: string | null;
  cards: CardOut[];
}

export function overflowSettings(config: BoardConfig): Required<ColumnOverflow> {
  return { ...OVERFLOW_DEFAULTS, ...(config.layout?.column?.overflow ?? {}) };
}

/**
 * По чему раскладывать хвост колонки. auto: измерение фильтр-чипов (это «теги» в шапке доски),
 * затем акцента карточки, затем первое неупорядоченное; если измерений нет — теги проекта.
 */
export function overflowSource(config: BoardConfig, cards: CardOut[]): OverflowSource {
  const by = overflowSettings(config).by;
  const dimensions = config.dimensions ?? [];
  const find = (key: string | undefined) => dimensions.find((item) => item.key === key);
  if (by === "tags") return { type: "tags" };
  if (by.startsWith("dimension:")) {
    const chosen = find(by.slice("dimension:".length));
    if (chosen) return { type: "dimension", dimension: chosen };
  }
  const widgets = config.layout?.header?.widgets ?? [];
  const chips = widgets.find((widget) => widget.type === "filter_chips") as
    { dimension?: string } | undefined;
  const accent = config.layout?.card?.accent?.source ?? "";
  const auto =
    find(chips?.dimension) ??
    (accent.startsWith("dimension:") ? find(accent.slice("dimension:".length)) : undefined) ??
    dimensions.find(
      (item) => item.type !== "ordered_select" && !item.ordered && item.type !== "user",
    );
  if (auto) return { type: "dimension", dimension: auto };
  if (cards.some((card) => (card.tags ?? []).length > 0)) return { type: "tags" };
  return dimensions[0] ? { type: "dimension", dimension: dimensions[0] } : null;
}

/**
 * Делит колонку на «голову» (первые visible карточек) и блоки по значению тега.
 * Карточка попадает в блок своего первого значения, чтобы не дублироваться.
 * Возвращает null, если колонка короткая или группировка выключена.
 */
export function splitOverflow(
  cards: CardOut[],
  config: BoardConfig,
  tags: Map<string, TagOut>,
  pinned: string | null = null,
): { head: CardOut[]; groups: OverflowGroup[] } | null {
  const settings = overflowSettings(config);
  if (!settings.enabled || cards.length <= settings.threshold) return null;
  const source = overflowSource(config, cards);
  const head = cards.slice(0, settings.visible);
  const rest = cards.slice(settings.visible);
  const order: { key: string; label: string; color: string | null }[] = [];
  const firstKey = (card: CardOut): string | undefined => {
    if (!source) return undefined;
    if (source.type === "tags") return (card.tags ?? []).find((id) => tags.has(id));
    const keys = card.values[source.dimension.key] ?? [];
    return (source.dimension.values ?? []).find((value) => keys.includes(value.key))?.key;
  };
  if (source?.type === "dimension") {
    for (const value of source.dimension.values ?? []) {
      order.push({ key: value.key, label: value.name, color: value.color ?? null });
    }
  } else if (source?.type === "tags") {
    for (const tag of tags.values()) order.push({ key: tag.id, label: tag.name, color: tag.color });
  }
  const buckets = new Map<string, CardOut[]>();
  const none: CardOut[] = [];
  for (const card of rest) {
    // Перетаскиваемая карточка всегда видна, иначе она исчезнет из-под курсора.
    if (card.id === pinned) {
      head.push(card);
      continue;
    }
    const key = firstKey(card);
    if (key === undefined) none.push(card);
    else buckets.set(key, [...(buckets.get(key) ?? []), card]);
  }
  const groups: OverflowGroup[] = order
    .filter((item) => buckets.has(item.key))
    .map((item) => ({ ...item, cards: buckets.get(item.key) ?? [] }));
  if (none.length) groups.push({ key: "__none", label: null, color: null, cards: none });
  return { head, groups };
}
