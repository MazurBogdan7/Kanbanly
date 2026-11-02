import { generateKeyBetween } from "fractional-indexing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { passwordStrength } from "@/features/auth/session";
import { pluralize, translate } from "@/i18n";
import { en } from "@/i18n/en";
import { ru } from "@/i18n/ru";
import { api, ApiError, send } from "@/lib/api/client";
import {
  blend,
  contrastRatio,
  ensureContrast,
  luminance,
  parseHex,
  readableOpacity,
  readableText,
} from "@/lib/contrast";
import { isTyping, matchHotkey } from "@/lib/hotkeys";
import { renderMarkdown } from "@/lib/markdown";
import { isSafeImageUrl, parseTemplateText } from "@/lib/templateFile";
import { useUndo } from "@/lib/undo";

describe("контраст", () => {
  it("считает WCAG-отношение", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    expect(luminance("#FFFFFF")).toBeCloseTo(1);
    expect(luminance("bad")).toBe(0);
    expect(parseHex("#12")).toBeNull();
    expect(parseHex("#010203FF")).toEqual([1, 2, 3]);
  });

  it("автотекст читаем на светлом и тёмном фоне", () => {
    expect(readableText("#F5E6A3")).toBe("#111111");
    expect(readableText("#101010")).toBe("#FFFFFF");
    for (const background of ["#C9A84C", "#8B2020", "#5B8FA8", "#4A7A3D", "#A0C8D8"]) {
      expect(contrastRatio(background, readableText(background))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("приглушение без потери читаемости", () => {
  it("смешивает цвета", () => {
    expect(blend("#FFFFFF", "#000000", 0.5)).toBe("#808080");
  });

  it("усиливает слабый цвет до AA", () => {
    const fixed = ensureContrast("#C44B2F", "#1A1714");
    expect(contrastRatio(fixed, "#1A1714")).toBeGreaterThanOrEqual(4.5);
    expect(ensureContrast("#FFFFFF", "#000000")).toBe("#ffffff");
  });

  it("держит текст не ниже AA, не трогая и без того читаемое", () => {
    expect(readableOpacity(0.65, [["#FFFFFF", "#000000"]], "#000000")).toBe(0.65);
    const raised = readableOpacity(0.65, [["#9A8C72", "#1A1714"]], "#111111");
    expect(raised).toBeGreaterThan(0.65);
    expect(raised).toBeLessThanOrEqual(1);
  });
});

describe("Markdown безопасен", () => {
  it("рендерит разметку", () => {
    const html = renderMarkdown("**жирно** и [ссылка](https://example.com)\n\n- пункт");
    expect(html).toContain("<strong>жирно</strong>");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("<li>пункт</li>");
  });

  it.each([
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "[x](javascript:alert(1))",
    "[x](data:text/html;base64,PHNjcmlwdD4=)",
    '<a href="javascript:alert(1)">x</a>',
    "<svg onload=alert(1)>",
    "<iframe src=//evil.test></iframe>",
    '<div style="background:url(x)">y</div>',
    "![x](https://evil.test/track.png)",
  ])("%s", (source) => {
    const template = document.createElement("template");
    template.innerHTML = renderMarkdown(source);
    const elements = [...template.content.querySelectorAll("*")];
    const dangerous = elements.filter((node) =>
      /^(script|img|svg|iframe|style|object)$/i.test(node.tagName),
    );
    expect(dangerous).toEqual([]);
    for (const node of elements) {
      for (const attribute of node.getAttributeNames()) {
        expect(attribute.startsWith("on") || attribute === "style").toBe(false);
      }
      expect(node.getAttribute("href") ?? "").not.toMatch(/^(javascript|data):/i);
    }
  });
});

describe("предпроверка файла шаблона", () => {
  const valid = {
    format: "kanbanly.board-template",
    version: 1,
    meta: { name: "T" },
    columns: [{ key: "a", name: "A" }],
  };

  it("принимает корректный шаблон", () => {
    const result = parseTemplateText(JSON.stringify(valid));
    expect(result.ok).toBe(true);
  });

  it("сообщает путь ошибки", () => {
    const broken = {
      ...valid,
      columns: [valid.columns[0], { key: "b", name: "B", color: "red" }],
    };
    const result = parseTemplateText(JSON.stringify(broken));
    expect(result).toEqual({
      ok: false,
      problems: [{ path: "columns[1].color", message: "неверный формат цвета" }],
    });
  });

  it("отвергает мусор, чужой формат и большие файлы", () => {
    expect(parseTemplateText("{oops").ok).toBe(false);
    expect(parseTemplateText(JSON.stringify({ ...valid, format: "x" })).ok).toBe(false);
    expect(parseTemplateText(" ".repeat(1_048_577)).ok).toBe(false);
    expect(parseTemplateText(JSON.stringify({ ...valid, columns: [] })).ok).toBe(false);
  });

  it("проверяет URL изображений", () => {
    expect(isSafeImageUrl("https://x.test/a.png")).toBe(true);
    expect(isSafeImageUrl("http://x.test/a.png")).toBe(false);
    expect(isSafeImageUrl('https://x.test/"')).toBe(false);
    expect(isSafeImageUrl(null)).toBe(false);
  });
});

describe("i18n", () => {
  it("словари содержат одинаковые ключи", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
  });

  it("подставляет параметры", () => {
    expect(translate("ru", "board.count", { count: 3 })).toBe("Карточек: 3");
    expect(translate("en", "board.count", { count: 3 })).toBe("Cards: 3");
  });

  it.each([
    [1, "1 карточка"],
    [2, "2 карточки"],
    [5, "5 карточек"],
    [11, "11 карточек"],
    [21, "21 карточка"],
    [22, "22 карточки"],
    [25, "25 карточек"],
  ])("склоняет %i", (count, expected) => {
    expect(pluralize("ru", "plural.cards", count)).toBe(expected);
  });

  it("склоняет по-английски", () => {
    expect(pluralize("en", "plural.cards", 1)).toBe("1 card");
    expect(pluralize("en", "plural.cards", 5)).toBe("5 cards");
  });
});

describe("горячие клавиши", () => {
  const fire = (init: KeyboardEventInit, target?: HTMLElement) => {
    const event = new KeyboardEvent("keydown", init);
    if (target) Object.defineProperty(event, "target", { value: target });
    return event;
  };

  it("срабатывают вне полей ввода", () => {
    const action = vi.fn();
    expect(matchHotkey(fire({ key: "n" }), { n: action })).toBe(action);
    expect(matchHotkey(fire({ key: "N" }), { n: action })).toBe(action);
    expect(matchHotkey(fire({ key: "?" }), { "?": action })).toBe(action);
    expect(matchHotkey(fire({ key: "k", ctrlKey: true }), { "mod+k": action })).toBe(action);
    expect(matchHotkey(fire({ key: "k", metaKey: true }), { "mod+k": action })).toBe(action);
  });

  it("выключены при вводе текста", () => {
    const action = vi.fn();
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(matchHotkey(fire({ key: "n" }, input), { n: action })).toBeNull();
    expect(matchHotkey(fire({ key: "n" }, textarea), { n: action })).toBeNull();
    expect(isTyping(editable)).toBe(true);
    expect(isTyping(document.createElement("div"))).toBe(false);
    expect(matchHotkey(fire({ key: "k", ctrlKey: true }, input), { "mod+k": action })).toBe(action);
    expect(matchHotkey(fire({ key: "z", ctrlKey: true }, input), { "mod+z": action })).toBeNull();
  });

  it("различает Ctrl+Z и Ctrl+Shift+Z", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    const map = { "mod+z": undo, "mod+shift+z": redo };
    expect(matchHotkey(fire({ key: "z", ctrlKey: true }), map)).toBe(undo);
    expect(matchHotkey(fire({ key: "Z", ctrlKey: true, shiftKey: true }), map)).toBe(redo);
  });

  it("не реагирует на Alt и неизвестные клавиши", () => {
    expect(matchHotkey(fire({ key: "n", altKey: true }), { n: vi.fn() })).toBeNull();
    expect(matchHotkey(fire({ key: "q" }), { n: vi.fn() })).toBeNull();
  });
});

describe("стек undo", () => {
  beforeEach(() => useUndo.getState().clear());

  it("отменяет в обратном порядке", async () => {
    const calls: string[] = [];
    useUndo.getState().push({ label: "1", undo: async () => calls.push("1") });
    useUndo.getState().push({ label: "2", undo: async () => calls.push("2") });
    await useUndo.getState().undo();
    await useUndo.getState().undo();
    await useUndo.getState().undo();
    expect(calls).toEqual(["2", "1"]);
  });

  it("ограничивает глубину", () => {
    for (let index = 0; index < 50; index += 1) {
      useUndo.getState().push({ label: String(index), undo: async () => undefined });
    }
    expect(useUndo.getState().stack).toHaveLength(30);
  });
});

describe("индикатор силы пароля", () => {
  it.each([
    ["short", "tooShort"],
    ["aaaaaaaaaaaa", "weak"],
    ["longerpassword1", "fair"],
    ["LongerPassword!1", "strong"],
  ])("%s → %s", (password, label) => {
    expect(passwordStrength(password).label).toBe(label);
  });
});

describe("API-клиент", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    document.cookie = "kanbanly_csrf=token-1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = "kanbanly_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  it("добавляет CSRF к изменяющим запросам, но не к чтению", async () => {
    fetchMock.mockImplementation(async () => ok({}));
    await api.get("/x");
    expect(fetchMock.mock.calls[0]?.[1].headers).not.toHaveProperty("X-CSRF-Token");
    await api.post("/x", { a: 1 });
    expect(fetchMock.mock.calls[1]?.[1].headers).toMatchObject({ "X-CSRF-Token": "token-1" });
  });

  it("запрашивает CSRF-токен, если cookie нет", async () => {
    document.cookie = "kanbanly_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/auth/csrf")) document.cookie = "kanbanly_csrf=fresh";
      return ok({});
    });
    await api.post("/x");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/auth/csrf");
    expect(fetchMock.mock.calls[1]?.[1].headers).toMatchObject({ "X-CSRF-Token": "fresh" });
  });

  it("передаёт If-Match и параметры запроса", async () => {
    fetchMock.mockImplementation(async () => ok({}));
    await api.patch("/cards/1", {}, { ifMatch: 7 });
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({ "If-Match": '"7"' });
    await api.get("/x", { a: 1, b: undefined });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/x?a=1");
  });

  it("разбирает единый формат ошибок", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "invalid", message: "Плохо", details: [{ path: "a", message: "b" }] },
        }),
        { status: 422 },
      ),
    );
    const error = await send("POST", "/x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid");
    expect((error as ApiError).problems).toEqual([{ path: "a", message: "b" }]);
  });

  it("не падает на ответе без JSON", async () => {
    fetchMock.mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    await expect(send("GET", "/x")).rejects.toMatchObject({ status: 502, code: "unknown" });
  });
});

describe("совместимость порядка с бэкендом", () => {
  it.each([
    [null, null, "a0"],
    ["a0", null, "a1"],
    ["a0", "a1", "a0V"],
    ["a0V", "a1", "a0l"],
    [null, "a0", "Zz"],
    ["b125", "b129", "b127"],
  ] as const)("%s..%s", (low, high, expected) => {
    expect(generateKeyBetween(low, high)).toBe(expected);
  });
});
