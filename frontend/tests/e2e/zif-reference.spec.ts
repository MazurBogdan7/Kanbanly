/** Эталон: доска из пресета ZIF против исходного прототипа. */
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { column, createBoardViaApi, dragCard, openBoard, register } from "./helpers";

const PROTOTYPE = path.resolve(import.meta.dirname, "../../../docs/reference/ZIF_kanban.html");
const OUTPUT = path.resolve(import.meta.dirname, "../../test-results/zif");
/** Доля различающихся пикселей, которую допускает эталон (см. docs/DECISIONS.md). */
const MAX_DIFF_RATIO = 0.03;

function fontFaces(): string {
  const root = path.resolve(import.meta.dirname, "../../node_modules/@fontsource");
  const faces: string[] = [];
  const add = (family: string, folder: string, weight: number) => {
    for (const subset of ["latin", "cyrillic"]) {
      const file = path.join(root, folder, "files", `${folder}-${subset}-${weight}-normal.woff2`);
      const data = fs.readFileSync(file).toString("base64");
      faces.push(
        `@font-face{font-family:"${family}";font-weight:${weight};src:url(data:font/woff2;base64,${data})}`,
      );
    }
  };
  for (const weight of [400, 500, 600]) add("Inter", "inter", weight);
  for (const weight of [600, 700]) add("Cormorant SC", "cormorant-sc", weight);
  return `<style>${faces.join("")}</style>`;
}

async function openPrototype(page: Page): Promise<Locator> {
  // about:blank без CSP приложения; шрифты — те же файлы: сравнивается вёрстка, а не сеть.
  const html = fs
    .readFileSync(PROTOTYPE, "utf-8")
    .replace(/<link[^>]+fonts\.g[^>]+>/g, "")
    .replace("</head>", `${fontFaces()}</head>`);
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('700 26px "Cormorant SC"', "ZIF Я"),
      document.fonts.load('400 14px "Inter"', "Я"),
      document.fonts.load('500 12px "Inter"', "Я"),
      document.fonts.load('600 13px "Inter"', "Я"),
    ]);
    await document.fonts.ready;
  });
  return page.locator("html");
}

async function diffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([first, second]) => {
      const load = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        return image;
      };
      const [imageA, imageB] = await Promise.all([load(first!), load(second!)]);
      const width = Math.min(imageA.width, imageB.width);
      const height = Math.min(imageA.height, imageB.height);
      const read = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
      };
      const dataA = read(imageA);
      const dataB = read(imageB);
      let different = 0;
      for (let index = 0; index < dataA.length; index += 4) {
        const delta =
          Math.abs(dataA[index]! - dataB[index]!) +
          Math.abs(dataA[index + 1]! - dataB[index + 1]!) +
          Math.abs(dataA[index + 2]! - dataB[index + 2]!);
        if (delta > 60) different += 1;
      }
      return different / (width * height);
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

async function compare(page: Page, viewport: { width: number; height: number }, label: string) {
  await page.setViewportSize(viewport);
  await register(page);
  const boardId = await createBoardViaApi(page, { preset: "zif-gamedev", name: "ZIF" });
  const canvas = await openBoard(page, boardId);
  await page.mouse.move(0, 0);
  // Сравнивается доска: оболочка приложения скрыта, внутренний скролл развёрнут как в прототипе.
  await page.addStyleTag({
    content: `[data-testid="board-toolbar"], #root > div > header, #root > div > nav { display: none !important }
      html, body, #root, #root > div, #main, [data-testid="board-scroll"] {
        height: auto !important; overflow: visible !important; padding-bottom: 0 !important;
      }
      .kb-card { content-visibility: visible !important }`,
  });
  await expect(canvas.locator(".kb-card").first()).toBeVisible();
  const app = await page.screenshot({ animations: "disabled", fullPage: true });

  const prototype = await page.context().newPage();
  await prototype.setViewportSize(viewport);
  await openPrototype(prototype);
  const reference = await prototype.screenshot({ animations: "disabled", fullPage: true });

  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT, `${label}-app.png`), app);
  fs.writeFileSync(path.join(OUTPUT, `${label}-prototype.png`), reference);
  const ratio = await diffRatio(prototype, app, reference);
  console.log(`[${label}] расхождение: ${(ratio * 100).toFixed(2)}%`);
  expect(ratio).toBeLessThan(MAX_DIFF_RATIO);
}

test("десктоп совпадает с прототипом", async ({ page }) => {
  await compare(page, { width: 1440, height: 900 }, "desktop");
});

test("390 px совпадает с прототипом", async ({ page }) => {
  await compare(page, { width: 390, height: 844 }, "mobile");
});

test("функциональность прототипа: прогресс, чипы, селекты, поиск, зачёркивание, DnD, правка", async ({
  page,
}) => {
  await register(page);
  const boardId = await createBoardViaApi(page, { preset: "zif-gamedev", name: "ZIF" });
  await openBoard(page, boardId);

  await expect(page.getByTestId("progress-m1")).toHaveText(/^6\/\d+$/);
  const counter = column(page, "done").locator(".kb-col-head em");
  await expect(counter).toHaveText("6");
  await expect(column(page, "done").locator(".kb-card-title").first()).toHaveCSS(
    "text-decoration-line",
    "line-through",
  );
  await expect(column(page, "done").locator(".kb-card").first()).toHaveAttribute(
    "data-dim",
    "true",
  );
  const dimmed = await column(page, "done")
    .locator(".kb-card-body")
    .first()
    .evaluate((node) => Number(getComputedStyle(node).opacity));
  expect(dimmed).toBeLessThan(1);

  await page.locator('.kb-chip[data-value="core"]').click();
  await expect(page.locator('.kb-chip[data-value="core"]')).toHaveAttribute("aria-pressed", "true");
  await expect(column(page, "done").locator(".kb-card")).toHaveCount(1);
  await page.locator('.kb-chip[data-value="core"]').click();

  await page.locator('select[data-dimension="milestone"]').selectOption("m4");
  await expect(column(page, "done").locator(".kb-card")).toHaveCount(0);
  await expect(column(page, "done").locator(".kb-empty")).toHaveText("Пусто");
  await page.locator('select[data-dimension="milestone"]').selectOption("");

  await page.getByRole("searchbox").fill("Ламия — босс");
  await expect(page.locator(".kb-card")).toHaveCount(1);
  await page.getByRole("searchbox").fill("");

  const card = column(page, "todo").locator(".kb-card").first();
  const title = await card.locator(".kb-card-title").innerText();
  await dragCard(page, card, column(page, "done").locator(".kb-list"));
  await expect(column(page, "done").getByText(title)).toBeVisible();
  await expect(page.getByTestId("progress-m1")).toHaveText(/^7\/\d+$/);
  await page.reload();
  await expect(column(page, "done").getByText(title)).toBeVisible();

  await column(page, "done").getByText(title).click();
  const form = page.getByTestId("card-form");
  await form.getByLabel("Название").fill(`${title} изменено`);
  await form.getByLabel("Исполнитель").selectOption("sergo");
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(column(page, "done").getByText(`${title} изменено`)).toBeVisible();
  await expect(column(page, "done").locator(".kb-tag", { hasText: "SERGO" })).toBeVisible();
});

test("в коде нет веток под пресет", async () => {
  const roots = ["../../src", "../../../backend/app"].map((item) =>
    path.resolve(import.meta.dirname, item),
  );
  const hits: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "presets" && entry.name !== "__pycache__") walk(full);
      } else if (/\.(ts|tsx|py|css)$/.test(entry.name) && !entry.name.includes("schema.gen")) {
        const text = fs.readFileSync(full, "utf-8");
        if (/zif|сизиф/i.test(text)) hits.push(full);
      }
    }
  };
  roots.forEach(walk);
  expect(hits).toEqual([]);
});
