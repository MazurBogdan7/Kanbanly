import { describe, expect, it } from "vitest";

import { monthGrid } from "@/features/boards/engine/CalendarView";
import { timelineDimension } from "@/features/boards/engine/TimelineView";
import { applyLook } from "@/features/settings/config-ops";
import type { BoardConfig } from "@/lib/api/types";
import { isPrototypeExport, prototypeToSamples } from "@/lib/prototypeImport";

import { config } from "./fixtures";

describe("импорт из прототипа", () => {
  const board: BoardConfig = {
    columns: [
      { key: "backlog", name: "Бэклог" },
      { key: "done", name: "Готово" },
    ],
    dimensions: [
      {
        key: "epic",
        name: "Эпик",
        values: [
          { key: "core", name: "Валун" },
          { key: "art", name: "Арт" },
          { key: "narr", name: "Нарратив" },
        ],
      },
      {
        key: "milestone",
        name: "Веха",
        type: "ordered_select",
        values: [
          { key: "m1", name: "M1 · Срез", short: "M1" },
          { key: "m2", name: "M2 · Альфа", short: "M2" },
        ],
      },
      {
        key: "work_type",
        name: "Тип",
        values: [
          { key: "code", name: "Код" },
          { key: "art", name: "Арт" },
          { key: "narr", name: "Нарратив" },
        ],
      },
      {
        key: "assignee",
        name: "Исполнитель",
        values: [
          { key: "none", name: "—" },
          { key: "sergo", name: "SERGO" },
        ],
      },
    ],
  };
  const tasks = [
    { id: "t1", status: "done", epic: "core", ms: 1, type: "Код", who: "—", title: "А", desc: "Д" },
    { id: "t2", status: "backlog", epic: "art", ms: 2, type: "Арт", who: "SERGO", title: "Б" },
    { id: "t3", status: "Готово", epic: "narr", ms: 1, type: "Код", who: "—", title: "В" },
    { id: "t4", status: "архив", epic: "core", ms: 1, type: "Код", who: "—", title: "Г" },
  ];

  it("распознаёт формат", () => {
    expect(isPrototypeExport(tasks)).toBe(true);
    expect(isPrototypeExport([])).toBe(false);
    expect(isPrototypeExport({ format: "kanbanly.board-template" })).toBe(false);
    expect(isPrototypeExport([{ title: "x" }])).toBe(false);
  });

  it("сам сопоставляет поля с измерениями, даже когда названия значений пересекаются", () => {
    const { samples, mapping, skipped } = prototypeToSamples(tasks, board);
    expect(mapping).toEqual({ epic: "epic", ms: "milestone", type: "work_type", who: "assignee" });
    expect(skipped).toBe(1);
    expect(samples.map((sample) => [sample.column, sample.values])).toEqual([
      ["done", { epic: "core", milestone: "m1", work_type: "code", assignee: "none" }],
      ["backlog", { epic: "art", milestone: "m2", work_type: "art", assignee: "sergo" }],
      ["done", { epic: "narr", milestone: "m1", work_type: "code", assignee: "none" }],
    ]);
    expect(samples[0]?.description).toBe("Д");
  });
});

describe("оформление из другого шаблона", () => {
  it("переносит тему, шрифты и геометрию, но не структуру", () => {
    const source: BoardConfig = {
      columns: [{ key: "x", name: "X" }],
      theme: { mode: "dark", tokens: { accent: "#C9A84C" } },
      typography: { board_title: { font: "Cormorant SC" } },
      layout: {
        column: { radius: 2 },
        card: {
          radius: 14,
          shadow: "md",
          accent: { source: "dimension:other", style: "dot", width: 8 },
          badges: [{ dimension: "other" }],
        },
      },
    };
    const result = applyLook(config, source);
    expect(result.theme?.tokens?.accent).toBe("#C9A84C");
    expect(result.typography?.board_title?.font).toBe("Cormorant SC");
    expect(result.layout?.card?.radius).toBe(14);
    expect(result.layout?.card?.accent).toEqual({
      source: "dimension:epic",
      style: "dot",
      width: 8,
    });
    expect(result.layout?.card?.badges).toEqual(config.layout?.card?.badges);
    expect(result.layout?.header).toEqual(config.layout?.header);
    expect(result.columns).toBe(config.columns);
  });
});

describe("календарь и таймлайн", () => {
  it("сетка месяца начинается с понедельника и всегда шесть недель", () => {
    const grid = monthGrid(new Date(Date.UTC(2026, 10, 1)));
    expect(grid).toHaveLength(42);
    expect(grid[0]?.toISOString().slice(0, 10)).toBe("2026-10-26");
    expect(grid[0]?.getUTCDay()).toBe(1);
  });

  it("таймлайн берёт измерение из вида или первое упорядоченное", () => {
    expect(timelineDimension(config, undefined)?.key).toBe("ms");
    expect(timelineDimension(config, { key: "v", name: "V", group_by: "epic" })?.key).toBe("epic");
    expect(timelineDimension({ columns: [] }, undefined)).toBeUndefined();
  });
});
