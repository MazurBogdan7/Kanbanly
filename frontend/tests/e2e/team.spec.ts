/** Команда: ник, приглашение во входящие (отклонить → снова → принять), исполнитель, бэкап в админке. */
import { expect, test, type Browser, type Page } from "@playwright/test";

import { api, column, openBoard, PASSWORD, register, uniqueEmail } from "./helpers";

async function newUser(browser: Browser): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:8123", locale: "ru-RU" });
  const page = await context.newPage();
  const email = await register(page, uniqueEmail());
  return { page, email };
}

test("приглашение по нику: отклонить, получить снова, принять и стать исполнителем", async ({
  page,
  browser,
}) => {
  await register(page);
  const owner = await api(page);
  const project = await owner.post<{ id: string }>("/projects", { name: "Игра про Сизифа" });
  const board = await owner.post<{ id: string; config: { columns: { key: string }[] } }>(
    `/projects/${project.id}/boards`,
    { name: "Задачи", preset: "personal", include_samples: false },
  );
  const first = board.config.columns[0]?.key ?? "";
  await owner.post(`/boards/${board.id}/cards`, { column: first, title: "Нарисовать валун" });

  // Второй человек задаёт ник в профиле.
  const guest = await newUser(browser);
  const nick = `nika${Date.now() % 100000}`;
  await guest.page.goto("/profile");
  await guest.page.getByLabel("Ник").fill(`@${nick}`);
  await guest.page.getByRole("button", { name: "Сохранить" }).click();
  await expect(guest.page.getByText("Сохранено")).toBeVisible();

  // Владелец приглашает по нику — ссылка не нужна, приглашение уходит во входящие.
  await page.goto(`/projects/${project.id}`);
  await page.getByLabel("Email или ник").fill(`@${nick}`);
  await page.getByRole("button", { name: "Пригласить" }).click();
  await expect(page.getByText(/увидит его в профиле/)).toBeVisible();
  await expect(page.getByTestId("invite-link")).toHaveCount(0);

  // Гость видит значок и отклоняет.
  await guest.page.goto("/");
  await expect(guest.page.getByLabel("Новых приглашений: 1").first()).toBeVisible();
  await guest.page.goto("/profile?tab=invites");
  const incoming = guest.page.getByTestId("incoming-invite");
  await expect(incoming).toContainText("Игра про Сизифа");
  await incoming.getByRole("button", { name: "Отклонить" }).click();
  await expect(guest.page.getByText("Новых приглашений нет")).toBeVisible();

  // Владелец видит отказ и отправляет снова.
  await page.reload();
  const pending = page.getByTestId("project-invite");
  await expect(pending).toContainText("отклонено");
  await pending.getByRole("button", { name: "Пригласить снова" }).click();
  await expect(page.getByTestId("project-invite")).not.toContainText("отклонено");

  await guest.page.reload();
  await guest.page.getByTestId("incoming-invite").getByRole("button", { name: "Принять" }).click();
  await expect(
    guest.page.getByRole("heading", { name: "Игра про Сизифа", level: 1 }),
  ).toBeVisible();

  // Владелец назначает гостя исполнителем.
  await openBoard(page, board.id);
  await column(page, first).getByText("Нарисовать валун").click();
  const assignee = page.getByLabel("Исполнитель", { exact: true });
  await expect(assignee.locator("option")).toHaveCount(3);
  await assignee.selectOption({ label: guest.email.split("@")[0] ?? "" });
  await page.getByRole("button", { name: "Сохранить" }).click();
  const card = page.locator(".kb-card", { hasText: "Нарисовать валун" });
  await expect(card.getByTestId("card-assignee")).toContainText(guest.email.split("@")[0] ?? "");

  // Гость видит себя исполнителем на своей доске.
  await openBoard(guest.page, board.id);
  await expect(
    guest.page.locator(".kb-card", { hasText: "Нарисовать валун" }).getByTestId("card-assignee"),
  ).toBeVisible();
  await guest.page.context().close();
});

test("администратор скачивает бэкап чужой доски", async ({ page, browser }) => {
  const owner = await newUser(browser);
  const client = await api(owner.page);
  const project = await client.post<{ id: string }>("/projects", { name: "Чужой" });
  const name = `Доска-${Date.now()}`;
  await client.post(`/projects/${project.id}/boards`, { name, preset: "personal" });
  await owner.page.context().close();

  await page.goto("/login");
  await page.getByLabel("Email").fill("admin@example.com");
  await page.getByLabel("Пароль").fill(PASSWORD);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("link", { name: "Админка" }).first().click();
  await page.getByLabel("Поиск по доске, проекту или владельцу").fill(name);
  const row = page.getByTestId("admin-board").filter({ hasText: name });
  await expect(row).toContainText(owner.email);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row.getByRole("button", { name: "Скачать бэкап" }).click(),
  ]);
  const file = test.info().outputPath("board.json");
  await download.saveAs(file);
  const document = JSON.parse(await (await import("node:fs/promises")).readFile(file, "utf-8")) as {
    data: { boards: { name: string }[] };
  };
  expect(document.data.boards.map((item) => item.name)).toEqual([name]);
  await page.reload();
  await expect(page.getByText("Администратор скачал бэкап доски").first()).toBeVisible();
});
