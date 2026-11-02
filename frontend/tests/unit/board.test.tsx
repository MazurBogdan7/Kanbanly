import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { BoardCanvas } from "@/features/boards/engine/BoardCanvas";
import {
  accentColor,
  CardFace,
  cardShellProps,
  formatFieldValue,
  ValueBadge,
} from "@/features/boards/engine/CardFace";
import { normalizedWidgets } from "@/features/boards/engine/HeaderWidgets";
import { EMPTY_FILTERS, type Filters } from "@/features/boards/engine/model";
import { cardsFromTemplate } from "@/features/templates/TemplateThumbnail";
import type { BoardConfig, CardOut, FieldTemplate } from "@/lib/api/types";

import { card, config } from "./fixtures";

function Harness({
  cards,
  board = config,
  interactive,
}: {
  cards: CardOut[];
  board?: BoardConfig;
  interactive?: boolean;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  return (
    <BoardCanvas
      name="Доска"
      config={board}
      cards={cards}
      filters={filters}
      onFilters={setFilters}
      interactive={interactive}
    />
  );
}

describe("лицо карточки", () => {
  it("рендерит слоты в заданном порядке", () => {
    render(<CardFace card={card()} config={config} column={config.columns[0]} />);
    expect(screen.getByText("Карточка")).toBeInTheDocument();
    expect(screen.getByText("M1")).toBeInTheDocument();
    expect(screen.getByText("⚙️ Альфа")).toBeInTheDocument();
    expect(screen.getByText("Анна Белова")).toBeInTheDocument();
    expect(screen.getByText("5 sp")).toBeInTheDocument();
    expect(screen.getByText("АБ")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
    expect(screen.getByText("Свой текст")).toBeInTheDocument();
    const face = config.layout!.card!.face!;
    const reversed: BoardConfig = {
      ...config,
      layout: { ...config.layout, card: { ...config.layout!.card, face: [...face].reverse() } },
    };
    const { container } = render(
      <CardFace card={card()} config={reversed} column={config.columns[0]} />,
    );
    expect(container.firstElementChild).toHaveTextContent("Свой текст");
  });

  it("текст пользователя не интерпретируется как HTML", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <CardFace
        card={card({ title: payload, description: payload })}
        config={config}
        column={config.columns[0]}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getAllByText(payload)).toHaveLength(2);
  });

  it("скрывает пустое значение и значения из hide_values", () => {
    const { queryByText } = render(
      <CardFace
        card={card({ values: { who: ["none"], ms: ["m1"] } })}
        config={config}
        column={config.columns[0]}
      />,
    );
    expect(queryByText("—")).toBeNull();
  });

  it("предупреждает о незаполненном обязательном измерении", () => {
    render(<CardFace card={card({ values: {} })} config={config} column={config.columns[0]} />);
    expect(screen.getAllByText("Не заполнено: Эпик").length).toBeGreaterThan(0);
  });

  it("применяет зачёркивание колонки", () => {
    render(<CardFace card={card()} config={config} column={config.columns[2]} />);
    expect(screen.getByText("Карточка")).toHaveStyle({ textDecoration: "line-through" });
  });

  it("считает акцент по источникам", () => {
    expect(accentColor(card(), config, config.columns[0])).toBe("#C9A84C");
    const byColumn: BoardConfig = {
      ...config,
      layout: { card: { accent: { source: "column" } } },
    };
    expect(accentColor(card(), byColumn, { key: "x", name: "X", color: "{accent}" })).toBe(
      "var(--t-accent)",
    );
    const byField: BoardConfig = { ...config, layout: { card: { accent: { source: "field:c" } } } };
    expect(accentColor(card({ fields: { c: "#112233" } }), byField, undefined)).toBe("#112233");
  });

  it("колонка переопределяет стиль акцента и прозрачность", () => {
    const shell = cardShellProps(card(), config, {
      key: "x",
      name: "X",
      card_style: { accent_style: "dot", opacity: 0.5, mute_badges: true },
    });
    expect(shell["data-accent"]).toBe("dot");
    expect(shell["data-dim"]).toBe(true);
    expect((shell.style as Record<string, unknown>)["--kb-dim"]).toBe(0.5);
    expect(shell.style.opacity).toBeUndefined();
    expect(shell["data-mute-badges"]).toBe(true);
  });

  it("автотекст бейджа контрастен фону", () => {
    render(
      <ValueBadge
        value={{ key: "b", name: "Бета", color: "#FFFFFF" }}
        config={{ dimension: "epic", style: "per-value" }}
        tokens={{}}
      />,
    );
    expect(screen.getByText("Бета")).toHaveStyle({ color: "#111111" });
  });

  it.each([
    ["checkbox", true, "✓"],
    ["checkbox", false, null],
    ["rating", 3, "★★★"],
    ["progress", 40, "40%"],
    ["url", "https://a.test/x", "a.test/x"],
    ["date_range", { start: "a", end: "b" }, "a — b"],
    ["checklist", [{ text: "1", done: true }, { text: "2" }], "1/2"],
    ["attachment_link", { name: "Док", url: "https://a.test" }, "Док"],
    ["text", "", null],
  ] as const)("форматирует %s", (type, value, expected) => {
    const field: FieldTemplate = { key: "f", name: "Ф", type };
    expect(formatFieldValue(field, value)).toBe(expected);
  });
});

describe("канва доски", () => {
  const cards = [
    card({ id: "1", title: "Первая" }),
    card({
      id: "2",
      title: "Вторая",
      column: "done",
      position: "a1",
      values: { epic: ["b"], ms: ["m2"] },
    }),
    card({ id: "3", title: "Третья", column: "todo", position: "a2" }),
  ];

  it("собирается из конфигурации: колонки, счётчики, виджеты", () => {
    render(<Harness cards={cards} />);
    expect(screen.getByRole("heading", { name: /Доска/, level: 1 })).toHaveTextContent(
      "Подзаголовок",
    );
    expect(screen.getAllByRole("heading", { level: 2 }).map((item) => item.textContent)).toEqual([
      "К работе2/1",
      "В работе0",
      "Готово1",
    ]);
    expect(screen.getByTestId("progress-m1")).toHaveTextContent("0/2");
    expect(screen.getByTestId("progress-m2")).toHaveTextContent("1/1");
    expect(screen.getByTestId("stat-total")).toHaveTextContent("3");
    expect(screen.getByText("Заметка")).toBeInTheDocument();
  });

  it("подсвечивает превышение WIP только при включённом правиле", () => {
    const { container, rerender } = render(<Harness cards={cards} />);
    expect(container.querySelector('[data-key="todo"]')).toHaveAttribute("data-wip-exceeded");
    rerender(<Harness cards={cards} board={{ ...config, rules: [] }} />);
    expect(container.querySelector('[data-key="todo"]')).not.toHaveAttribute("data-wip-exceeded");
  });

  it("поиск и чипы фильтруют карточки, не меняя прогресс", async () => {
    const user = userEvent.setup();
    render(<Harness cards={cards} />);
    await user.type(screen.getByRole("searchbox"), "вторая");
    expect(screen.queryByText("Первая")).toBeNull();
    expect(screen.getByText("Вторая")).toBeInTheDocument();
    expect(screen.getByTestId("progress-m1")).toHaveTextContent("0/2");
    await user.clear(screen.getByRole("searchbox"));
    await user.click(screen.getByRole("button", { name: "Бета" }));
    expect(screen.getByRole("button", { name: "Бета" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Первая")).toBeNull();
  });

  it("селект фильтрует по значению", async () => {
    const user = userEvent.setup();
    render(<Harness cards={cards} />);
    await user.selectOptions(screen.getByRole("combobox", { name: "Все: Веха" }), "m2");
    expect(screen.queryByText("Первая")).toBeNull();
  });

  it("показывает текст пустой колонки", () => {
    render(<Harness cards={[]} />);
    expect(screen.getAllByText("Пусто")).toHaveLength(3);
  });

  it("дорожки группируют карточки по измерению", () => {
    const board: BoardConfig = {
      ...config,
      layout: { ...config.layout, board: { swimlanes: "ms" } },
    };
    render(<Harness cards={cards} board={board} />);
    expect(screen.getByRole("heading", { name: "M1 · Срез", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "M2 · Альфа", level: 3 })).toBeInTheDocument();
  });

  it("таблица группирует и открывает карточку", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <BoardCanvas
        name="Доска"
        config={config}
        cards={cards}
        filters={EMPTY_FILTERS}
        onFilters={() => undefined}
        view={config.views![0]}
        onOpen={onOpen}
      />,
    );
    const table = screen.getByRole("table");
    expect(within(table).getByText("M1 · Срез · 2")).toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Первая" }));
    expect(onOpen).toHaveBeenCalledWith(cards[0]);
  });

  it("календарь пока показан таблицей с пояснением", () => {
    render(
      <BoardCanvas
        name="Доска"
        config={config}
        cards={cards}
        filters={EMPTY_FILTERS}
        onFilters={() => undefined}
        view={{ key: "c", name: "К", type: "calendar" }}
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("сброс требует двойного нажатия", async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <BoardCanvas
        name="Доска"
        config={config}
        cards={[]}
        filters={EMPTY_FILTERS}
        onFilters={() => undefined}
        actions={{ onReset }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Сброс" }));
    expect(onReset).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Точно?" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("выключенные виджеты не показываются, заголовок и действия неявные", () => {
    const board: BoardConfig = {
      ...config,
      layout: { header: { widgets: [{ type: "note", text: "x", enabled: false }] } },
    };
    expect(normalizedWidgets(board).map((widget) => widget.type)).toEqual(["title", "actions"]);
  });

  it("быстрое создание по Enter в интерактивном режиме", async () => {
    const user = userEvent.setup();
    const onQuickAdd = vi.fn();
    const { container } = render(
      <BoardCanvas
        name="Доска"
        config={config}
        cards={[]}
        filters={EMPTY_FILTERS}
        onFilters={() => undefined}
        interactive
        onQuickAdd={onQuickAdd}
      />,
    );
    const column = container.querySelector('[data-key="doing"]') as HTMLElement;
    await user.click(within(column).getByRole("button", { name: "Добавить карточку" }));
    await user.keyboard("Новая задача{Enter}");
    expect(onQuickAdd).toHaveBeenCalledWith("doing", "Новая задача");
  });

  it("Enter и E на карточке открывают редактор", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const { container } = render(
      <BoardCanvas
        name="Доска"
        config={config}
        cards={cards}
        filters={EMPTY_FILTERS}
        onFilters={() => undefined}
        interactive
        onOpen={onOpen}
      />,
    );
    const first = container.querySelector('[data-card-id="1"]') as HTMLElement;
    first.focus();
    await user.keyboard("{Enter}");
    await user.keyboard("e");
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("сворачивание колонки", async () => {
    const user = userEvent.setup();
    const board: BoardConfig = {
      ...config,
      layout: { ...config.layout, column: { collapsible: true } },
    };
    const { container } = render(<Harness cards={cards} board={board} />);
    const column = container.querySelector('[data-key="todo"]') as HTMLElement;
    await user.click(within(column).getByRole("button", { name: "Свернуть колонку" }));
    expect(within(column).queryByText("Первая")).toBeNull();
  });
});

describe("миниатюра", () => {
  it("строит карточки из примеров шаблона с ограничением на колонку", () => {
    const samples = Array.from({ length: 20 }, (_, index) => ({
      key: `s${index}`,
      column: "todo",
      title: `К${index}`,
      values: { epic: "a", ms: ["m1"] },
    }));
    const cards = cardsFromTemplate({
      format: "kanbanly.board-template",
      version: 1,
      meta: { name: "T" },
      columns: config.columns,
      sample_cards: samples,
    });
    expect(cards).toHaveLength(6);
    expect(cards[0]?.values).toEqual({ epic: ["a"], ms: ["m1"] });
  });
});
