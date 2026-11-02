import { describe, expect, it } from "vitest";

import {
  comparePosition,
  computeStat,
  EMPTY_FILTERS,
  filtersFromView,
  groupByColumn,
  groupCards,
  hasRule,
  isDone,
  isFiltering,
  isOverdue,
  matchesFilters,
  missingRequired,
  progressByDimension,
  sortCards,
} from "@/features/boards/engine/model";
import {
  backgroundCss,
  boardStyle,
  initialPalette,
  resolveColor,
  resolveHex,
  tokensOf,
} from "@/features/boards/engine/theme";

import { card, config } from "./fixtures";

describe("фильтры", () => {
  it("комбинируют измерения и поиск без учёта регистра", () => {
    const item = card({ title: "Валун и БРОСОК" });
    expect(matchesFilters(item, EMPTY_FILTERS)).toBe(true);
    expect(matchesFilters(item, { search: "бросок", dimensions: {} })).toBe(true);
    expect(matchesFilters(item, { search: "нет", dimensions: {} })).toBe(false);
    expect(matchesFilters(item, { search: "", dimensions: { epic: ["a", "b"] } })).toBe(true);
    expect(matchesFilters(item, { search: "", dimensions: { epic: ["b"] } })).toBe(false);
    expect(matchesFilters(item, { search: "", dimensions: { epic: [] } })).toBe(true);
  });

  it("определяют активность и берутся из представления", () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
    expect(isFiltering({ search: " x", dimensions: {} })).toBe(true);
    expect(isFiltering({ search: "", dimensions: { a: ["b"] } })).toBe(true);
    const view = { key: "v", name: "В", filters: { search: "q", dimensions: { epic: ["a"] } } };
    expect(filtersFromView(view)).toEqual({ search: "q", dimensions: { epic: ["a"] } });
    expect(filtersFromView(undefined)).toEqual(EMPTY_FILTERS);
  });
});

describe("группировка и порядок", () => {
  it("сортирует по fractional-ключу байтово", () => {
    const groups = groupByColumn(
      [
        card({ id: "1", position: "a1" }),
        card({ id: "2", position: "a0V" }),
        card({ id: "3", position: "Zz" }),
        card({ id: "4", column: "done", position: "a0" }),
      ],
      config.columns,
    );
    expect(groups.get("todo")?.map((item) => item.id)).toEqual(["3", "2", "1"]);
    expect(groups.get("done")?.length).toBe(1);
    expect(groups.get("doing")).toEqual([]);
    expect(comparePosition(card({ id: "a" }), card({ id: "b" }))).toBe(-1);
  });

  it("группирует по измерению и собирает карточки без значения", () => {
    const dimension = config.dimensions![1]!;
    const groups = groupCards([card({ id: "1" }), card({ id: "2", values: {} })], dimension);
    expect(groups.map((group) => [group.key, group.cards.length])).toEqual([
      ["m1", 1],
      ["m2", 0],
      ["__none", 1],
    ]);
    expect(groupCards([card()], undefined)[0]?.key).toBe("__all");
  });
});

describe("прогресс и статистика", () => {
  const cards = [
    card({ id: "1", column: "done" }),
    card({ id: "2", column: "todo" }),
    card({ id: "3", column: "todo", values: { ms: ["m2"] } }),
    card({ id: "4", column: "doing", due_date: "2000-01-01" }),
  ];

  it("считает готово по виду колонки и по конкретной колонке", () => {
    const rows = progressByDimension(cards, config.dimensions![1]!, "column_kind:done", config);
    expect(rows.map((row) => [row.value.key, row.done, row.total, row.percent])).toEqual([
      ["m1", 1, 3, 33],
      ["m2", 0, 1, 0],
    ]);
    expect(isDone(cards[1]!, "column:todo", config)).toBe(true);
    expect(isDone(cards[1]!, "column_kind:done", config)).toBe(false);
  });

  it("считает все метрики", () => {
    const today = "2026-06-01";
    expect(computeStat("total", cards, config, today)).toBe(4);
    expect(computeStat("in_progress", cards, config, today)).toBe(1);
    expect(computeStat("overdue", cards, config, today)).toBe(1);
    expect(computeStat("wip_exceeded", cards, config, today)).toBe(1);
    expect(isOverdue(card({ column: "done", due_date: "2000-01-01" }), config, today)).toBe(false);
  });

  it("находит незаполненные обязательные значения и правила", () => {
    expect(missingRequired(card({ values: {} }), config)).toEqual(["Эпик"]);
    expect(missingRequired(card(), config)).toEqual([]);
    expect(hasRule(config, "warn_missing_required")).toBe(true);
    expect(hasRule(config, "set_completed_on_kind")).toBe(false);
  });
});

describe("сортировка представления", () => {
  const cards = [
    card({ id: "1", title: "Б", values: { ms: ["m2"] }, fields: { pts: 1 } }),
    card({
      id: "2",
      title: "а",
      values: { ms: ["m1"] },
      fields: { pts: 9 },
      due_date: "2026-01-01",
    }),
  ];
  const ids = (by: string, direction: "asc" | "desc" = "asc") =>
    sortCards(cards, { key: "v", name: "В", sort: { by, direction } }, config).map(
      (item) => item.id,
    );

  it.each([
    ["title", "asc", ["2", "1"]],
    ["due_date", "asc", ["2", "1"]],
    ["dimension:ms", "asc", ["2", "1"]],
    ["field:pts", "desc", ["2", "1"]],
    ["created_at", "asc", ["1", "2"]],
  ] as const)("%s %s", (by, direction, expected) => {
    expect(ids(by, direction)).toEqual(expected);
  });

  it("без сортировки возвращает как есть", () => {
    expect(sortCards(cards, undefined, config)).toBe(cards);
  });
});

describe("тема", () => {
  it("превращает токены в переменные, а hex оставляет", () => {
    expect(resolveColor("{accent}")).toBe("var(--t-accent)");
    expect(resolveColor("#C9A84C")).toBe("#C9A84C");
    expect(resolveColor(null)).toBeUndefined();
  });

  it.each(["red", "url(x)", "#12", "{Accent}", "expression(alert(1))", "#123456;}"])(
    "не пропускает %s в стили",
    (value) => {
      expect(resolveColor(value)).toBeUndefined();
    },
  );

  it("находит hex токена для расчёта контраста", () => {
    const tokens = tokensOf(config);
    expect(resolveHex("{accent}", tokens)).toBe("#C9A84C");
    expect(resolveHex("{brand-x}", tokens)).toBe("#123456");
    expect(resolveHex("#000000", tokens)).toBe("#000000");
  });

  it("собирает все типы фона и отбрасывает небезопасный URL", () => {
    expect(backgroundCss({ type: "color", value: "{bg}" })).toBe("var(--t-bg)");
    expect(backgroundCss({ type: "linear-gradient", angle: 90, stops: ["#000000", "{bg}"] })).toBe(
      "linear-gradient(90deg, #000000, var(--t-bg))",
    );
    expect(backgroundCss({ type: "radial-gradient", stops: ["#000000", "#ffffff"] })).toContain(
      "radial",
    );
    expect(
      backgroundCss({ type: "image", url: "https://x.test/a.png", overlay_opacity: 0.5 }),
    ).toContain('url("https://x.test/a.png")');
    expect(backgroundCss({ type: "image", url: 'https://x.test/a"){}' })).toBeUndefined();
    expect(backgroundCss({ type: "image", url: "javascript:alert(1)" })).toBeUndefined();
    expect(backgroundCss(null)).toBeUndefined();
  });

  it("выставляет переменные палитры, типографики и геометрии", () => {
    const style = boardStyle({
      ...config,
      typography: { card_title: { font: "Manrope", size: 15, case: "upper", letter_spacing: 0.1 } },
      layout: { card: { padding: [1, 2], radius: 3 } },
    }) as Record<string, string>;
    expect(style["--t-accent"]).toBe("#C9A84C");
    expect(style["--t-brand-x"]).toBe("#123456");
    expect(style["--ty-card-title-font"]).toContain("Manrope");
    expect(style["--ty-card-title-size"]).toBe("15px");
    expect(style["--ty-card-title-case"]).toBe("uppercase");
    expect(style["--ty-card-title-spacing"]).toBe("0.1em");
    expect(style["--kb-card-pad-y"]).toBe("1px");
    expect(style["--kb-card-radius"]).toBe("3px");
  });

  it("выбирает вторую палитру только в режиме both при тёмной системе", () => {
    expect(initialPalette(config)).toBe("primary");
    const both = { ...config, theme: { mode: "both" as const, alt_tokens: { accent: "#000000" } } };
    expect(tokensOf(both, "alt").accent).toBe("#000000");
    window.matchMedia = (() => ({ matches: true })) as unknown as typeof window.matchMedia;
    expect(initialPalette(both)).toBe("alt");
  });
});
