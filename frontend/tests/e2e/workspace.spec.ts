/** Документы проекта, теги и цвета карточек, блокировка входа и панель администратора. */
import { expect, test, type Page } from "@playwright/test";

import { api, createBoardViaApi, openBoard, PASSWORD, register, uniqueEmail } from "./helpers";

const ADMIN_EMAIL = "admin@example.com";

/** Минимальный корректный PDF с одной страницей и текстом: pdf.js рисует его на canvas. */
function tinyPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET";
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    const content = object ?? `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    body += `${index + 1} 0 obj\n${content}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function projectPage(page: Page): Promise<{ projectId: string; boardId: string }> {
  const boardId = await createBoardViaApi(page, { preset: "personal", name: "Рабочая" });
  const client = await api(page);
  const board = await client.get<{ project_id: string }>(`/boards/${boardId}`);
  await page.goto(`/projects/${board.project_id}`);
  return { projectId: board.project_id, boardId };
}

test("документ проекта: загрузка, просмотр, описание, теги, новая версия и комментарии", async ({
  page,
}) => {
  const email = await register(page);
  const author = email.split("@")[0] ?? "";
  await projectPage(page);
  const documents = page.getByTestId("project-documents");
  await documents.getByTestId("file-input").setInputFiles({
    name: "ТЗ.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(
      "# Техническое задание\n\n- Канбан\n- Документы\n\n<script>alert(1)</script>",
    ),
  });
  await documents.getByRole("link", { name: /ТЗ\.md/ }).click();

  const viewer = page.getByTestId("document-viewer");
  await expect(viewer.getByRole("heading", { name: "Техническое задание" })).toBeVisible();
  await expect(viewer.locator("script")).toHaveCount(0);
  await expect(page.getByText("только просмотр")).toBeVisible();

  await page.getByRole("button", { name: "Изменить", exact: true }).click();
  await page.getByLabel("Описание").fill("Главный документ проекта");
  await page.getByLabel("Новый тег").fill("ТЗ");
  await page.getByRole("button", { name: "Создать тег" }).click();
  await expect(
    page.getByTestId("tag-picker").getByRole("button", { name: "ТЗ", pressed: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByText("Главный документ проекта")).toBeVisible();

  await page.getByTestId("file-input").setInputFiles({
    name: "ТЗ v2.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Вторая редакция"),
  });
  await expect(page.getByText("Загружена версия 2")).toBeVisible();
  await expect(viewer.getByText("Вторая редакция")).toBeVisible();
  const versions = page.getByTestId("document-versions");
  await expect(versions.locator("li")).toHaveCount(2);
  await versions.getByRole("button", { name: /v1 · ТЗ\.md/ }).click();
  await expect(page.getByText("Вы смотрите версию 1. Текущая — 2.")).toBeVisible();
  await expect(viewer.getByRole("heading", { name: "Техническое задание" })).toBeVisible();

  await page.getByLabel("Написать комментарий").fill("Проверьте раздел про **документы**");
  await page.getByRole("button", { name: "Отправить" }).click();
  const comment = page.getByTestId("document-comment").first();
  await expect(comment.getByText(author, { exact: true })).toBeVisible();
  await expect(comment.locator("strong")).toHaveText("документы");

  await page.getByRole("link", { name: "К проекту" }).click();
  const row = page.getByTestId("project-documents").getByRole("link", { name: /ТЗ\.md/ });
  await expect(row).toContainText("v2");
  await expect(row).toContainText("ТЗ");
});

test("PDF открывается во встроенном просмотрщике, а HTML не исполняется", async ({ page }) => {
  await register(page);
  await projectPage(page);
  const input = page.getByTestId("project-documents").getByTestId("file-input");
  await input.setInputFiles([
    { name: "spec.pdf", mimeType: "application/pdf", buffer: tinyPdf() },
    {
      name: "evil.html",
      mimeType: "text/html",
      buffer: Buffer.from("<script>window.pwned=1</script>"),
    },
  ]);
  await page.getByRole("link", { name: /spec\.pdf/ }).click();
  const canvas = page.getByTestId("pdf-viewer").locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => canvas.evaluate((node: HTMLCanvasElement) => node.width))
    .toBeGreaterThan(100);

  await page.getByRole("link", { name: "К проекту" }).click();
  await page.getByRole("link", { name: /evil\.html/ }).click();
  await expect(page.getByText("Для этого типа файла просмотр недоступен")).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: number }).pwned),
  ).toBeUndefined();
});

test("теги проекта и цвет карточки: текст на цветной карточке остаётся читаемым", async ({
  page,
}) => {
  await register(page);
  const { boardId } = await projectPage(page);
  const client = await api(page);
  const board = await client.get<{ config: { columns: { key: string }[] } }>(`/boards/${boardId}`);
  await client.post(`/boards/${boardId}/cards`, {
    column: board.config.columns[0]?.key,
    title: "Цветная задача",
  });
  await openBoard(page, boardId);
  await page.locator(".kb-card", { hasText: "Цветная задача" }).click();
  await page.getByLabel("Новый тег").fill("Срочно");
  await page.getByRole("button", { name: "Создать тег" }).click();
  await expect(
    page.getByTestId("tag-picker").getByRole("button", { name: "Срочно", pressed: true }),
  ).toBeVisible();
  await page
    .getByRole("radiogroup", { name: "Цвет карточки" })
    .getByRole("radio", { name: "#1971C2" })
    .click();
  await page.getByRole("button", { name: "Сохранить" }).click();

  const card = page.locator(".kb-card", { hasText: "Цветная задача" });
  await expect(card.locator(".kb-label", { hasText: "Срочно" })).toBeVisible();
  await expect(card).toHaveCSS("background-color", "rgb(25, 113, 194)");
  // На тёмно-синем фоне текст становится белым.
  await expect(card.locator(".kb-card-title")).toHaveCSS("color", "rgb(255, 255, 255)");

  await card.click();
  await page
    .getByRole("radiogroup", { name: "Цвет карточки" })
    .getByRole("radio", { name: "#FFE8A3" })
    .click();
  await page.getByRole("button", { name: "Сохранить" }).click();
  await expect(card.locator(".kb-card-title")).toHaveCSS("color", "rgb(17, 17, 17)");
});

test("20 неудачных входов блокируют аккаунт, администратор снимает блокировку", async ({
  page,
  browser,
}) => {
  const email = uniqueEmail();
  await register(page, email);
  await page.context().clearCookies();

  const csrf = await page.request.get("/api/v1/auth/csrf");
  const token = ((await csrf.json()) as { csrf_token: string }).csrf_token;
  for (let attempt = 0; attempt < 19; attempt += 1) {
    const response = await page.request.post("/api/v1/auth/login", {
      data: { email, password: "wrong-password-123" },
      headers: { "X-CSRF-Token": token },
    });
    expect(response.status()).toBe(401);
  }
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill("wrong-password-123");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("alert")).toContainText("Обратитесь к администратору");
  await expect(page.getByRole("link", { name: /Восстановить доступ/ })).toBeVisible();

  const adminContext = await browser.newContext({
    baseURL: "http://127.0.0.1:8123",
    locale: "ru-RU",
  });
  const admin = await adminContext.newPage();
  await admin.goto("/login");
  await admin.getByLabel("Email").fill(ADMIN_EMAIL);
  await admin.getByLabel("Пароль").fill(PASSWORD);
  await admin.getByRole("button", { name: "Войти" }).click();
  await admin.getByRole("link", { name: "Админка" }).first().click();
  await expect(admin.getByRole("heading", { name: "Администрирование" })).toBeVisible();
  await admin.getByLabel("Поиск по email или имени").fill(email);
  const row = admin.getByTestId("admin-user").filter({ hasText: email });
  await expect(row).toContainText("заблокирован");
  await row.getByRole("button", { name: "Разблокировать" }).click();
  await expect(row).toContainText("активен");
  await adminContext.close();

  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Админка" })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page.getByText("Страница не найдена")).toBeVisible();
});

test("оглавление документа прокручивает к разделу", async ({ page }) => {
  await register(page);
  await projectPage(page);
  const filler = Array.from({ length: 80 }, (_, index) => `Абзац ${index + 1}.`).join("\n\n");
  await page
    .getByTestId("project-documents")
    .getByTestId("file-input")
    .setInputFiles({
      name: "ГДД.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(
        `# Оглавление\n\n- [Механики боя](#механики-боя)\n\n${filler}\n\n## Механики боя\n\nВалун и бросок.`,
      ),
    });
  await page.getByRole("link", { name: /ГДД\.md/ }).click();
  const heading = page.getByRole("heading", { name: "Механики боя" });
  await expect(heading).not.toBeInViewport();
  const pages = page.context().pages().length;
  await page.getByTestId("document-viewer").getByRole("link", { name: "Механики боя" }).click();
  await expect(heading).toBeInViewport();
  expect(page.context().pages()).toHaveLength(pages);
});
