/** Сквозные сценарии из разделов 1 и 10 ТЗ: всё через интерфейс. */
import crypto from "node:crypto";
import fs from "node:fs";

import { expect, test, type Download, type Page } from "@playwright/test";

import { api, column, dragCard, PASSWORD, register, uniqueEmail, ZIF_FILE } from "./helpers";

async function saved(
  download: Promise<Download>,
): Promise<{ path: string; name: string; json: () => any }> {
  const file = await download;
  const path = await file.path();
  return {
    path,
    name: file.suggestedFilename(),
    json: () => JSON.parse(fs.readFileSync(path, "utf-8")),
  };
}

async function createProject(page: Page, name: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Новый проект" }).first().click();
  await page.getByLabel("Название проекта").fill(name);
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

/** Шаблон из файла проходит те же шаги мастера, что и пресет. */
async function createBoardFromFile(page: Page, file: string, name: string) {
  await page.getByRole("button", { name: "Новая доска" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Из файла (JSON, CSV)" }).click();
  await dialog.getByLabel("Доска из файла").setInputFiles(file);
  await expect(dialog.getByText("Шаблон:")).toBeVisible();
  await dialog.getByLabel("Название доски").fill(name);
  for (let step = 0; step < 3; step += 1) {
    await dialog.getByRole("button", { name: "Продолжить" }).click();
  }
  await dialog.getByRole("button", { name: "Создать доску" }).click();
  await expect(page.getByTestId("constructor")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть конструктор" }).click();
}

const stripIds = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["source_id", "project_source_id"].includes(key))
        .map(([key, item]) => [key, stripIds(item)]),
    );
  }
  return value;
};

test("полный цикл: регистрация → пресет → карточки → шаблон → бэкап → удаление → восстановление", async ({
  page,
}) => {
  await register(page);
  await createProject(page, "Игра");
  await createBoardFromFile(page, ZIF_FILE, "ZIF");

  // карточки и drag & drop
  await page.getByRole("button", { name: "+ Карточка" }).click();
  const form = page.getByTestId("card-form");
  await form.getByLabel("Название").fill("Новая механика");
  await form
    .getByRole("textbox", { name: "Описание" })
    .fill("**Важно**: проверить <script>alert(1)</script>");
  await form.getByLabel("Эпик").selectOption({ label: "Боссы" });
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(column(page, "backlog").getByText("Новая механика")).toBeVisible();

  const card = column(page, "todo").locator(".kb-card").first();
  const title = await card.locator(".kb-card-title").innerText();
  await dragCard(page, card, column(page, "doing").locator(".kb-list"));
  await expect(column(page, "doing").getByText(title)).toBeVisible();

  // настройка шрифтов и тегов в конструкторе
  await page.getByRole("button", { name: "Конструктор" }).click();
  const panel = page.getByTestId("constructor");
  await panel.getByRole("tab", { name: "Типографика" }).click();
  await panel.getByText("Заголовок карточки").click();
  await panel
    .locator('[data-role-editor="card_title"]')
    .getByLabel("Шрифт")
    .selectOption("Manrope");
  await panel.getByRole("tab", { name: "Измерения" }).click();
  await panel.getByText("Значения: 15").click();
  await panel.getByRole("button", { name: "Добавить значение" }).first().click();
  await panel.getByRole("button", { name: "Применить" }).click();
  await expect(page.getByText("Настройки применены")).toBeVisible();
  await panel.getByRole("tab", { name: "Шаблон и экспорт" }).click();
  await panel.getByLabel("Название шаблона").fill("Мой ZIF");
  await panel.getByRole("button", { name: "Сохранить как шаблон" }).click();
  await expect(page.getByText("Шаблон сохранён в библиотеке")).toBeVisible();
  await page.getByRole("button", { name: "Закрыть конструктор" }).click();
  await expect(page.locator(".kb-card-title").first()).toHaveCSS("font-family", /Manrope/);

  // новая доска из шаблона
  await page.getByRole("link", { name: "Шаблоны" }).first().click();
  await expect(page.getByRole("heading", { name: "Мои шаблоны" })).toBeVisible();
  const template = page.locator('[data-template="Мой ZIF"]');
  await template.getByRole("button", { name: "Создать доску" }).click();
  await page.getByRole("dialog").getByLabel("Название доски").fill("Копия по шаблону");
  await page.getByRole("dialog").getByRole("button", { name: "Создать", exact: true }).click();
  await expect(page.getByTestId("board-canvas")).toBeVisible();
  await expect(page.locator(".kb-title")).toContainText("Копия по шаблону");

  // бэкап → удаление → восстановление
  await page.getByRole("link", { name: "Профиль" }).first().click();
  await page.getByRole("tab", { name: "Данные и бэкапы" }).click();
  const backup = await saved(
    Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Скачать бэкап" }).click(),
    ]).then(([download]) => download),
  );
  expect(backup.name).toMatch(/^kanbanly-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
  const original = backup.json();

  const client = await api(page);
  const projects = await client.get<{ items: { id: string }[] }>("/projects");
  const request = page.context().request;
  const csrf = (await page.context().cookies()).find((c) => c.name === "kanbanly_csrf")!.value;
  for (const project of projects.items) {
    await request.delete(`/api/v1/projects/${project.id}`, { headers: { "X-CSRF-Token": csrf } });
  }
  const templates = await client.get<{ items: { id: string }[] }>("/templates");
  for (const item of templates.items) {
    await request.delete(`/api/v1/templates/${item.id}`, { headers: { "X-CSRF-Token": csrf } });
  }

  await page.reload();
  await page.getByRole("tab", { name: "Данные и бэкапы" }).click();
  await page.getByLabel("Выбрать файл бэкапа").setInputFiles(backup.path);
  await expect(page.getByTestId("backup-preview")).toContainText("досок 2");
  await page.getByRole("button", { name: "Восстановить" }).click();
  await expect(page.getByText("Данные восстановлены")).toBeVisible();

  const after = await client.get<any>("/export/backup");
  const compare = (document: any) => {
    const data: any = stripIds(document.data);
    data.boards.sort((a: any, b: any) => a.name.localeCompare(b.name));
    data.templates.sort((a: any, b: any) => a.name.localeCompare(b.name));
    return data;
  };
  expect(compare(after)).toEqual(compare(original));
});

test("сброс пароля по ссылке и вход с новым паролем", async ({ page }) => {
  const email = await register(page);
  await page.getByRole("button", { name: "Выйти" }).click();
  await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
  await page.getByRole("link", { name: "Забыли пароль?" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Отправить ссылку" }).click();
  await expect(page.getByText(/письмо со ссылкой/)).toBeVisible();

  await page.getByRole("link", { name: "Вернуться ко входу" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
});

test("пример шаблона скачивается, импортируется и показывает все возможности", async ({ page }) => {
  await register(page);
  await createProject(page, "Демо");
  await page.goto("/templates");
  const example = await saved(
    Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Скачать пример шаблона со всеми функциями" }).click(),
    ]).then(([download]) => download),
  );
  expect(example.name).toBe("kanbanly-template-example.json");

  await page.getByLabel("Загрузить шаблон").setInputFiles(example.path);
  await expect(page.getByTestId("import-counts")).toContainText("колонок 6");
  await page.getByRole("dialog").getByRole("button", { name: "Загрузить шаблон" }).click();
  await expect(page.getByText("Шаблон добавлен в библиотеку")).toBeVisible();

  const mine = page.locator('[data-template="Пример со всеми функциями"]');
  await mine.getByRole("button", { name: "Создать доску" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Создать", exact: true }).click();
  const canvas = page.getByTestId("board-canvas");
  await expect(canvas).toBeVisible();
  for (const selector of [
    '[data-widget="progress"]',
    '[data-widget="filter-bar"]',
    '[data-widget="chips"]',
    '[data-widget="stats"]',
    '[data-widget="legend"]',
    ".kb-note",
    ".kb-footer",
    ".kb-lane-title",
    '.kb-col[data-header-style="pill"]',
    '.kb-col[data-header-style="color-bar"]',
    '.kb-card[data-accent="top-border"]',
    '.kb-card[data-accent="background-tint"]',
    '.kb-card[data-accent="dot"]',
    '.kb-card[data-accent="left-border"]',
    ".kb-tag",
    ".kb-fields",
    ".kb-avatar",
  ]) {
    await expect(canvas.locator(selector).first(), selector).toBeVisible();
  }
  await page.getByRole("button", { name: "Таблица по вехам" }).click();
  await expect(canvas.getByRole("table")).toBeVisible();
});

test("галерея показывает живые миниатюры всех пресетов", async ({ page }) => {
  await register(page);
  await page.goto("/templates");
  await expect(page.getByTestId("template-thumbnail")).toHaveCount(4);
  await expect(
    page.getByTestId("template-thumbnail").first().locator(".kb-card").first(),
  ).toBeAttached();
});

test("зашифрованный бэкап: неверный пароль отвергается, верный восстанавливает", async ({
  page,
}) => {
  await register(page);
  await createProject(page, "Секретный");
  await page.goto("/profile");
  await page.getByRole("tab", { name: "Данные и бэкапы" }).click();
  await page.getByRole("switch", { name: "Зашифровать паролем" }).click();
  await page.getByLabel("Пароль бэкапа").fill("backup-secret-1");
  const backup = await saved(
    Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Скачать бэкап" }).click(),
    ]).then(([download]) => download),
  );
  expect(backup.json().format).toBe("kanbanly.backup.encrypted");

  await page.getByLabel("Выбрать файл бэкапа").setInputFiles(backup.path);
  const retry = page.getByRole("button", { name: "Продолжить" });
  await expect(retry).toBeVisible();
  await page.getByLabel("Пароль бэкапа").last().fill("wrong-password");
  await retry.click();
  await expect(page.getByRole("alert")).toContainText("Неверный пароль");
  await page.getByLabel("Пароль бэкапа").last().fill("backup-secret-1");
  await retry.click();
  await expect(page.getByTestId("backup-preview")).toContainText("проектов 1");
});

function totp(secret: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = digest[19]! & 15;
  return String(digest.readUInt32BE(offset) & 0x7fffffff)
    .slice(-6)
    .padStart(6, "0");
}

test("2FA: включение, вход по коду и по резервному коду", async ({ page }) => {
  const email = uniqueEmail();
  await register(page, email);
  await page.goto("/profile");
  await page.getByRole("tab", { name: "Безопасность" }).click();
  await page.getByRole("button", { name: "Включить 2FA" }).click();
  const secret = await page.getByTestId("totp-secret").innerText();
  await page.getByLabel("Код подтверждения").fill(totp(secret));
  await page.getByRole("button", { name: "Включить 2FA" }).click();
  await expect(page.getByText("Включена")).toBeVisible();
  const recovery = (await page.locator("pre").innerText()).split("\n")[0]!;

  const login = async () => {
    await page.getByRole("button", { name: "Выйти" }).click();
    await expect(page.getByRole("heading", { name: "Вход" })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByLabel("Код из приложения")).toBeVisible();
  };
  await login();
  await page.getByLabel("Код из приложения").fill(totp(secret));
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();

  await login();
  await page.getByRole("button", { name: "Использовать резервный код" }).click();
  await page.getByLabel("Резервный код").fill(recovery);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
});
