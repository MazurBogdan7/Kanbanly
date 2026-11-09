/** Визуальные снимки: анимации отключены, даты и данные фиксированы примерами пресетов. */
import { expect, test, type Page } from "@playwright/test";

import { createBoardViaApi, openBoard, register, ZIF_TEMPLATE } from "../e2e/helpers";

async function snapshot(page: Page, name: string) {
  await page.addStyleTag({
    content: `.kb-card { content-visibility: visible !important }
      [data-testid="board-toolbar"] input { caret-color: transparent }`,
  });
  await expect(page).toHaveScreenshot(name, {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
}

const CASES = [
  ["zif-gamedev", "dark", "desktop", 1440],
  ["design-studio", "light", "desktop", 1440],
  ["scrum-lite", "compact", "desktop", 1440],
  ["personal", "spacious", "desktop", 1440],
  ["content-plan", "both", "desktop", 1440],
  ["design-studio", "light", "tablet", 1024],
  ["zif-gamedev", "dark", "mobile", 390],
  ["personal", "spacious", "mobile", 390],
] as const;

for (const [preset, label, device, width] of CASES) {
  test(`${preset} · ${label} · ${device}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await register(page);
    const source = preset === "zif-gamedev" ? { template: ZIF_TEMPLATE } : { preset };
    const boardId = await createBoardViaApi(page, { ...source, name: "Снимок" });
    await openBoard(page, boardId);
    await page.mouse.move(0, 0);
    await snapshot(page, `${preset}-${device}.png`);
  });
}
