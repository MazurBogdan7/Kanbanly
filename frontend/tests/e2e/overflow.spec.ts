/** Длинная колонка: 5 карточек сверху, остальные — раскрывающимися блоками по тегу. */
import { expect, test } from "@playwright/test";

import { column, createBoardViaApi, dragCard, openBoard, register, ZIF_TEMPLATE } from "./helpers";

test("бэклог из 139 карточек сворачивается в блоки по эпикам", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "ZIF" });
  await openBoard(page, boardId);
  const backlog = column(page, "backlog");

  // Сверху ровно 5 карточек, всё остальное спрятано в блоки.
  await expect(backlog.locator(".kb-card")).toHaveCount(5);
  const groups = backlog.locator(".kb-group");
  await expect(groups).toHaveCount(15);
  const counts = await groups
    .locator(".kb-group-head em")
    .evaluateAll((nodes) => nodes.map((node) => Number(node.textContent)));
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(134);
  // Короткие колонки не трогаются.
  await expect(column(page, "todo").locator(".kb-group")).toHaveCount(0);

  const sisyphus = groups.filter({ hasText: "Сизиф" });
  const head = sisyphus.locator(".kb-group-head");
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const inside = sisyphus.locator(".kb-card");
  await expect(inside).toHaveCount(2);
  await expect(backlog.locator(".kb-card")).toHaveCount(7);

  // Карточку из раскрытого блока можно перетащить в другую колонку.
  const title = await inside.first().locator(".kb-card-title").innerText();
  await dragCard(page, inside.first(), column(page, "doing").locator(".kb-list"));
  await expect(column(page, "doing").getByText(title)).toBeVisible();
  await expect(sisyphus.locator(".kb-card")).toHaveCount(1);

  await head.click();
  await expect(backlog.locator(".kb-card")).toHaveCount(5);

  // Поиск сужает колонку — найденное показывается сразу, без блоков.
  await page.getByRole("searchbox").fill("Ламия — босс");
  await expect(backlog.locator(".kb-group")).toHaveCount(0);
  await page.getByRole("searchbox").fill("");
  await expect(backlog.locator(".kb-group")).toHaveCount(15);
});

test("порог и число карточек сверху меняются в конструкторе", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "ZIF" });
  await openBoard(page, boardId);
  await page.getByRole("button", { name: "Конструктор" }).click();
  const panel = page.getByTestId("constructor");
  await panel.getByRole("tab", { name: "Колонки" }).click();
  await panel.getByText("Длинные колонки").click();
  await panel.getByLabel("Показывать сверху").fill("10");
  await expect(column(page, "backlog").locator(".kb-card")).toHaveCount(10);
  await panel.getByLabel("Сворачивать хвост длинной колонки").uncheck();
  await expect(column(page, "backlog").locator(".kb-group")).toHaveCount(0);
});

test("на телефоне низ конструктора не закрыт нижним меню", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);
  const boardId = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "ZIF" });
  await openBoard(page, boardId);
  await page.getByRole("button", { name: "Конструктор" }).click();
  const panel = page.getByTestId("constructor");
  await panel.getByRole("tab", { name: "Колонки" }).click();
  await panel.getByText("Общие настройки колонок").click();
  const last = panel.getByText("Длинные колонки");
  await last.scrollIntoViewIfNeeded();
  // Нажатие должно попасть в саму секцию, а не в меню поверх неё.
  await last.click();
  await expect(panel.getByLabel("Показывать сверху")).toBeVisible();
});

test("наведение на колонку не сдвигает карточки (кнопка «Добавить карточку» не раздвигает список)", async ({
  page,
}) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "ZIF" });
  await openBoard(page, boardId);
  const todo = column(page, "todo");
  const last = todo.locator(".kb-card").last();
  const list = todo.locator(".kb-list");
  await page.mouse.move(5, 5);
  const before = await last.boundingBox();
  const listBefore = await list.boundingBox();
  const columnBefore = await todo.boundingBox();
  await todo.locator(".kb-col-head").hover();
  await expect(todo.getByRole("button", { name: "Добавить карточку" })).toHaveCSS("opacity", "1");
  const after = await last.boundingBox();
  expect(after?.y).toBe(before?.y);
  expect(after?.height).toBe(before?.height);
  expect((await list.boundingBox())?.height).toBe(listBefore?.height);
  expect((await todo.boundingBox())?.height).toBe(columnBefore?.height);
});
