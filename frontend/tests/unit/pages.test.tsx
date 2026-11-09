/** Экраны целиком: настоящий роутер и компоненты, сеть подменена таблицей маршрутов. */
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createQueryClient, safeNext } from "@/app/queryClient";
import { routeTree } from "@/app/router";
import { useToasts } from "@/components/ui/toast";
import { useLocale } from "@/i18n";
import { useUndo } from "@/lib/undo";

import { card, config } from "./fixtures";

const USER = {
  id: "u1",
  email: "user@example.com",
  display_name: "Анна",
  locale: "ru",
  totp_enabled: false,
  created_at: "2026-01-01T00:00:00Z",
};
const SUMMARY = {
  id: "b1",
  project_id: "p1",
  name: "Доска",
  is_favorite: true,
  column_count: 3,
  card_count: 2,
  colors: {
    bg: "#000000",
    surface: "#111111",
    "surface-2": "#222222",
    accent: "#333333",
    text: "#FFFFFF",
    border: "#444444",
  },
  last_opened_at: "2026-01-02T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const PROJECT = {
  id: "p1",
  name: "Проект",
  description: "",
  role: "owner",
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  boards: [SUMMARY],
};
const BOARD = {
  id: "b1",
  project_id: "p1",
  name: "Доска",
  description: "",
  version: 3,
  is_favorite: false,
  role: "owner",
  has_source_template: true,
  source_template_name: "Шаблон",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  config: {
    ...config,
    views: [{ key: "k", name: "Канбан", type: "kanban", is_default: true }, ...config.views!],
  },
  warnings: [],
};
const TEMPLATE_DATA = {
  format: "kanbanly.board-template",
  version: 1,
  meta: { name: "Пресет А", description: "Описание пресета" },
  ...config,
  sample_cards: [{ key: "s1", column: "todo", title: "Пример", values: { epic: "a" } }],
};
const CARD = card({ id: "c1", title: "Первая" });
const DETAIL = {
  ...CARD,
  checklists: [
    {
      id: "l1",
      title: "Шаги",
      position: "a0",
      items: [{ id: "i1", text: "Пункт", done: false, position: "a0" }],
    },
  ],
  comments: [
    {
      id: "m1",
      author_id: "u1",
      author_name: "Анна",
      body: "**Комментарий**",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  attachments: [
    { id: "a1", name: "Макет", url: "https://example.com/a", created_at: "2026-01-01T00:00:00Z" },
  ],
};

type Handler = (body: unknown, url: URL) => unknown;
const calls: { method: string; path: string; body: unknown; headers: Record<string, string> }[] =
  [];
let routes: Record<string, Handler>;

function defaultRoutes(): Record<string, Handler> {
  return {
    "GET /auth/csrf": () => ({ csrf_token: "t" }),
    "GET /auth/me": () => USER,
    "GET /me/invites": () => [],
    "PATCH /auth/me": () => USER,
    "GET /projects": () => ({ items: [PROJECT], next_cursor: null }),
    "POST /projects": () => ({ ...PROJECT, id: "p2", boards: [] }),
    "GET /projects/p1": () => PROJECT,
    "DELETE /projects/p1": () => ({ ok: true }),
    "GET /boards/b1": () => BOARD,
    "GET /boards/b1/preview": () => ({
      id: "b1",
      name: "Доска",
      config: BOARD.config,
      cards: [CARD],
    }),
    "GET /boards/b1/revision": () => ({ revision: "r1" }),
    "GET /projects/p1/members": () => [
      {
        user_id: "u1",
        display_name: "Анна",
        email: "user@example.com",
        role: "owner",
        is_you: true,
      },
      {
        user_id: "u2",
        display_name: "Сергей",
        email: "sergo@example.com",
        role: "editor",
        is_you: false,
      },
    ],
    "GET /projects/p1/invites": () => [
      {
        id: "i9",
        email: "wait@example.com",
        role: "viewer",
        expires_at: "2026-12-01T00:00:00Z",
        created_at: "2026-11-01T00:00:00Z",
      },
    ],
    "POST /projects/p1/invites": (body) => ({
      id: "i10",
      email: (body as { target: string }).target,
      role: "editor",
      invitee_name: (body as { target: string }).target.startsWith("@") ? "Ника" : null,
      expires_at: "2026-12-01T00:00:00Z",
      created_at: "2026-11-01T00:00:00Z",
      link: "http://localhost/invite/tok",
    }),
    "PATCH /projects/p1/members/u2": () => ({
      user_id: "u2",
      display_name: "Сергей",
      email: "sergo@example.com",
      role: "viewer",
      is_you: false,
    }),
    "DELETE /projects/p1/members/u2": () => ({ ok: true }),
    "DELETE /projects/p1/invites/i9": () => ({ ok: true }),
    "GET /invites/tok": () => ({
      project_id: "p1",
      project_name: "Проект",
      role: "editor",
      inviter: "Анна",
    }),
    "POST /invites/tok/accept": () => PROJECT,
    "GET /boards/b1/export.csv": () => "csv",
    "PATCH /boards/b1": () => ({ ...BOARD, name: "Новое имя" }),
    "PUT /boards/b1/config": () => ({ ...BOARD, version: 4 }),
    "POST /boards/b1/reset": () => BOARD,
    "POST /boards/b1/views": () => ({ id: "v" }),
    "GET /boards/b1/template": () => TEMPLATE_DATA,
    "GET /boards/b1/cards": () => ({
      items: [CARD, card({ id: "c2", title: "Вторая", column: "done" })],
      next_cursor: null,
    }),
    "POST /boards/b1/cards": () => card({ id: "c3", title: "Новая" }),
    "GET /cards/c1": () => DETAIL,
    "GET /cards/c1/activity": () => ({
      items: [
        {
          id: "e1",
          actor_name: "Анна",
          action: "moved",
          data: { source: "todo", target: "done" },
          created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "e2",
          actor_name: "Анна",
          action: "created",
          data: {},
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      next_cursor: null,
    }),
    "PATCH /cards/c1": () => ({ ...CARD, title: "Изменена" }),
    "DELETE /cards/c1": () => ({ ok: true }),
    "POST /cards/c1/restore": () => CARD,
    "POST /cards/c1/comments": () => ({}),
    "POST /cards/c1/checklists": () => ({}),
    "POST /cards/c1/attachments": () => ({}),
    "POST /checklists/l1/items": () => ({}),
    "PATCH /checklist-items/i1": () => ({}),
    "GET /presets": () => [{ key: "a", data: TEMPLATE_DATA }],
    "GET /templates": () => ({
      items: [
        {
          id: "t1",
          name: "Мой",
          description: "",
          version: 1,
          created_at: "",
          updated_at: "",
          data: { ...TEMPLATE_DATA, meta: { name: "Мой" } },
        },
      ],
      next_cursor: null,
    }),
    "POST /templates/from-board": () => ({ id: "t2" }),
    "POST /templates/t1/duplicate": () => ({}),
    "DELETE /templates/t1": () => ({ ok: true }),
    "PATCH /templates/t1": () => ({}),
    "POST /templates/import/preview": () => ({
      valid: true,
      name: "Импорт",
      errors: [],
      warnings: ["Неизвестное поле"],
      counts: { columns: 2, dimensions: 1, fields: 0, cards: 3 },
    }),
    "POST /templates/import": () => ({}),
    "POST /projects/p1/boards": () => BOARD,
    "GET /trash": () => [
      {
        type: "board",
        id: "b9",
        name: "Удалённая",
        deleted_at: "2026-01-01T00:00:00Z",
        purge_at: "2026-02-01T00:00:00Z",
      },
    ],
    "POST /boards/b9/restore": () => BOARD,
    "GET /search": () => [
      { type: "card", id: "c1", board_id: "b1", title: "Найдено", subtitle: "Доска" },
    ],
    "GET /auth/sessions": () => [
      {
        id: "s1",
        created_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-01-01T00:00:00Z",
        user_agent: "Chrome",
        ip: "::1",
        current: true,
      },
      {
        id: "s2",
        created_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-01-01T00:00:00Z",
        user_agent: "Firefox",
        ip: "::1",
        current: false,
      },
    ],
    "DELETE /auth/sessions/s2": () => ({ ok: true }),
    "POST /auth/logout": () => ({ ok: true }),
    "POST /auth/logout-all": () => ({ ok: true }),
    "POST /auth/password": () => ({ ok: true }),
    "POST /auth/password-strength": () => ({ breached: true }),
    "POST /auth/2fa/setup": () => ({ secret: "JBSWY3DP", uri: "otpauth://x" }),
    "POST /auth/2fa/enable": () => ({ recovery_codes: ["AAAAA-BBBBB"] }),
    "POST /auth/2fa/disable": () => ({ ok: true }),
    "DELETE /auth/me": () => ({ ok: true }),
    "POST /auth/login": () => USER,
    "POST /auth/register": () => USER,
    "POST /auth/password-reset/request": () => ({ ok: true }),
    "POST /auth/password-reset/confirm": () => ({ ok: true }),
    "GET /backups": () => ({
      snapshots: [
        {
          id: "n1",
          filename: "x.gz",
          reason: "before_replace",
          size: 1,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      events: [{ action: "backup.imported", created_at: "2026-01-01T00:00:00Z", meta: {} }],
    }),
    "POST /import/backup/preview": () => ({
      valid: true,
      encrypted: false,
      password_required: false,
      counts: { projects: 1, boards: 2, cards: 3, templates: 4 },
      conflicts: [{ type: "project", name: "Проект" }],
      warnings: [],
      errors: [],
    }),
    "POST /import/backup": () => ({ mode: "copy", counts: {}, warnings: [], snapshot_id: null }),
    "GET /export/backup": () => ({ format: "kanbanly.backup" }),
    "GET /export/csv": () => "zip",
  };
}

function problem(status: number, code: string, message: string, details?: unknown) {
  return () => {
    throw { status, body: { error: { code, message, details } } };
  };
}

beforeEach(() => {
  routes = defaultRoutes();
  calls.length = 0;
  useToasts.setState({ items: [] });
  useUndo.getState().clear();
  useLocale.setState({ locale: "ru" });
  document.cookie = "kanbanly_csrf=t";
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = () => undefined;
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      const path = url.pathname.replace("/api/v1", "");
      const method = init.method ?? "GET";
      const text = typeof init.body === "string" ? init.body : undefined;
      const body = text ? (JSON.parse(text.startsWith("{") ? text : "{}") as unknown) : undefined;
      calls.push({ method, path, body, headers: (init.headers ?? {}) as Record<string, string> });
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new Error(`Нет маршрута: ${method} ${path}`);
      try {
        return new Response(JSON.stringify(handler(body, url)), { status: 200 });
      } catch (error) {
        const failure = error as { status: number; body: unknown };
        return new Response(JSON.stringify(failure.body), { status: failure.status });
      }
    }),
  );
});

function renderAt(path: string) {
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const sent = (method: string, path: string) =>
  calls.find((call) => call.method === method && call.path === path);

describe("авторизация", () => {
  it("анонима ведёт на вход", async () => {
    routes["GET /auth/me"] = problem(401, "unauthorized", "Войдите");
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Вход" })).toBeInTheDocument();
  });

  it("вход просит второй фактор и показывает ошибки", async () => {
    const user = userEvent.setup();
    routes["GET /auth/me"] = problem(401, "unauthorized", "Войдите");
    routes["POST /auth/login"] = problem(401, "totp_required", "Нужен код");
    const router = renderAt("/login");
    await user.type(await screen.findByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Пароль"), "password-123");
    await user.click(screen.getByRole("button", { name: "Войти" }));
    const code = await screen.findByLabelText("Код из приложения");
    await user.click(screen.getByRole("button", { name: "Использовать резервный код" }));
    expect(screen.getByLabelText("Резервный код")).toBeInTheDocument();
    expect(code).toBeTruthy();

    routes["POST /auth/login"] = problem(401, "invalid_second_factor", "Неверный код");
    await user.type(screen.getByLabelText("Резервный код"), "AAAAA");
    await user.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Неверный код");

    routes["POST /auth/login"] = () => USER;
    await user.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("регистрация показывает утечку и ошибку сервера", async () => {
    const user = userEvent.setup();
    routes["GET /auth/me"] = problem(401, "unauthorized", "Войдите");
    routes["POST /auth/register"] = problem(422, "breached_password", "Пароль в утечках");
    renderAt("/register");
    await user.type(await screen.findByLabelText("Как вас зовут"), "Анна");
    await user.type(screen.getByLabelText("Email"), "a@example.com");
    await user.type(screen.getByLabelText("Пароль"), "password1234");
    expect(await screen.findByText("Этот пароль есть в списках утечек")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Создать аккаунт" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Пароль в утечках");
  });

  it("сброс пароля: запрос и подтверждение", async () => {
    const user = userEvent.setup();
    routes["GET /auth/me"] = problem(401, "unauthorized", "Войдите");
    renderAt("/forgot-password");
    await user.type(await screen.findByLabelText("Email"), "a@example.com");
    await user.click(screen.getByRole("button", { name: "Отправить ссылку" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
  });

  it("новый пароль по ссылке", async () => {
    const user = userEvent.setup();
    routes["GET /auth/me"] = problem(401, "unauthorized", "Войдите");
    renderAt("/reset-password?token=abc");
    await user.type(await screen.findByLabelText("Новый пароль"), "fresh-password-1");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Пароль обновлён");
    expect(sent("POST", "/auth/password-reset/confirm")?.body).toMatchObject({ token: "abc" });
  });
});

describe("главная и проект", () => {
  it("показывает проекты, избранное и недавние", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "Избранное" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Недавние доски" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Проект" })).toBeInTheDocument();
    expect(screen.getAllByText(/2 карточки/).length).toBeGreaterThan(0);
  });

  it("проект раскрывается стрелкой и открывается отдельной кнопкой", async () => {
    const user = userEvent.setup();
    const router = renderAt("/");
    const card = await screen.findByTestId("project-card");
    const toggle = within(card).getByRole("button", { name: "Показать доски проекта «Проект»" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(card).queryByTestId("board-tile")).not.toBeInTheDocument();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(card).getByTestId("board-tile")).toHaveTextContent("Доска");
    await waitFor(() => expect(sent("GET", "/boards/b1/preview")).toBeTruthy());
    await user.click(within(card).getByRole("link", { name: "Открыть проект «Проект»" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"));
  });

  it("новый проект сразу с доской из CSV", async () => {
    const user = userEvent.setup();
    routes["POST /projects/p2/boards/import"] = () => ({
      boards: [{ ...BOARD, id: "b9", project_id: "p2", name: "Спринт" }],
      warnings: [],
    });
    const router = renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Новый проект" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(
      within(dialog).getByLabelText("Доска из файла"),
      new File(["Название;Статус\nА;Готово"], "Спринт.csv", { type: "text/csv" }),
    );
    expect(within(dialog).getByLabelText("Название проекта")).toHaveAttribute(
      "placeholder",
      "Спринт",
    );
    await user.click(within(dialog).getByRole("button", { name: "Создать и импортировать" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/boards/b9"));
    expect(sent("POST", "/projects")?.body).toEqual({ name: "Спринт" });
    const upload = sent("POST", "/projects/p2/boards/import");
    expect(decodeURIComponent(upload?.headers["X-File-Name"] ?? "")).toBe("Спринт.csv");
  });

  it("создаёт проект", async () => {
    const user = userEvent.setup();
    const router = renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Новый проект" }));
    await user.type(screen.getByLabelText("Название проекта"), "Новый");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p2"));
    expect(sent("POST", "/projects")?.body).toEqual({ name: "Новый" });
  });

  it("пустое состояние зовёт к действию", async () => {
    routes["GET /projects"] = () => ({ items: [], next_cursor: null });
    renderAt("/");
    expect(await screen.findByText("Здесь появятся ваши проекты")).toBeInTheDocument();
  });

  it("ошибка загрузки предлагает повторить", async () => {
    routes["GET /projects"] = problem(500, "boom", "Ошибка");
    renderAt("/");
    expect(await screen.findByRole("button", { name: "Повторить" })).toBeInTheDocument();
  });

  it("мастер проводит по шагам и создаёт доску из пресета", async () => {
    const user = userEvent.setup();
    const router = renderAt("/projects/p1");
    await user.click(await screen.findByRole("button", { name: "Новая доска" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Пресет А/ }));
    await user.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await user.click(within(dialog).getByRole("button", { name: /Мята/ }));
    await user.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await user.click(within(dialog).getByRole("button", { name: "Клиент + дедлайн" }));
    await user.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await user.click(within(dialog).getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/boards/b1"));
    const body = sent("POST", "/projects/p1/boards")?.body as {
      template: { theme: { tokens: { accent: string } }; fields: unknown[] };
    };
    expect(body.template.theme.tokens.accent).toBe("#0B7A5E");
    expect(body.template.fields).toHaveLength(3);
  });

  it("пустая доска с колонками из строки и загрузка файла с ошибкой", async () => {
    const user = userEvent.setup();
    renderAt("/projects/p1");
    await user.click(await screen.findByRole("button", { name: "Новая доска" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Из файла (JSON, CSV)" }));
    const input = within(dialog).getByLabelText("Доска из файла");
    // Шаблон Kanbanly с ошибкой разбирается в браузере и показывает проблемы.
    await user.upload(
      input,
      new File(['{"format":"kanbanly.board-template","version":1}'], "x.json", {
        type: "application/json",
      }),
    );
    expect(await within(dialog).findByRole("alert")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Мой шаблон" }));
    await user.click(await within(dialog).findByRole("button", { name: "Мой" }));
    await user.click(within(dialog).getByRole("button", { name: "Пустая доска" }));
    await user.type(within(dialog).getByLabelText("Название доски"), "Пустая");
    await user.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await user.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await user.type(within(dialog).getByLabelText("Колонки"), "Раз, Два, Три");
    await user.click(within(dialog).getByRole("button", { name: "Продолжить" }));
    await user.click(within(dialog).getByRole("button", { name: "Создать доску" }));
    await waitFor(() => expect(sent("POST", "/projects/p1/boards")).toBeTruthy());
    const body = sent("POST", "/projects/p1/boards")?.body as {
      template: { columns: { name: string; kind: string }[] };
    };
    expect(body.template.columns.map((column) => column.kind)).toEqual([
      "todo",
      "in_progress",
      "done",
    ]);
  });

  it("мастер импортирует CSV через сервер и открывает конструктор", async () => {
    const user = userEvent.setup();
    routes["POST /projects/p1/boards/import"] = () => ({
      boards: [{ ...BOARD, id: "b1" }],
      warnings: ["Пропущено строк без названия: 1"],
    });
    const router = renderAt("/projects/p1");
    await user.click(await screen.findByRole("button", { name: "Импорт из файла" }));
    const dialog = await screen.findByRole("dialog");
    await user.upload(
      within(dialog).getByLabelText("Доска из файла"),
      new File(["Название;Статус"], "Задачи.csv", { type: "text/csv" }),
    );
    expect(within(dialog).getByRole("status")).toHaveTextContent("Колонки, карточки");
    expect(within(dialog).getByLabelText("Название доски")).toHaveValue("Задачи");
    await user.click(within(dialog).getByRole("button", { name: "Импортировать" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/boards/b1"));
    expect(sent("POST", "/projects/p1/boards/import")).toBeTruthy();
    expect(await screen.findByText("Пропущено строк без названия: 1")).toBeInTheDocument();
  });

  it("удаляет проект с возможностью отмены", async () => {
    const user = userEvent.setup();
    renderAt("/projects/p1");
    await user.click(await screen.findByRole("button", { name: "Действия с проектом" }));
    await user.click(await screen.findByRole("menuitem", { name: "Удалить проект" }));
    await waitFor(() => expect(sent("DELETE", "/projects/p1")).toBeTruthy());
  });
});

describe("доска", () => {
  const openCard = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByText("Первая"));
    await screen.findByTestId("card-form");
    await screen.findByText("Шаги");
  };

  it("редактирует карточку с If-Match", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await openCard(user);
    const form = screen.getByTestId("card-form");
    await user.clear(within(form).getByLabelText("Название"));
    await user.type(within(form).getByLabelText("Название"), "Изменена");
    await user.click(within(form).getByRole("button", { name: "Просмотр" }));
    await user.selectOptions(within(form).getByLabelText("Веха"), "m2");
    await user.click(within(form).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(sent("PATCH", "/cards/c1")).toBeTruthy());
    const call = sent("PATCH", "/cards/c1")!;
    expect(call.headers["If-Match"]).toBe('"1"');
    expect(call.body).toMatchObject({ title: "Изменена", values: { ms: ["m2"] } });
  });

  it("сообщает о конфликте версий", async () => {
    const user = userEvent.setup();
    routes["PATCH /cards/c1"] = problem(409, "version_conflict", "Конфликт");
    renderAt("/boards/b1");
    await openCard(user);
    await user.click(
      within(screen.getByTestId("card-form")).getByRole("button", { name: "Сохранить" }),
    );
    expect(
      await screen.findByText("Карточку уже изменили. Показана свежая версия."),
    ).toBeInTheDocument();
  });

  it("показывает чек-лист, комментарии, ссылки, историю и добавляет новое", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await openCard(user);
    expect(screen.getByText("Комментарий").tagName).toBe("STRONG");
    expect(screen.getByRole("link", { name: "Макет" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    expect(await screen.findByText(/переместил\(а\): todo → done/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Пункт" }));
    await waitFor(() => expect(sent("PATCH", "/checklist-items/i1")?.body).toEqual({ done: true }));
    await user.type(screen.getByLabelText("Новый пункт"), "Ещё{Enter}");
    await waitFor(() => expect(sent("POST", "/checklists/l1/items")).toBeTruthy());
    await user.type(screen.getByLabelText("Новый чек-лист"), "Этапы{Enter}");
    await waitFor(() => expect(sent("POST", "/cards/c1/checklists")).toBeTruthy());
    await user.type(screen.getByLabelText("Написать комментарий"), "Привет");
    await user.click(screen.getByRole("button", { name: "Отправить" }));
    await waitFor(() => expect(sent("POST", "/cards/c1/comments")).toBeTruthy());
    await user.type(screen.getAllByLabelText("Название").at(-1)!, "Файл");
    await user.type(screen.getByLabelText("https://…"), "https://example.com/f{Enter}");
    await waitFor(() => expect(sent("POST", "/cards/c1/attachments")).toBeTruthy());
  });

  it("удаление карточки с отменой из toast", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await openCard(user);
    await user.click(
      within(screen.getByTestId("card-form")).getByRole("button", { name: "Удалить" }),
    );
    await waitFor(() => expect(sent("DELETE", "/cards/c1")).toBeTruthy());
    await user.click(await screen.findByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(sent("POST", "/cards/c1/restore")).toBeTruthy());
  });

  it("создаёт новую карточку клавишей N", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await screen.findByText("Первая");
    await user.keyboard("n");
    const form = await screen.findByTestId("card-form");
    await user.type(within(form).getByLabelText("Название"), "Новая");
    await user.click(within(form).getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(sent("POST", "/boards/b1/cards")).toBeTruthy());
  });

  it("переименовывает доску, меняет представление, сохраняет вид и шаблон", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    const name = await screen.findByLabelText("Название доски");
    await user.clear(name);
    await user.type(name, "Новое имя{Enter}");
    await waitFor(() => expect(sent("PATCH", "/boards/b1")?.headers["If-Match"]).toBe('"3"'));

    await user.click(screen.getByRole("button", { name: "Таблица" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Сохранить вид" }));
    await user.type(await screen.findByLabelText("Название представления"), "Мой вид");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(sent("POST", "/boards/b1/views")?.body).toMatchObject({ name: "Мой вид" }),
    );

    await user.click(screen.getByRole("button", { name: "В избранное" }));
    await waitFor(() => expect(sent("PATCH", "/boards/b1")).toBeTruthy());
  });

  it("меню экспорта и сброс двойным нажатием", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await screen.findByText("Первая");
    await user.click(screen.getByRole("button", { name: "Экспорт JSON" }));
    await waitFor(() => expect(sent("GET", "/boards/b1/template")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Сброс" }));
    await user.click(screen.getByRole("button", { name: "Точно?" }));
    await waitFor(() => expect(sent("POST", "/boards/b1/reset")?.body).toEqual({ cards: true }));
    expect(await screen.findByText("Доска сброшена к шаблону")).toBeInTheDocument();
  });

  it("зритель не видит конструктор и кнопок правки", async () => {
    const user = userEvent.setup();
    routes["GET /boards/b1"] = () => ({ ...BOARD, role: "viewer" });
    renderAt("/boards/b1");
    await user.click(await screen.findByText("Первая").catch(() => document.body));
    expect(screen.queryByRole("button", { name: "Конструктор" })).toBeNull();
  });

  it("ошибка доски: 404 показан как ошибка с повтором", async () => {
    routes["GET /boards/b1"] = problem(404, "not_found", "Не найдено");
    renderAt("/boards/b1");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("конструктор: правка, отмена, применение и ошибки по путям", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await screen.findByText("Первая");
    await user.click(screen.getByRole("button", { name: "Конструктор" }));
    const panel = await screen.findByTestId("constructor");
    expect(within(panel).getByRole("button", { name: "Применить" })).toBeDisabled();
    const name = within(panel).getAllByLabelText("Название")[0]!;
    await user.clear(name);
    await user.type(name, "Очередь");
    expect(screen.getByText("Есть несохранённые изменения")).toBeInTheDocument();
    expect(document.querySelector(".kb-col-name")).toHaveTextContent("Очередь");
    await user.click(within(panel).getByRole("button", { name: "Отменить шаг" }));
    await user.click(within(panel).getByRole("button", { name: "Вернуть шаг" }));

    routes["PUT /boards/b1/config"] = problem(422, "validation_error", "Ошибка", [
      { path: "columns[0].name", message: "обязательное поле" },
    ]);
    await user.click(within(panel).getByRole("button", { name: "Применить" }));
    expect(await within(panel).findByRole("alert")).toHaveTextContent("columns[0].name");

    routes["PUT /boards/b1/config"] = () => ({ ...BOARD, version: 4 });
    await user.click(within(panel).getByRole("button", { name: "Применить" }));
    expect(await screen.findByText("Настройки применены")).toBeInTheDocument();
    expect(sent("PUT", "/boards/b1/config")?.headers["If-Match"]).toBe('"3"');

    await user.click(within(panel).getByRole("tab", { name: "Шаблон и экспорт" }));
    await user.click(await within(panel).findByRole("button", { name: "Скачать JSON" }));
    await user.click(within(panel).getByRole("button", { name: "Сохранить как шаблон" }));
    await waitFor(() => expect(sent("POST", "/templates/from-board")).toBeTruthy());
    await user.click(within(panel).getByRole("button", { name: "Сбросить к шаблону" }));
    await waitFor(() => expect(sent("POST", "/boards/b1/reset")?.body).toEqual({ cards: false }));

    vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(within(panel).getByRole("button", { name: "Закрыть конструктор" }));
    await waitFor(() => expect(screen.queryByTestId("constructor")).toBeNull());
  });
});

describe("шаблоны", () => {
  it("галерея, импорт с превью и действия над шаблоном", async () => {
    const user = userEvent.setup();
    renderAt("/templates");
    expect(await screen.findByRole("heading", { name: "Пресет А" })).toBeInTheDocument();
    expect((await screen.findAllByTestId("template-thumbnail")).length).toBe(2);

    await user.click(
      screen.getByRole("button", { name: "Скачать пример шаблона со всеми функциями" }),
    );
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/templates/example")).toBe(true),
    );

    await user.click(screen.getByRole("button", { name: "Мой: меню" }));
    await user.click(await screen.findByRole("menuitem", { name: "Дублировать" }));
    await waitFor(() => expect(sent("POST", "/templates/t1/duplicate")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Мой: меню" }));
    await user.click(await screen.findByRole("menuitem", { name: "Переименовать" }));
    const name = await screen.findByLabelText("Название");
    await user.clear(name);
    await user.type(name, "Другой{Enter}");
    await waitFor(() => expect(sent("PATCH", "/templates/t1")?.body).toEqual({ name: "Другой" }));

    await user.click(screen.getByRole("button", { name: "Мой: меню" }));
    await user.click(await screen.findByRole("menuitem", { name: "Удалить" }));
    await waitFor(() => expect(sent("DELETE", "/templates/t1")).toBeTruthy());
  });

  it("загружает файл: превью, предупреждения, подтверждение", async () => {
    const user = userEvent.setup();
    renderAt("/templates");
    await screen.findByRole("heading", { name: "Пресет А" });
    const file = new File(
      [
        JSON.stringify({
          format: "kanbanly.board-template",
          version: 1,
          meta: { name: "Импорт" },
          columns: [{ key: "a", name: "A" }],
        }),
      ],
      "t.json",
    );
    await user.upload(screen.getAllByLabelText("Загрузить шаблон")[0]!, file);
    expect(await screen.findByTestId("import-counts")).toHaveTextContent("колонок 2");
    expect(screen.getByText("Предупреждения: 1")).toBeInTheDocument();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Загрузить шаблон" }),
    );
    expect(await screen.findByText("Шаблон добавлен в библиотеку")).toBeInTheDocument();
  });

  it("показывает ошибки сервера с путями", async () => {
    const user = userEvent.setup();
    routes["POST /templates/import/preview"] = () => ({
      valid: false,
      errors: [{ path: "columns[3].color", message: "неверный формат цвета" }],
    });
    renderAt("/templates");
    await screen.findByRole("heading", { name: "Пресет А" });
    const file = new File(
      [
        JSON.stringify({
          format: "kanbanly.board-template",
          version: 1,
          meta: { name: "И" },
          columns: [{ key: "a", name: "A" }],
        }),
      ],
      "t.json",
    );
    await user.upload(screen.getAllByLabelText("Загрузить шаблон")[0]!, file);
    expect(await screen.findByText("columns[3].color:")).toBeInTheDocument();
  });

  it("создаёт доску из шаблона в выбранном проекте", async () => {
    const user = userEvent.setup();
    const router = renderAt("/templates");
    const [first] = await screen.findAllByRole("button", { name: "Создать доску" });
    await user.click(first!);
    const dialog = await screen.findByRole("dialog");
    await screen.findByRole("option", { name: "Проект" });
    await user.click(within(dialog).getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/boards/b1"));
  });
});

describe("корзина", () => {
  it("восстанавливает объект", async () => {
    const user = userEvent.setup();
    renderAt("/trash");
    expect(await screen.findByText("Удалённая")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Восстановить" }));
    await waitFor(() => expect(sent("POST", "/boards/b9/restore")).toBeTruthy());
    expect(await screen.findByText("Восстановлено")).toBeInTheDocument();
  });

  it("пустое состояние", async () => {
    routes["GET /trash"] = () => [];
    renderAt("/trash");
    expect(await screen.findByText("Корзина пуста")).toBeInTheDocument();
  });
});

describe("профиль", () => {
  it("меняет данные, пароль, включает и отключает 2FA", async () => {
    const user = userEvent.setup();
    renderAt("/profile");
    await user.clear(await screen.findByLabelText("Как вас зовут"));
    await user.type(screen.getByLabelText("Как вас зовут"), "Новое");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(sent("PATCH", "/auth/me")).toBeTruthy());
    await user.selectOptions(screen.getByLabelText("Язык интерфейса"), "en");
    expect(useLocale.getState().locale).toBe("en");
    act(() => useLocale.setState({ locale: "ru" }));

    await user.click(screen.getByRole("tab", { name: "Безопасность" }));
    await user.type(await screen.findByLabelText("Текущий пароль"), "old-password-1");
    await user.type(screen.getByLabelText("Новый пароль"), "new-password-12");
    await user.click(screen.getByRole("button", { name: "Сменить пароль" }));
    expect(await screen.findByText("Пароль изменён, другие сессии завершены")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Включить 2FA" }));
    expect(await screen.findByTestId("totp-secret")).toHaveTextContent("JBSWY3DP");
    await user.type(screen.getByLabelText("Код подтверждения"), "123456");
    await user.click(screen.getByRole("button", { name: "Включить 2FA" }));
    expect(await screen.findByText(/AAAAA-BBBBB/)).toBeInTheDocument();
  });

  it("отключает 2FA, если она включена", async () => {
    const user = userEvent.setup();
    routes["GET /auth/me"] = () => ({ ...USER, totp_enabled: true });
    renderAt("/profile");
    await user.click(await screen.findByRole("tab", { name: "Безопасность" }));
    await user.type(await screen.findByLabelText("Пароль"), "password-123");
    await user.click(screen.getByRole("button", { name: "Отключить 2FA" }));
    await waitFor(() => expect(sent("POST", "/auth/2fa/disable")).toBeTruthy());
  });

  it("управляет сессиями", async () => {
    const user = userEvent.setup();
    const router = renderAt("/profile");
    await user.click(await screen.findByRole("tab", { name: "Сессии" }));
    expect(await screen.findByText("Текущая")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(sent("DELETE", "/auth/sessions/s2")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Выйти на всех устройствах" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("удаляет аккаунт только с паролем", async () => {
    const user = userEvent.setup();
    const router = renderAt("/profile");
    await user.click(await screen.findByRole("tab", { name: "Удаление аккаунта" }));
    const button = await screen.findByRole("button", { name: "Удалить аккаунт и все данные" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Пароль"), "password-123");
    await user.click(button);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("бэкап: экспорт, превью с конфликтами, замена требует слово", async () => {
    const user = userEvent.setup();
    renderAt("/profile");
    await user.click(await screen.findByRole("tab", { name: "Данные и бэкапы" }));
    await user.selectOptions(await screen.findByLabelText("Что выгрузить"), "project:p1");
    await user.click(screen.getByRole("switch", { name: "Сжать (.json.gz)" }));
    await user.click(screen.getByRole("button", { name: "Скачать бэкап" }));
    await waitFor(() => expect(calls.some((call) => call.path === "/export/backup")).toBe(true));
    await user.click(screen.getByRole("button", { name: "Скачать таблицы для Excel (CSV в ZIP)" }));
    await waitFor(() => expect(calls.find((call) => call.path === "/export/csv")).toBeTruthy());
    expect(await screen.findByText(/Автоснимок/)).toBeInTheDocument();

    await user.upload(screen.getByLabelText("Выбрать файл бэкапа"), new File(["{}"], "b.json"));
    expect(await screen.findByTestId("backup-preview")).toHaveTextContent("досок 2");
    expect(screen.getByText(/Конфликты: Проект/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Заменить существующие" }));
    const restore = screen.getByRole("button", { name: "Восстановить" });
    expect(restore).toBeDisabled();
    await user.type(screen.getByLabelText("Введите слово ЗАМЕНИТЬ"), "ЗАМЕНИТЬ");
    await user.click(restore);
    await waitFor(() => expect(sent("POST", "/import/backup")).toBeTruthy());
    expect(await screen.findByText("Данные восстановлены")).toBeInTheDocument();
  });

  it("бэкап: зашифрованный файл просит пароль, ошибка показана", async () => {
    const user = userEvent.setup();
    routes["POST /import/backup/preview"] = () => ({
      valid: false,
      encrypted: true,
      password_required: true,
      errors: [{ path: "", message: "Неверный пароль или файл повреждён" }],
    });
    renderAt("/profile");
    await user.click(await screen.findByRole("tab", { name: "Данные и бэкапы" }));
    await user.upload(
      await screen.findByLabelText("Выбрать файл бэкапа"),
      new File(["{}"], "b.json"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Неверный пароль");
    await user.type(screen.getByLabelText("Пароль бэкапа"), "secret-1");
    await user.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() => expect(calls.at(-1)?.headers["X-Backup-Password"]).toBe("secret-1"));
  });
});

describe("оболочка", () => {
  it("палитра находит результаты и выполняет команды", async () => {
    const user = userEvent.setup();
    const router = renderAt("/");
    await screen.findByRole("heading", { name: "Проекты" });
    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByRole("combobox");
    await user.type(input, "найд");
    expect(await screen.findByRole("option", { name: /Найдено/ })).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/boards/b1"));
  });

  it("палитра: стрелки и пустой результат", async () => {
    const user = userEvent.setup();
    routes["GET /search"] = () => [];
    const router = renderAt("/");
    await screen.findByRole("heading", { name: "Проекты" });
    await user.keyboard("/");
    await screen.findByRole("combobox");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/templates"));
    await user.keyboard("/");
    await user.type(await screen.findByRole("combobox"), "абракадабра");
    expect(await screen.findByText("Ничего не найдено")).toBeInTheDocument();
  });

  it("шпаргалка по ?", async () => {
    const user = userEvent.setup();
    renderAt("/");
    await screen.findByRole("heading", { name: "Проекты" });
    await user.keyboard("?");
    expect(await screen.findByRole("heading", { name: "Горячие клавиши" })).toBeInTheDocument();
  });

  it("выход завершает сессию", async () => {
    const user = userEvent.setup();
    const router = renderAt("/");
    await user.click(await screen.findByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });
});

describe("совместная работа", () => {
  it("владелец видит участников, меняет роль, приглашает и отзывает", async () => {
    const user = userEvent.setup();
    renderAt("/projects/p1");
    expect(await screen.findByText("sergo@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Анна \(вы\)/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Роль: Сергей"), "viewer");
    await waitFor(() =>
      expect(sent("PATCH", "/projects/p1/members/u2")?.body).toEqual({ role: "viewer" }),
    );
    await user.click(screen.getByRole("button", { name: "Убрать из проекта: Сергей" }));
    await waitFor(() => expect(sent("DELETE", "/projects/p1/members/u2")).toBeTruthy());

    await user.type(screen.getByLabelText("Email или ник"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "Пригласить" }));
    expect(await screen.findByTestId("invite-link")).toHaveTextContent(
      "http://localhost/invite/tok",
    );
    expect(sent("POST", "/projects/p1/invites")?.body).toEqual({
      target: "new@example.com",
      role: "editor",
    });
    await user.click(screen.getByRole("button", { name: "Отозвать" }));
    await waitFor(() => expect(sent("DELETE", "/projects/p1/invites/i9")).toBeTruthy());
  });

  it("приглашение по нику уходит во входящие, отклонённое можно отправить снова", async () => {
    const user = userEvent.setup();
    routes["GET /projects/p1/invites"] = () => [
      {
        id: "i8",
        email: "nika@example.com",
        role: "viewer",
        expires_at: "2026-12-01T00:00:00Z",
        created_at: "2026-11-01T00:00:00Z",
        invitee_name: "Ника",
        invitee_username: "nika",
        status: "declined",
      },
    ];
    renderAt("/projects/p1");
    const row = await screen.findByTestId("project-invite");
    expect(row).toHaveTextContent("@nika");
    expect(row).toHaveTextContent("отклонено");
    await user.click(within(row).getByRole("button", { name: "Пригласить снова" }));
    await waitFor(() =>
      expect(sent("POST", "/projects/p1/invites")?.body).toEqual({
        target: "nika@example.com",
        role: "viewer",
      }),
    );
    calls.length = 0;
    await user.type(screen.getByLabelText("Email или ник"), "@nika");
    await user.click(screen.getByRole("button", { name: "Пригласить" }));
    expect(await screen.findByText(/Ника увидит его в профиле/)).toBeInTheDocument();
    expect(screen.queryByTestId("invite-link")).not.toBeInTheDocument();
  });

  it("входящие приглашения: принять и отклонить, значок в меню", async () => {
    const user = userEvent.setup();
    const incoming = [
      {
        id: "x1",
        project_id: "p1",
        project_name: "Игра",
        role: "editor",
        inviter: "Анна",
        created_at: "2026-11-01T00:00:00Z",
        expires_at: "2026-11-08T00:00:00Z",
      },
      {
        id: "x2",
        project_id: "p3",
        project_name: "Сайт",
        role: "viewer",
        inviter: "Борис",
        created_at: "2026-11-01T00:00:00Z",
        expires_at: "2026-11-08T00:00:00Z",
      },
    ];
    routes["GET /me/invites"] = () => incoming;
    routes["POST /me/invites/x2/decline"] = () => {
      incoming.splice(1, 1);
      return { ok: true };
    };
    routes["POST /me/invites/x1/accept"] = () => ({ ...PROJECT, name: "Игра" });
    const router = renderAt("/profile?tab=invites");
    expect((await screen.findAllByLabelText("Новых приглашений: 2")).length).toBeGreaterThan(0);
    const rows = await screen.findAllByTestId("incoming-invite");
    expect(rows[0]).toHaveTextContent("Пригласил(а) Анна, роль: редактор");
    await user.click(within(rows[1]!).getByRole("button", { name: "Отклонить" }));
    await waitFor(() => expect(screen.getAllByTestId("incoming-invite")).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Принять" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"));
  });

  it("участник без прав владельца видит роли текстом и может выйти", async () => {
    const user = userEvent.setup();
    routes["GET /projects/p1"] = () => ({ ...PROJECT, role: "editor" });
    routes["GET /projects/p1/members"] = () => [
      {
        user_id: "u0",
        display_name: "Владелец",
        email: "o@example.com",
        role: "owner",
        is_you: false,
      },
      {
        user_id: "u2",
        display_name: "Сергей",
        email: "sergo@example.com",
        role: "editor",
        is_you: true,
      },
    ];
    routes["DELETE /projects/p1/members/u2"] = () => ({ ok: true });
    const router = renderAt("/projects/p1");
    expect(await screen.findByText("Редактор")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email приглашённого")).toBeNull();
    expect(calls.some((call) => call.path === "/projects/p1/invites")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Покинуть проект" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("принимает приглашение по ссылке", async () => {
    const user = userEvent.setup();
    const router = renderAt("/invite/tok");
    expect(await screen.findByText(/Анна приглашает вас в проект «Проект»/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Принять приглашение" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"));
  });

  it("недействительное приглашение объясняет причину", async () => {
    routes["GET /invites/tok"] = problem(404, "not_found", "Не найдено");
    renderAt("/invite/tok");
    expect(await screen.findByText("Приглашение недействительно")).toBeInTheDocument();
  });

  it("аноним по ссылке-приглашению попадает на вход и возвращается обратно", async () => {
    const user = userEvent.setup();
    let loggedIn = false;
    routes["GET /auth/me"] = () => {
      if (!loggedIn) {
        throw { status: 401, body: { error: { code: "unauthorized", message: "Войдите" } } };
      }
      return USER;
    };
    routes["POST /auth/login"] = () => {
      loggedIn = true;
      return USER;
    };
    const router = renderAt("/invite/tok");
    await user.type(await screen.findByLabelText("Email"), "user@example.com");
    expect(router.state.location.search).toEqual({ next: "/invite/tok" });
    await user.type(screen.getByLabelText("Пароль"), "password-123");
    await user.click(screen.getByRole("button", { name: "Войти" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/invite/tok"));
  });
});

describe("сессия", () => {
  it("истёкшая сессия посреди работы ведёт на вход", async () => {
    const user = userEvent.setup();
    const router = renderAt("/");
    await screen.findByRole("heading", { name: "Проекты" });
    routes["POST /projects"] = problem(401, "unauthorized", "Сессия истекла, войдите снова");
    await user.click(screen.getByRole("button", { name: "Новый проект" }));
    await user.type(screen.getByLabelText("Название проекта"), "Х");
    await user.click(screen.getByRole("button", { name: "Создать" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await screen.findByText("Сессия истекла. Войдите снова.")).toBeInTheDocument();
  });

  it("возврат после входа только на свои страницы", () => {
    expect(safeNext("/boards/1")).toBe("/boards/1");
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("https://evil.test")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("доска: новые возможности", () => {
  it("подхватывает чужие изменения по смене ревизии", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt("/boards/b1");
    await screen.findByText("Первая");
    routes["GET /boards/b1/revision"] = () => ({ revision: "r2" });
    routes["GET /boards/b1/cards"] = () => ({
      items: [CARD, card({ id: "c9", title: "От коллеги" })],
      next_cursor: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    expect(await screen.findByText("От коллеги")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("скачивает таблицу CSV из меню доски", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await screen.findByText("Первая");
    await user.click(screen.getByRole("button", { name: "Экспорт" }));
    await user.click(await screen.findByRole("menuitem", { name: /CSV/ }));
    await waitFor(() =>
      expect(calls.some((call) => call.path === "/boards/b1/export.csv")).toBe(true),
    );
  });

  it("импорт экспорта прототипа создаёт новую доску рядом", async () => {
    const user = userEvent.setup();
    renderAt("/boards/b1");
    await screen.findByText("Первая");
    const tasks = [
      {
        id: "t1",
        status: "done",
        epic: "a",
        ms: 1,
        title: "Из прототипа",
        desc: "Описание",
        who: "Анна Белова",
      },
      { id: "t2", status: "nope", epic: "b", ms: 2, title: "Без колонки" },
    ];
    await user.upload(
      screen.getByLabelText("Импорт"),
      new File([JSON.stringify(tasks)], "zif.json", { type: "application/json" }),
    );
    await waitFor(() => expect(sent("POST", "/projects/p1/boards")).toBeTruthy());
    const body = sent("POST", "/projects/p1/boards")!.body as {
      name: string;
      template: { sample_cards: unknown[] };
    };
    expect(body.name).toBe("Доска (импорт)");
    expect(body.template.sample_cards).toEqual([
      {
        key: "p1",
        column: "done",
        title: "Из прототипа",
        description: "Описание",
        values: { epic: "a", ms: "m1", who: "ann" },
      },
    ]);
    expect(await screen.findByText("Импортировано задач: 1. Пропущено: 1.")).toBeInTheDocument();
  });

  it("календарь и таймлайн показывают карточки", async () => {
    const user = userEvent.setup();
    routes["GET /boards/b1"] = () => ({
      ...BOARD,
      config: {
        ...BOARD.config,
        views: [
          { key: "k", name: "Канбан", type: "kanban", is_default: true },
          { key: "c", name: "Календарь", type: "calendar" },
          { key: "l", name: "Таймлайн", type: "timeline", group_by: "ms" },
        ],
      },
    });
    const today = new Date().toISOString().slice(0, 10);
    routes["GET /boards/b1/cards"] = () => ({
      items: [
        card({ id: "c1", title: "С датой", due_date: today }),
        card({ id: "c2", title: "Без даты", values: { ms: ["m2"] } }),
      ],
      next_cursor: null,
    });
    routes["GET /cards/c2"] = () => ({ ...DETAIL, id: "c2", title: "Без даты" });
    routes["GET /cards/c2/activity"] = () => ({ items: [], next_cursor: null });
    renderAt("/boards/b1");
    await screen.findByText("С датой");
    await user.click(screen.getByRole("button", { name: "Календарь" }));
    const day = document.querySelector(`[data-date="${today}"]`) as HTMLElement;
    expect(within(day).getByRole("button", { name: "С датой" })).toBeInTheDocument();
    expect(screen.getByText("Без срока: 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Следующий месяц" }));
    await user.click(screen.getByRole("button", { name: "Сегодня" }));
    expect(document.querySelector(`[data-date="${today}"]`)).toHaveAttribute("data-today");

    await user.click(screen.getByRole("button", { name: "Таймлайн" }));
    const stage = document.querySelector('[data-value="m2"]') as HTMLElement;
    await user.click(within(stage).getByRole("button", { name: /Без даты/ }));
    expect(await screen.findByTestId("card-form")).toBeInTheDocument();
  });
});
