import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ALL_ROLES,
  applyDensity,
  contrastReport,
  PALETTES,
  removeDimension,
  removeField,
  rolesOf,
  setRole,
} from "@/features/settings/config-ops";
import { isDirty, useDraft } from "@/features/settings/draft";
import { CardTab, HeaderTab, ThemeTab, TypographyTab } from "@/features/settings/tabs-look";
import { ColumnsTab, DimensionsTab, FieldsTab, RulesTab } from "@/features/settings/tabs-structure";
import type { BoardConfig } from "@/lib/api/types";

import { config } from "./fixtures";

const clone = (): BoardConfig => structuredClone(config);

describe("роли измерений", () => {
  it("вычисляются из раскладки", () => {
    const current = clone();
    expect(rolesOf(current, "epic")).toEqual(["accent", "badge", "filter_chips", "legend"]);
    expect(rolesOf(current, "ms")).toEqual(["badge", "filter_select", "progress", "table_group"]);
  });

  it.each(ALL_ROLES)("%s включается и выключается симметрично", (role) => {
    const current = clone();
    const key = "who";
    setRole(current, key, role, true);
    expect(rolesOf(current, key)).toContain(role);
    setRole(current, key, role, false);
    expect(rolesOf(current, key)).not.toContain(role);
  });

  it("выключение роли убирает виджет", () => {
    const current = clone();
    const count = current.layout!.header!.widgets!.length;
    setRole(current, "ms", "progress", false);
    expect(current.layout!.header!.widgets).toHaveLength(count - 1);
    expect(current.layout!.header!.widgets!.some((w) => w.type === "progress_by_dimension")).toBe(
      false,
    );
  });

  it("создаёт панель фильтров, если её нет", () => {
    const current = clone();
    current.layout!.header!.widgets = [];
    setRole(current, "epic", "filter_select", true);
    expect(current.layout!.header!.widgets![0]).toMatchObject({
      type: "filter_bar",
      selects: ["epic"],
    });
  });

  it("включение бейджа добавляет слот на лицо карточки", () => {
    const current = clone();
    current.layout!.card!.face = ["title"];
    setRole(current, "who", "badge", true);
    expect(current.layout!.card!.face).toContain("badges");
  });

  it("удаление измерения и поля снимает все ссылки", () => {
    const current = clone();
    current.layout!.editor = { fields: ["title", "epic", "pts"] };
    removeDimension(current, "epic");
    expect(rolesOf(current, "epic")).toEqual([]);
    expect(current.dimensions!.some((item) => item.key === "epic")).toBe(false);
    expect(current.layout!.card!.accent!.source).toBe("none");
    current.layout!.card!.accent!.source = "field:pts";
    removeField(current, "pts");
    expect(current.layout!.card!.accent!.source).toBe("none");
    expect(current.layout!.editor.fields).toEqual(["title"]);
  });
});

describe("плотность и контраст", () => {
  it("плотность — пресет, который меняет геометрию", () => {
    const current = clone();
    applyDensity(current, "compact");
    expect(current.layout!.card!.padding).toEqual([6, 8]);
    expect(current.theme!.density).toBe("compact");
  });

  it("находит нечитаемые пары", () => {
    const current = clone();
    current.theme = { tokens: { text: "#777777", bg: "#777777" } };
    expect(contrastReport(current).map((issue) => issue.pair)).toContain("Текст / фон доски");
  });

  it("проверяет бейджи значений", () => {
    const current = clone();
    current.dimensions![0]!.values![0]!.badge = { bg: "#222222", fg: "#333333" };
    expect(contrastReport(current).some((issue) => issue.pair === "Бейдж «Альфа»")).toBe(true);
  });

  it.each(PALETTES.map((palette) => [palette.name, palette] as const))(
    "готовая палитра «%s» проходит AA",
    (_, palette) => {
      const issues = contrastReport({
        columns: [{ key: "a", name: "A" }],
        theme: { tokens: palette.tokens },
      });
      expect(issues).toEqual([]);
    },
  );
});

describe("черновик конструктора", () => {
  beforeEach(() => useDraft.getState().open(clone()));

  it("undo/redo и признак изменений", () => {
    const state = () => useDraft.getState();
    expect(isDirty(state())).toBe(false);
    state().change((draft) => {
      draft.columns[0]!.name = "Новое";
    });
    expect(isDirty(state())).toBe(true);
    expect(state().draft!.columns[0]!.name).toBe("Новое");
    state().undo();
    expect(state().draft!.columns[0]!.name).toBe("К работе");
    expect(isDirty(state())).toBe(false);
    state().redo();
    expect(state().draft!.columns[0]!.name).toBe("Новое");
    state().markSaved(state().draft!);
    expect(isDirty(state())).toBe(false);
  });

  it("новое изменение сбрасывает redo", () => {
    const state = () => useDraft.getState();
    state().change((draft) => {
      draft.columns[0]!.name = "1";
    });
    state().undo();
    state().change((draft) => {
      draft.columns[0]!.name = "2";
    });
    expect(state().future).toEqual([]);
  });
});

describe("вкладки конструктора", () => {
  beforeEach(() => useDraft.getState().open(clone()));
  const draft = () => useDraft.getState().draft!;

  it("«Карточка»: убирает и добавляет слоты лицевой стороны", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<CardTab config={draft()} />);
    await user.click(screen.getAllByRole("button", { name: "Убрать: Описание" })[0]!);
    expect(draft().layout!.card!.face).not.toContain("description");
    rerender(<CardTab config={draft()} />);
    await user.click(screen.getByRole("button", { name: "+ Описание" }));
    expect(draft().layout!.card!.face!.at(-1)).toBe("description");
  });

  it("«Карточка»: меняет источник и стиль акцента", async () => {
    const user = userEvent.setup();
    render(<CardTab config={draft()} />);
    await user.selectOptions(screen.getAllByLabelText("Источник")[0]!, "column");
    expect(draft().layout!.card!.accent!.source).toBe("column");
  });

  it("«Шапка»: выключает виджет, не удаляя его", async () => {
    const user = userEvent.setup();
    render(<HeaderTab config={draft()} />);
    await user.click(screen.getByRole("switch", { name: "Прогресс по измерению" }));
    expect(draft().layout!.header!.widgets![0]).toMatchObject({ enabled: false });
  });

  it("«Шапка»: добавляет заметку", async () => {
    const user = userEvent.setup();
    render(<HeaderTab config={draft()} />);
    await user.click(screen.getByRole("button", { name: "+ Счётчики" }));
    expect(draft().layout!.header!.widgets!.at(-1)?.type).toBe("stats");
  });

  it("«Колонки»: добавляет и удаляет", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ColumnsTab config={draft()} />);
    await user.click(screen.getByRole("button", { name: "Добавить колонку" }));
    expect(draft().columns).toHaveLength(4);
    rerender(<ColumnsTab config={draft()} />);
    await user.click(screen.getByRole("button", { name: "Удалить: Новая колонка" }));
    expect(draft().columns).toHaveLength(3);
  });

  it("«Измерения»: чекбокс роли меняет раскладку", async () => {
    const user = userEvent.setup();
    render(<DimensionsTab config={draft()} />);
    const block = screen
      .getByRole("button", { name: "Удалить: Веха" })
      .closest("div.grid") as HTMLElement;
    const progress = within(block.parentElement as HTMLElement).getByLabelText("Виджет прогресса");
    expect(progress).toBeChecked();
    await user.click(progress);
    expect(rolesOf(draft(), "ms")).not.toContain("progress");
  });

  it("«Поля»: добавляет поле", async () => {
    const user = userEvent.setup();
    render(<FieldsTab config={draft()} />);
    await user.click(screen.getByRole("button", { name: "Добавить поле" }));
    expect(draft().fields).toHaveLength(3);
  });

  it("«Правила»: включает правило из фиксированного набора", async () => {
    const user = userEvent.setup();
    render(<RulesTab config={draft()} />);
    await user.click(screen.getByRole("switch", { name: /проставить дату завершения/ }));
    expect(draft().rules!.some((rule) => rule.type === "set_completed_on_kind")).toBe(true);
  });

  it("«Тема»: палитра из галереи заменяет токены и показывает контраст", async () => {
    const user = userEvent.setup();
    render(<ThemeTab config={draft()} />);
    await user.click(screen.getByRole("button", { name: "Мята" }));
    expect(draft().theme!.tokens!.accent).toBe("#0B7A5E");
    expect(screen.getByTestId("contrast-report")).toBeInTheDocument();
  });

  it("«Типографика»: шрифты только из белого списка", () => {
    render(<TypographyTab config={draft()} />);
    const fonts = within(screen.getAllByLabelText("Шрифт")[0]!).getAllByRole("option", {
      hidden: true,
    });
    const names = fonts.map((option) => option.textContent);
    expect(names).toContain("Cormorant SC");
    expect(names).not.toContain("Comic Sans MS");
  });
});
