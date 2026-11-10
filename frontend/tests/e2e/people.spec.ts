/** Аватар с кадрированием и статус: видно в профиле, шапке, участниках и на доске у коллеги. */
import zlib from "node:zlib";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { api, openBoard, register, uniqueEmail } from "./helpers";

/** Настоящий PNG 400×200: левая половина красная, правая синяя. */
function twoColorPng(): Buffer {
  const width = 400;
  const height = 200;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    const [r, g, b] = x < width / 2 ? [220, 30, 30] : [30, 60, 220];
    row.set([r, g, b], 1 + x * 3);
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function teammate(browser: Browser): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:8123", locale: "ru-RU" });
  const page = await context.newPage();
  const email = await register(page, uniqueEmail());
  return { page, email };
}

/** Средний цвет центра картинки аватара. */
async function centerColor(page: Page, selector: string): Promise<number[]> {
  return page
    .locator(selector)
    .first()
    .evaluate(async (node: HTMLImageElement) => {
      await node.decode();
      const canvas = document.createElement("canvas");
      canvas.width = node.naturalWidth;
      canvas.height = node.naturalHeight;
      const context = canvas.getContext("2d");
      context?.drawImage(node, 0, 0);
      const pixel = context?.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data ?? [];
      return Array.from(pixel).slice(0, 3);
    });
}

test("аватар кадрируется под круг и виден коллеге на доске вместе со статусом", async ({
  page,
  browser,
}) => {
  await register(page);
  const owner = await api(page);
  const project = await owner.post<{ id: string }>("/projects", { name: "Команда" });
  const board = await owner.post<{ id: string }>(`/projects/${project.id}/boards`, {
    name: "Доска",
    preset: "personal",
  });

  // Коллега загружает фото и сдвигает круг на синюю половину.
  const mate = await teammate(browser);
  await mate.page.goto("/profile");
  await mate.page
    .getByTestId("avatar-input")
    .setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: twoColorPng() });
  const crop = mate.page.getByTestId("avatar-crop");
  await expect(crop.locator("img")).toBeVisible();
  const box = await crop.boundingBox();
  if (!box) throw new Error("нет области кадрирования");
  await mate.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await mate.page.mouse.down();
  await mate.page.mouse.move(box.x + box.width / 2 - 200, box.y + box.height / 2, { steps: 8 });
  await mate.page.mouse.up();
  const dialog = mate.page.getByRole("dialog");
  await dialog.getByLabel("Масштаб", { exact: true }).fill("1.5");
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(mate.page.getByText("Фото профиля обновлено")).toBeVisible();
  const own = mate.page.getByTestId("avatar-section").locator("img");
  await expect(own).toBeVisible();
  // В аватар попала синяя половина.
  const [red, , blue] = await centerColor(mate.page, '[data-testid="avatar-section"] img');
  expect(blue).toBeGreaterThan(150);
  expect(red).toBeLessThan(100);

  // Статус «Занят» из меню в шапке.
  await mate.page.getByTestId("user-menu").click();
  await mate.page.getByRole("menuitem", { name: "Занят" }).click();
  await expect(mate.page.getByTestId("user-menu")).toHaveAccessibleName(/Занят/);

  await owner.post(`/projects/${project.id}/invites`, { target: mate.email });
  const inbox = await api(mate.page);
  const [invite] = await inbox.get<{ id: string }[]>("/me/invites");
  await inbox.post(`/me/invites/${invite?.id}/accept`, {});

  await openBoard(page, board.id);
  const team = page.getByTestId("team-avatars");
  await expect(team).toHaveAccessibleName("Команда: в сети 2 из 2");
  const busy = team.locator('[data-status="busy"]');
  await expect(busy).toHaveCount(1);
  await expect(busy.locator("img")).toBeVisible();
  await expect(team.locator('[data-status="online"]')).toHaveCount(1);

  await page.goto(`/projects/${project.id}`);
  await expect(page.getByText(/Занят · .*@example\.com/)).toBeVisible();
  await mate.page.context().close();
});

test("невидимка выглядит офлайн, удалённое фото сменяется инициалами", async ({ page }) => {
  await register(page);
  await page.goto("/profile");
  await page
    .getByTestId("avatar-input")
    .setInputFiles({ name: "p.png", mimeType: "image/png", buffer: twoColorPng() });
  await page.getByRole("dialog").getByRole("button", { name: "Сохранить" }).click();
  await expect(page.getByTestId("user-menu").locator("img")).toBeVisible();
  await page.getByRole("radio", { name: /Невидимка/ }).click();
  await expect(page.getByTestId("user-menu")).toHaveAccessibleName(/Офлайн/);
  await page.getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByTestId("user-menu").locator("img")).toHaveCount(0);
});
