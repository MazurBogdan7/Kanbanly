/** Совместная работа, темы, выгрузки, новые виды и импорт из прототипа — в настоящем браузере. */
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  api,
  column,
  createBoardViaApi,
  dragCard,
  openBoard,
  PASSWORD,
  register,
  uniqueEmail,
  ZIF_FILE,
  ZIF_TEMPLATE,
} from "./helpers";

const BASE = "http://127.0.0.1:8123";
const PROTOTYPE = path.resolve(import.meta.dirname, "../../../docs/reference/ZIF_kanban.html");

async function secondUser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, locale: "ru-RU" });
  return context.newPage();
}

test("приглашение: второй участник входит по ссылке и видит изменения без перезагрузки", async ({
  page,
  browser,
}) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "Общая" });
  const client = await api(page);
  const board = await client.get<{ project_id: string }>(`/boards/${boardId}`);

  await page.goto(`/projects/${board.project_id}`);
  const guestEmail = uniqueEmail();
  await page.getByLabel("Email приглашённого").fill(guestEmail);
  await page.getByRole("button", { name: "Пригласить" }).click();
  const link = (await page.getByTestId("invite-link").locator("code").innerText()).trim();
  expect(link).toMatch(/\/invite\/[\w-]+$/);
  await expect(page.getByText("Ожидают ответа")).toBeVisible();

  const guest = await secondUser(browser);
  await guest.goto(new URL(link).pathname);
  await expect(guest.getByRole("heading", { name: "Вход" })).toBeVisible();
  await guest.getByRole("link", { name: /Нет аккаунта/ }).click();
  await guest.getByLabel("Email").fill(guestEmail);
  await guest.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await guest.getByRole("button", { name: "Создать аккаунт" }).click();
  await expect(guest.getByText(/приглашает вас в проект/)).toBeVisible();
  await guest.getByRole("button", { name: "Принять приглашение" }).click();
  await expect(guest.getByRole("link", { name: "Общая" })).toBeVisible();

  await guest.goto(`/boards/${boardId}`);
  await expect(guest.getByTestId("board-canvas")).toBeVisible();
  const card = column(page, "todo").locator(".kb-card").first();
  await openBoard(page, boardId);
  const title = await card.locator(".kb-card-title").innerText();
  await dragCard(page, card, column(page, "doing").locator(".kb-list"));
  await expect(column(page, "doing").getByText(title)).toBeVisible();
  // Без reload: изменение приходит опросом ревизии.
  await expect(column(guest, "doing").getByText(title)).toBeVisible({ timeout: 12_000 });

  await page.goto(`/projects/${board.project_id}`);
  await page.getByLabel(/^Роль: /).selectOption("viewer");
  await guest.reload();
  await expect(guest.getByTestId("board-canvas")).toBeVisible();
  await expect(guest.getByRole("button", { name: "Конструктор" })).toHaveCount(0);
  await guest.context().close();
});

const LOOKS = [
  { preset: "Дизайн-студия", font: /Manrope/, dark: false },
  { preset: "Разработка (Scrum-lite)", font: /JetBrains Mono/, dark: true },
  { preset: "Личные задачи", font: /Lora/, dark: false },
  { preset: "Контент-план", font: /Playfair Display/, dark: false },
];

function luminance(rgb: string): number {
  const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

test("одна структура в разных темах: оформление пресетов и палитры через мастер", async ({
  page,
}) => {
  await register(page);
  const client = await api(page);
  const project = await client.post<{ id: string }>("/projects", { name: "Темы" });
  const seen = new Set<string>();

  const create = async (look: string | null, palette: string | null, name: string) => {
    await page.goto(`/projects/${project.id}`);
    await page.getByRole("button", { name: "Новая доска" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Из файла (JSON, CSV)" }).click();
    await dialog.getByLabel("Доска из файла").setInputFiles(ZIF_FILE);
    await dialog.getByLabel("Название доски").fill(name);
    await dialog.getByRole("button", { name: "Продолжить" }).click();
    if (look)
      await dialog.getByRole("button", { name: new RegExp(look.replace(/[()]/g, "\\$&")) }).click();
    if (palette) await dialog.getByRole("button", { name: palette, exact: true }).click();
    await dialog.getByRole("button", { name: "Продолжить" }).click();
    await dialog.getByRole("button", { name: "Продолжить" }).click();
    await dialog.getByRole("button", { name: "Создать доску" }).click();
    await page.getByRole("button", { name: "Закрыть конструктор" }).click();
    const canvas = page.getByTestId("board-canvas");
    await expect(canvas.locator(".kb-card").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    return canvas;
  };

  for (const look of LOOKS) {
    const canvas = await create(look.preset, null, `ZIF · ${look.preset}`);
    const title = canvas.locator(".kb-title");
    await expect(title).toHaveCSS("font-family", look.font);
    const background = await canvas.evaluate((node) =>
      getComputedStyle(node).getPropertyValue("--t-bg"),
    );
    expect(
      luminance(
        await canvas
          .locator(".kb-col")
          .first()
          .evaluate((n) => getComputedStyle(n).backgroundColor),
      ) < 0.5,
    ).toBe(look.dark);
    // Структура ZIF сохранилась: те же колонки и 153 карточки.
    await expect(canvas.locator(".kb-col")).toHaveCount(5);
    seen.add(background.trim());
    await page.screenshot({ path: test.info().outputPath(`look-${seen.size}.png`) });
  }

  const mint = await create(null, "Мята", "ZIF · Мята");
  await expect(mint.locator(".kb-title")).toHaveCSS("font-family", /Cormorant SC/);
  seen.add(
    (await mint.evaluate((node) => getComputedStyle(node).getPropertyValue("--t-bg"))).trim(),
  );
  expect(seen.size).toBe(5);
});

test("скачивание: таблица CSV доски и JSON проекта", async ({ page }) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { template: ZIF_TEMPLATE, name: "ZIF" });
  await openBoard(page, boardId);
  await page.getByRole("button", { name: "Экспорт", exact: true }).first().click();
  const [csv] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: /CSV/ }).click(),
  ]);
  const text = fs.readFileSync(await csv.path(), "utf-8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.trim().split("\r\n");
  expect(lines[0]).toBe(
    "Название;Описание;Колонка;Эпик;Веха;Тип;Исполнитель;Срок;Создана;Завершена",
  );
  expect(lines).toHaveLength(154);

  const client = await api(page);
  const board = await client.get<{ project_id: string }>(`/boards/${boardId}`);
  await page.goto(`/projects/${board.project_id}`);
  await page.getByRole("button", { name: "Действия с проектом" }).click();
  const [json] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("menuitem", { name: /Скачать проект/ }).click(),
  ]);
  const backup = JSON.parse(fs.readFileSync(await json.path(), "utf-8"));

  await page.goto("/profile");
  await page.getByRole("tab", { name: "Данные и бэкапы" }).click();
  const [zip] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Скачать таблицы для Excel (CSV в ZIP)" }).click(),
  ]);
  expect(zip.suggestedFilename()).toMatch(/^kanbanly-tables-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  const archive = fs.readFileSync(await zip.path());
  // Сигнатура ZIP и имя файла доски внутри архива.
  expect(archive.subarray(0, 2).toString()).toBe("PK");
  expect(archive.includes(Buffer.from("Проект/ZIF.csv"))).toBe(true);
  expect(backup.format).toBe("kanbanly.backup");
  expect(backup.data.boards[0].cards).toHaveLength(153);
});

test("календарь и таймлайн на настоящей доске", async ({ page }) => {
  await register(page);
  const example = await (
    await page.context().request.get(`${BASE}/api/v1/templates/example`)
  ).json();
  const boardId = await createBoardViaApi(page, { template: example, name: "Пример" });
  await openBoard(page, boardId);

  await page.getByRole("button", { name: "Календарь", exact: true }).click();
  const calendar = page.getByRole("region", { name: "Календарь" });
  await expect(calendar).toBeVisible();
  for (
    let step = 0;
    step < 6 && !(await calendar.locator('[data-date="2027-02-28"]').count());
    step += 1
  ) {
    await page.getByRole("button", { name: "Следующий месяц" }).click();
  }
  await expect(
    calendar
      .locator('[data-date="2027-02-28"]')
      .getByRole("button", { name: "Карточка со всеми значениями" }),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("calendar.png") });

  await page.getByRole("button", { name: "Таймлайн", exact: true }).click();
  const stage = page.locator('.kb-timeline-stage[data-value="m1"]');
  await expect(stage.getByRole("button", { name: /Завершённая/ })).toBeVisible();
  await stage.getByRole("button", { name: /На проверке/ }).click();
  await expect(page.getByTestId("card-form")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: test.info().outputPath("timeline.png") });
});

test("импорт экспорта из исходного прототипа ZIF_kanban.html", async ({ page, browser }) => {
  const context = await browser.newContext({ acceptDownloads: true });
  const prototype = await context.newPage();
  await prototype.setContent(
    fs.readFileSync(PROTOTYPE, "utf-8").replace(/<link[^>]+fonts\.g[^>]+>/g, ""),
  );
  const [download] = await Promise.all([
    prototype.waitForEvent("download"),
    prototype.getByRole("button", { name: "Экспорт JSON" }).click(),
  ]);
  const file = test.info().outputPath("zif-prototype-export.json");
  await download.saveAs(file);
  await context.close();

  await register(page);
  const boardId = await createBoardViaApi(page, {
    template: ZIF_TEMPLATE,
    name: "ZIF",
    includeSamples: false,
  });
  await openBoard(page, boardId);
  await page.getByLabel("Импорт").setInputFiles(file);
  await expect(page.getByText("Импортировано задач: 153. Пропущено: 0.")).toBeVisible();
  await expect(page.locator(".kb-title")).toHaveText(/ZIF \(импорт\)/);
  await expect(column(page, "done").locator(".kb-card")).toHaveCount(6);
  await expect(page.getByTestId("progress-m1")).toHaveText(/^6\/\d+$/);
  const card = column(page, "done").locator(".kb-card").first();
  await expect(card.locator(".kb-tag").first()).toHaveText("M1");
});
