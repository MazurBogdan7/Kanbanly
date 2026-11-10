/** Главная: раскрывающиеся проекты с живыми превью досок, импорт доски из CSV и JSON. */
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { api, createBoardViaApi, register, ZIF_TEMPLATE } from "./helpers";

const CSV = [
  "Название;Описание;Статус;Приоритет;Срок",
  "Логин;Форма входа;Бэклог;Высокий;2027-01-15",
  "Регистрация;;В работе;Низкий;",
  "Отчёт;;Готово;Высокий;",
].join("\r\n");

test("новый проект сразу с доской из CSV", async ({ page }) => {
  await register(page);
  await page.getByRole("button", { name: "Новый проект" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Доска из файла").setInputFiles({
    name: "Спринт 1.csv",
    mimeType: "text/csv",
    buffer: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CSV)]),
  });
  await expect(dialog.getByLabel("Название проекта")).toHaveAttribute("placeholder", "Спринт 1");
  await dialog.getByRole("button", { name: "Создать и импортировать" }).click();

  const canvas = page.getByTestId("board-canvas");
  await expect(canvas).toBeVisible();
  await expect(page.locator(".kb-title")).toContainText("Спринт 1");
  await expect(canvas.locator(".kb-col")).toHaveCount(3);
  await expect(canvas.locator(".kb-card")).toHaveCount(3);
  await expect(canvas.locator(".kb-card", { hasText: "Логин" })).toContainText("Высокий");
});

test("мастер импортирует JSON-бэкап доски в другой проект", async ({ page }) => {
  await register(page);
  const client = await api(page);
  const source = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "Исходная" });
  const backup = await page.request.get(`/api/v1/export/backup?scope=board:${source}`);
  const target = await client.post<{ id: string }>("/projects", { name: "Новый дом" });

  await page.goto(`/projects/${target.id}`);
  await page.getByRole("button", { name: "Импорт из файла" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Доска из файла").setInputFiles({
    name: "board.json",
    mimeType: "application/json",
    buffer: Buffer.from(await backup.body()),
  });
  await expect(dialog.getByRole("status")).toContainText("Колонки, карточки");
  await dialog.getByLabel("Название доски").fill("Перенесённая");
  await dialog.getByRole("button", { name: "Импортировать" }).click();
  await expect(page.getByTestId("constructor")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть конструктор" }).click();
  await expect(page.locator(".kb-title")).toContainText("Перенесённая");
  const project = await client.get<{ boards: { name: string; card_count: number }[] }>(
    `/projects/${target.id}`,
  );
  expect(project.boards).toEqual([
    expect.objectContaining({ name: "Перенесённая", card_count: 153 }),
  ]);
});

test("проекты раскрываются стрелкой, превью досок рисует настоящую тему", async ({ page }) => {
  await register(page);
  const client = await api(page);
  const project = await client.post<{ id: string }>("/projects", { name: "Игра" });
  for (const name of ["Альфа", "Бета", "Гамма"]) {
    await client.post(`/projects/${project.id}/boards`, { name, preset: "scrum-lite" });
  }
  for (const name of ["Второй", "Третий", "Четвёртый"]) {
    await client.post("/projects", { name });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  const cards = page.getByTestId("project-card");
  await expect(cards).toHaveCount(4);
  // Свёрнутые проекты стоят в несколько колонок.
  const tops = await cards.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBeLessThan(4);

  const game = cards.filter({ hasText: "Игра" });
  await expect(game.getByTestId("board-tile")).toHaveCount(0);
  await game.getByRole("button", { name: "Показать доски проекта «Игра»" }).click();
  const tiles = game.getByTestId("board-tile");
  await expect(tiles).toHaveCount(3);
  const thumbnail = tiles.first().getByTestId("board-thumbnail");
  await expect(thumbnail.locator(".kb-card").first()).toBeAttached();
  await expect(thumbnail.locator(".kb-col")).not.toHaveCount(0);
  // Доски раскрытого проекта тоже в несколько колонок.
  const tileTops = await tiles.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  expect(new Set(tileTops).size).toBe(1);

  // Раскрытие запоминается.
  await page.reload();
  await expect(cards.filter({ hasText: "Игра" }).getByTestId("board-tile")).toHaveCount(3);

  await game.getByRole("link", { name: "Открыть проект «Игра»" }).click();
  await expect(page.getByRole("heading", { name: "Игра", level: 1 })).toBeVisible();
});

test("галерея шаблонов — сетка в несколько колонок, ZIF в каталоге нет", async ({ page }) => {
  await register(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/templates");
  const thumbnails = page.getByTestId("template-thumbnail");
  await expect(thumbnails).toHaveCount(4);
  await expect(page.getByText("ZIF", { exact: false })).toHaveCount(0);
  const tops = await thumbnails.evaluateAll((nodes) =>
    nodes.map((node) => Math.round(node.getBoundingClientRect().top)),
  );
  expect(new Set(tops).size).toBe(1);
});

test("кнопка «Импорт» на доске добавляет карточки из шаблона, а не только оформление", async ({
  page,
}) => {
  const file = path.resolve(
    import.meta.dirname,
    "../../../backend/tests/fixtures/genesis-short.json",
  );
  const template = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  await register(page);
  const boardId = await createBoardViaApi(page, {
    template,
    name: "Genesis",
    includeSamples: false,
  });
  await page.goto(`/boards/${boardId}`);
  await expect(page.locator(".kb-card")).toHaveCount(0);
  await page.getByLabel("Импорт").setInputFiles(file);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Карточки из файла: 3")).toBeVisible();
  await dialog.getByRole("button", { name: "Импортировать на доску" }).click();
  await expect(page.locator(".kb-card")).toHaveCount(3);
  await expect(page.locator(".kb-card", { hasText: "Разрезать ГДД" })).toBeVisible();
});
