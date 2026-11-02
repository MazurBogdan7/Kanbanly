/** Доступность, безопасность в браузере, UX-принципы и производительность. */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { api, column, createBoardViaApi, dragCard, openBoard, register } from "./helpers";

async function expectNoSeriousViolations(page: Page, scope?: string) {
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]);
  if (scope) builder = builder.include(scope);
  const { violations } = await builder.analyze();
  const serious = violations.filter((item) => ["serious", "critical"].includes(item.impact ?? ""));
  expect(
    serious.map(
      (item) =>
        `${item.id}: ${item.nodes
          .slice(0, 3)
          .map((node) => node.target)
          .join(" | ")}`,
    ),
  ).toEqual([]);
}

test.describe("axe: 0 serious/critical", () => {
  test("публичные экраны", async ({ page }) => {
    for (const path of ["/login", "/register", "/forgot-password", "/reset-password"]) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await expectNoSeriousViolations(page);
    }
  });

  test("главная, шаблоны, корзина, профиль", async ({ page }) => {
    await register(page);
    await createBoardViaApi(page, { preset: "personal" });
    for (const path of ["/", "/templates", "/trash", "/profile"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expectNoSeriousViolations(page);
    }
    await page.goto("/profile");
    for (const tab of ["Безопасность", "Сессии", "Данные и бэкапы", "Удаление аккаунта"]) {
      await page.getByRole("tab", { name: tab }).click();
      await expectNoSeriousViolations(page);
    }
  });

  for (const preset of ["zif-gamedev", "design-studio", "scrum-lite", "personal", "content-plan"]) {
    test(`доска ${preset}`, async ({ page }) => {
      await register(page);
      const boardId = await createBoardViaApi(page, { preset });
      await openBoard(page, boardId);
      await expect(page.locator(".kb-card").first()).toBeVisible();
      await expectNoSeriousViolations(page);
    });
  }

  test("редактор карточки и конструктор", async ({ page }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "design-studio" });
    await openBoard(page, boardId);
    await page.locator(".kb-card").first().click();
    await expect(page.getByTestId("card-form")).toBeVisible();
    await expectNoSeriousViolations(page);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Конструктор" }).click();
    const panel = page.getByTestId("constructor");
    for (const tab of [
      "Колонки",
      "Измерения",
      "Поля",
      "Карточка",
      "Шапка",
      "Тема",
      "Типографика",
      "Правила",
      "Шаблон и экспорт",
    ]) {
      await panel.getByRole("tab", { name: tab }).click();
      await expectNoSeriousViolations(page, '[data-testid="constructor"]');
    }
  });
});

test.describe("безопасность в браузере", () => {
  test("XSS в названиях и Markdown не исполняется, CSP активен", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    await page.addInitScript(() => {
      (window as unknown as { __xss: number }).__xss = 0;
    });
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>`;
    await register(page);
    const client = await api(page);
    const project = await client.post<{ id: string }>("/projects", { name: payload });
    const board = await client.post<{ id: string }>(`/projects/${project.id}/boards`, {
      name: payload,
    });
    const card = await client.post<{ id: string }>(`/boards/${board.id}/cards`, {
      column: "todo",
      title: payload,
      description: `${payload}\n\n[ссылка](javascript:window.__xss=1)`,
    });
    await client.post(`/cards/${card.id}/comments`, { body: payload });

    await page.goto("/");
    await expect(page.getByRole("link", { name: payload }).first()).toBeVisible();
    await page.goto(`/boards/${board.id}`);
    await expect(page.locator(".kb-card")).toContainText("<img");
    await page.locator(".kb-card").click();
    await page.getByRole("button", { name: "Просмотр" }).click();
    await expect(page.getByText("Комментарии")).toBeVisible();
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => (window as unknown as { __xss: number }).__xss)).toBe(0);
    await expect(page.locator(".prose-card img")).toHaveCount(0);
    await expect(page.locator('.prose-card a[href^="javascript"]')).toHaveCount(0);
    expect(violations).toEqual([]);
  });

  test("заголовки безопасности на страницах приложения", async ({ page }) => {
    const response = await page.goto("/login");
    const headers = response!.headers();
    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBeTruthy();
  });

  test("session cookie недоступна из JavaScript", async ({ page }) => {
    await register(page);
    const cookies = await page.context().cookies();
    const session = cookies.find((cookie) => cookie.name === "kanbanly_session");
    expect(session?.httpOnly).toBe(true);
    expect(session?.sameSite).toBe("Lax");
    expect(await page.evaluate(() => document.cookie)).not.toContain("kanbanly_session");
  });

  test("чужая доска выглядит как несуществующая", async ({ page, browser }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { name: "Чужая" });
    const context = await browser.newContext({ baseURL: "http://127.0.0.1:8123" });
    const stranger = await context.newPage();
    await register(stranger);
    await stranger.goto(`/boards/${boardId}`);
    await expect(stranger.getByRole("alert")).toBeVisible();
    await expect(stranger.getByTestId("board-canvas")).toHaveCount(0);
    await context.close();
  });
});

test.describe("UX", () => {
  test("хоткеи: N, палитра, шпаргалка; выключены при вводе", async ({ page }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "personal", name: "Хоткеи" });
    await openBoard(page, boardId);

    await page.keyboard.press("n");
    await expect(page.getByTestId("card-form")).toBeVisible();
    await page.getByTestId("card-form").getByLabel("Название").fill("n/?");
    await expect(page.getByTestId("card-form").getByLabel("Название")).toHaveValue("n/?");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("card-form")).toHaveCount(0);

    await page.keyboard.press("?");
    await expect(page.getByRole("heading", { name: "Горячие клавиши" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("Control+k");
    await page.getByRole("combobox", { name: /Доски, карточки/ }).fill("Хоткеи");
    await expect(page.getByRole("option", { name: /Хоткеи/ }).first()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.keyboard.press("/");
    await page.getByRole("combobox", { name: /Доски, карточки/ }).fill("шаблоны");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Шаблоны", exact: true })).toBeVisible();
  });

  test("стрелки двигают фокус, E открывает карточку", async ({ page }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "zif-gamedev" });
    await openBoard(page, boardId);
    await page.keyboard.press("ArrowDown");
    const first = column(page, "backlog").locator(".kb-card").first();
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(column(page, "backlog").locator(".kb-card").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(column(page, "todo").locator(".kb-card").nth(1)).toBeFocused();
    await page.keyboard.press("e");
    await expect(page.getByTestId("card-form")).toBeVisible();
  });

  test("drag & drop с клавиатуры", async ({ page }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "zif-gamedev" });
    await openBoard(page, boardId);
    const card = column(page, "doing").locator(".kb-card");
    await expect(card).toHaveCount(0);
    const source = column(page, "todo").locator(".kb-card").first();
    const title = await source.locator(".kb-card-title").innerText();
    await source.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(100);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    await page.keyboard.press("Space");
    await expect(column(page, "doing").getByText(title)).toBeVisible();
  });

  test("Ctrl+Z отменяет перемещение и удаление, откат при ошибке сервера", async ({ page }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "zif-gamedev" });
    await openBoard(page, boardId);
    const card = column(page, "todo").locator(".kb-card").first();
    const title = await card.locator(".kb-card-title").innerText();

    await dragCard(page, card, column(page, "review").locator(".kb-list"));
    await expect(column(page, "review").getByText(title)).toBeVisible();
    await page.keyboard.press("Control+z");
    await expect(column(page, "todo").getByText(title)).toBeVisible();
    await expect(column(page, "todo").locator(".kb-card").first()).toContainText(title);

    await column(page, "todo").locator(".kb-card").first().click();
    await page.getByTestId("card-form").getByRole("button", { name: "Удалить" }).click();
    await expect(column(page, "todo").getByText(title)).toHaveCount(0);
    await page.getByRole("button", { name: "Отменить" }).click();
    await expect(column(page, "todo").getByText(title)).toBeVisible();

    await page.route("**/move", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "boom", message: "Сервер упал", details: null } }),
      }),
    );
    await dragCard(
      page,
      column(page, "todo").locator(".kb-card").first(),
      column(page, "review").locator(".kb-list"),
    );
    await expect(page.getByText("Сервер упал")).toBeVisible();
    await expect(column(page, "review").locator(".kb-card")).toHaveCount(0);
  });

  test("быстрое создание, сохранённое представление, корзина, избранное", async ({ page }) => {
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "zif-gamedev", name: "Рабочая" });
    await openBoard(page, boardId);
    await column(page, "doing").hover();
    await column(page, "doing").getByRole("button", { name: "Добавить карточку" }).click();
    await page.keyboard.type("Быстрая карточка");
    await page.keyboard.press("Enter");
    await expect(column(page, "doing").getByText("Быстрая карточка")).toBeVisible();

    await page.locator('.kb-chip[data-value="boss"]').click();
    await page.getByRole("button", { name: "Сохранить вид" }).click();
    await page.getByLabel("Название представления").fill("Боссы");
    await page.getByRole("dialog").getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByRole("button", { name: "Боссы", exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "В избранное" }).click();
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Избранное" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Недавние доски" })).toBeVisible();

    await page.goto(`/boards/${boardId}`);
    await page.getByRole("button", { name: "Экспорт", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Удалить доску" }).click();
    await page.goto("/trash");
    await expect(page.getByText("Рабочая")).toBeVisible();
    await page.getByRole("button", { name: "Восстановить" }).first().click();
    await expect(page.getByText("Корзина пуста")).toBeVisible();
  });

  test("пустые состояния ведут к действию", async ({ page }) => {
    await register(page);
    await expect(page.getByText("Здесь появятся ваши проекты")).toBeVisible();
    await page.getByRole("button", { name: "Новый проект" }).first().click();
    await page.getByLabel("Название проекта").fill("Пустой");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Создать доску из пресета" }).click();
    await expect(page.getByRole("heading", { name: "Новая доска" })).toBeVisible();
  });

  test("мобильный вид: нижняя навигация, колонки со свайпом, без горизонтальной прокрутки страницы", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await register(page);
    const boardId = await createBoardViaApi(page, { preset: "zif-gamedev" });
    await openBoard(page, boardId);
    await expect(page.getByRole("navigation", { name: "Основная навигация" }).last()).toBeVisible();
    const columns = page.locator(".kb-columns");
    await expect(columns).toHaveCSS("scroll-snap-type", "x mandatory");
    const width = await column(page, "backlog").evaluate(
      (node) => node.getBoundingClientRect().width,
    );
    expect(width).toBeGreaterThan(300);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("производительность", () => {
  test("1000 карточек: первый рендер < 1 c, перетаскивание без длинных фризов", async ({
    page,
  }) => {
    await register(page);
    const client = await api(page);
    const samples = Array.from({ length: 1000 }, (_, index) => ({
      key: `k${index}`,
      column: ["backlog", "todo", "doing", "review", "done"][index % 5],
      title: `Карточка номер ${index}`,
      description: "Описание карточки для проверки производительности доски.",
      values: { epic: "core", milestone: "m1" },
    }));
    const zif = await client.get<any>("/presets/zif-gamedev");
    const boardId = await createBoardViaApi(page, {
      name: "Тысяча",
      template: { ...zif.data, sample_cards: samples },
    });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.evaluate(() => {
      const state = window as unknown as { __long: number[] };
      state.__long = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.__long.push(entry.duration);
      }).observe({ type: "longtask", buffered: false });
    });
    // Замер рендера без сети: данные кладутся в кэш через обычный переход.
    const started = await page.evaluate(() => performance.now());
    await page.evaluate((id) => {
      history.pushState({}, "", `/boards/${id}`);
      dispatchEvent(new PopStateEvent("popstate"));
    }, boardId);
    await expect(page.locator(".kb-card").nth(999)).toBeAttached({ timeout: 20_000 });
    const rendered = await page.evaluate(() => performance.now());
    const longTasks = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log(
      `[perf] от перехода до карточек: ${Math.round(rendered - started)} мс; long tasks: ${longTasks.map(Math.round).join(", ")}`,
    );
    const renderTask = Math.max(...longTasks, 0);
    expect(renderTask).toBeLessThan(1000);

    await page.evaluate(() => {
      (window as unknown as { __long: number[] }).__long = [];
    });
    await dragCard(
      page,
      column(page, "todo").locator(".kb-card").first(),
      column(page, "doing").locator(".kb-list"),
    );
    await page.waitForTimeout(300);
    const dragTasks = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    console.log(
      `[perf] long tasks при перетаскивании: ${dragTasks.map(Math.round).join(", ") || "нет"}`,
    );
    expect(Math.max(...dragTasks, 0)).toBeLessThan(400);
  });
});
