import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const PASSWORD = "correct-horse-battery-7";

let counter = 0;

export function uniqueEmail(): string {
  counter += 1;
  return `user-${Date.now()}-${counter}@example.com`;
}

export async function register(page: Page, email = uniqueEmail()): Promise<string> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  await expect(page.getByRole("heading", { name: "Проекты", exact: true })).toBeVisible();
  return email;
}

export async function api(page: Page) {
  const request: APIRequestContext = page.context().request;
  const cookies = await page.context().cookies();
  let csrf = cookies.find((cookie) => cookie.name === "kanbanly_csrf")?.value;
  if (!csrf) {
    const response = await request.get("/api/v1/auth/csrf");
    csrf = ((await response.json()) as { csrf_token: string }).csrf_token;
  }
  const headers = { "X-CSRF-Token": csrf };
  return {
    post: async <T>(path: string, data: unknown): Promise<T> => {
      const response = await request.post(`/api/v1${path}`, { data, headers });
      expect(response.ok(), await response.text()).toBeTruthy();
      return (await response.json()) as T;
    },
    get: async <T>(path: string): Promise<T> => {
      const response = await request.get(`/api/v1${path}`);
      expect(response.ok()).toBeTruthy();
      return (await response.json()) as T;
    },
    put: async <T>(path: string, data: unknown): Promise<T> => {
      const response = await request.put(`/api/v1${path}`, { data, headers });
      expect(response.ok(), await response.text()).toBeTruthy();
      return (await response.json()) as T;
    },
  };
}

export async function createBoardViaApi(
  page: Page,
  options: { preset?: string; name?: string; template?: unknown; includeSamples?: boolean } = {},
): Promise<string> {
  const client = await api(page);
  const project = await client.post<{ id: string }>("/projects", { name: "Проект" });
  const board = await client.post<{ id: string }>(`/projects/${project.id}/boards`, {
    name: options.name ?? "Доска",
    preset: options.preset,
    template: options.template,
    include_samples: options.includeSamples ?? true,
  });
  return board.id;
}

export async function openBoard(page: Page, boardId: string): Promise<Locator> {
  await page.goto(`/boards/${boardId}`);
  const canvas = page.getByTestId("board-canvas");
  await expect(canvas).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return canvas;
}

export function column(page: Page, key: string): Locator {
  return page.locator(`.kb-col[data-key="${key}"]`);
}

export async function dragCard(page: Page, card: Locator, target: Locator): Promise<void> {
  await card.scrollIntoViewIfNeeded();
  const from = (await card.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + Math.min(to.height / 2, 60), { steps: 12 });
  await page.waitForTimeout(150);
  await page.mouse.up();
}
