/** Конструктор: критерий §5 — доску можно собрать только через UI. */
import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { api, column, createBoardViaApi, openBoard, register } from "./helpers";

async function openConstructor(page: Page) {
  await page.getByRole("button", { name: "Конструктор" }).click();
  return page.getByTestId("constructor");
}

test("доска с нуля через UI: экспорт совпадает с целевым JSON", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { name: "С нуля" });
  await openBoard(page, boardId);
  const panel = await openConstructor(page);

  // колонки
  await panel.getByRole("button", { name: "Добавить колонку" }).click();
  await panel.getByLabel("Название").last().fill("Проверка");
  const reviewRow = panel
    .getByRole("button", { name: "Удалить: Проверка" })
    .locator("xpath=ancestor::div[contains(@class,'rounded-md')][1]");
  await reviewRow.getByLabel("Вид колонки").selectOption("review");

  // измерение с ролями
  await panel.getByRole("tab", { name: "Измерения" }).click();
  await panel.getByRole("button", { name: "Добавить измерение" }).click();
  await panel.getByLabel("Название").first().fill("Приоритет");
  await panel.locator('input[data-role="accent"]').check();
  await panel.locator('input[data-role="badge"]').check();
  await panel.locator('input[data-role="filter_chips"]').check();
  await panel.locator('input[data-role="progress"]').check();
  await panel.getByText("Значения: 1").click();
  await panel.getByRole("button", { name: "Добавить значение" }).click();

  // поле
  await panel.getByRole("tab", { name: "Поля" }).click();
  await panel.getByRole("button", { name: "Добавить поле" }).click();
  await panel.getByLabel("Название").fill("Оценка");
  await panel.getByLabel("Тип поля").selectOption("number");
  await panel.getByRole("switch", { name: "Показывать на карточке" }).click();

  // лицо карточки и шапка
  await panel.getByRole("tab", { name: "Карточка" }).click();
  await panel.getByRole("button", { name: "+ Поля" }).click();
  await panel.getByRole("tab", { name: "Шапка" }).click();
  await panel.getByLabel("Подзаголовок").fill("Собрано вручную");
  await panel.getByRole("button", { name: "+ Счётчики" }).click();
  await panel.getByRole("tab", { name: "Правила" }).click();
  await panel.getByRole("switch", { name: /проставить дату завершения/ }).click();

  await panel.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText("Настройки применены")).toBeVisible();

  const client = await api(page);
  const template = await client.get<any>(`/boards/${boardId}/template`);
  expect(template.columns.map((item: any) => [item.name, item.kind])).toEqual([
    ["К работе", "todo"],
    ["В работе", "in_progress"],
    ["Готово", "done"],
    ["Проверка", "review"],
  ]);
  expect(template.dimensions).toHaveLength(1);
  const dimension = template.dimensions[0];
  expect(dimension.name).toBe("Приоритет");
  expect(dimension.values).toHaveLength(2);
  expect(dimension.roles).toEqual(["accent", "badge", "filter_chips", "progress"]);
  expect(template.fields).toEqual([
    expect.objectContaining({ name: "Оценка", type: "number", show_on_face: true }),
  ]);
  expect(template.layout.card.accent.source).toBe(`dimension:${dimension.key}`);
  expect(template.layout.card.face).toContain("fields");
  expect(template.layout.header.subtitle).toBe("Собрано вручную");
  expect(template.layout.header.widgets.map((widget: any) => widget.type)).toEqual([
    "filter_chips",
    "progress_by_dimension",
    "stats",
  ]);
  expect(template.rules[0].type).toBe("set_completed_on_kind");

  // экспорт импортируется в эквивалентную доску
  const cloneId = await createBoardViaApi(page, { name: "С нуля", template });
  const clone = await client.get<any>(`/boards/${cloneId}/template`);
  expect(clone).toEqual(template);
});

test("смена токена перекрашивает все элементы", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { preset: "zif-gamedev", name: "ZIF" });
  const canvas = await openBoard(page, boardId);
  const panel = await openConstructor(page);
  const title = canvas.locator(".kb-title");
  const primary = canvas.locator(".kb-btn-primary");
  const bar = canvas.locator(".kb-bar i").first();
  const heading = canvas.locator(".kb-col-head").first();
  await expect(title).toHaveCSS("color", "rgb(201, 168, 76)");

  await panel.getByRole("tab", { name: "Тема" }).click();
  await panel.locator('[data-token="accent"] input[aria-label="accent: hex"]').fill("#00FF88");
  await panel.locator('[data-token="accent"] input[aria-label="accent: hex"]').blur();

  const green = "rgb(0, 255, 136)";
  await expect(title).toHaveCSS("color", green);
  await expect(primary).toHaveCSS("background-color", green);
  await expect(bar).toHaveCSS("background-color", green);
  await expect(heading).toHaveCSS("color", green);

  await panel.getByRole("button", { name: "Отменить шаг" }).click();
  await expect(title).toHaveCSS("color", "rgb(201, 168, 76)");
  await panel.getByRole("button", { name: "Вернуть шаг" }).click();
  await expect(title).toHaveCSS("color", green);
});

test("изменение роли измерения показывает и убирает виджет", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, {
    preset: "zif-gamedev",
    name: "ZIF",
    includeSamples: false,
  });
  const canvas = await openBoard(page, boardId);
  const panel = await openConstructor(page);
  await panel.getByRole("tab", { name: "Измерения" }).click();
  await expect(canvas.locator('[data-widget="chips"]')).toBeVisible();
  await panel.locator('input[data-role="filter_chips"]').first().uncheck();
  await expect(canvas.locator('[data-widget="chips"]')).toHaveCount(0);
  await panel.locator('input[data-role="filter_chips"]').first().check();
  await expect(canvas.locator('[data-widget="chips"]')).toBeVisible();
  await panel.locator('input[data-role="progress"]').nth(1).uncheck();
  await expect(canvas.locator('[data-widget="progress"]')).toHaveCount(0);
});

test("частичный импорт меняет только свой раздел", async ({ page }, testInfo) => {
  await register(page);
  const client = await api(page);
  const boardId = await createBoardViaApi(page, { preset: "scrum-lite", name: "Скрам" });
  const before = await client.get<any>(`/boards/${boardId}`);
  const zif = await client.get<any>("/presets/zif-gamedev");
  const file = testInfo.outputPath("zif.json");
  fs.writeFileSync(file, JSON.stringify(zif.data));

  await openBoard(page, boardId);
  const panel = await openConstructor(page);
  await panel.getByRole("tab", { name: "Шаблон и экспорт" }).click();
  await panel.getByLabel("Только тема").check();
  await panel.getByLabel("Загрузить шаблон").setInputFiles(file);
  await expect(page.getByText("Раздел шаблона применён")).toBeVisible();

  const after = await client.get<any>(`/boards/${boardId}`);
  expect(after.config.theme.tokens.accent).toBe("#C9A84C");
  expect(after.config.columns).toEqual(before.config.columns);
  expect(after.config.dimensions).toEqual(before.config.dimensions);
  expect(after.config.layout).toEqual(before.config.layout);
  expect(after.config.typography).toEqual(before.config.typography);
});

test("сброс к шаблону, контраст и конфликт версий", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { preset: "personal", name: "Дом" });
  const client = await api(page);
  await openBoard(page, boardId);
  const panel = await openConstructor(page);

  await panel.getByRole("tab", { name: "Тема" }).click();
  await panel.locator('[data-token="text"] input[aria-label="text: hex"]').fill("#FBF3E9");
  await panel.locator('[data-token="text"] input[aria-label="text: hex"]').blur();
  await expect(panel.getByTestId("contrast-report")).toContainText("Низкий контраст");

  // другая вкладка успела изменить доску
  const fresh = await client.get<any>(`/boards/${boardId}`);
  await client.put(`/boards/${boardId}/config`, fresh.config);
  await panel.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText(/изменились в другой вкладке/)).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Конструктор" }).click();
  await panel.getByRole("tab", { name: "Колонки" }).click();
  await panel.getByLabel("Название").first().fill("Переименовано");
  await panel.getByRole("button", { name: "Применить" }).click();
  await expect(column(page, "inbox").locator(".kb-col-name")).toContainText("Переименовано");
  await panel.getByRole("tab", { name: "Шаблон и экспорт" }).click();
  await panel.getByRole("button", { name: "Сбросить к шаблону" }).click();
  await expect(column(page, "inbox").locator(".kb-col-name")).toContainText("Входящие");
});
