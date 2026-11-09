import { describe, expect, it } from "vitest";

import { cardColorVars } from "@/features/boards/engine/CardFace";
import { overflowSource, splitOverflow } from "@/features/boards/engine/model";
import { AVATAR_COLORS, avatarColor, initials } from "@/features/projects/people";
import { SWATCHES } from "@/features/workspace/tags";
import { filenameFrom } from "@/lib/api/client";
import type { TagOut } from "@/lib/api/types";
import { AA_NORMAL, contrastRatio, readableText } from "@/lib/contrast";
import { sanitizeOfficeHtml } from "@/lib/markdown";

import { card, config } from "./fixtures";

describe("цвет карточки", () => {
  it("без цвета тема не меняется", () => {
    expect(cardColorVars(null)).toEqual({});
    expect(cardColorVars("red")).toEqual({});
  });

  it.each([...SWATCHES, "#000000", "#FFFFFF", "#7F7F7F", "#FFFF00"])(
    "текст на %s читается (WCAG AA)",
    (color) => {
      const vars = cardColorVars(color);
      for (const key of [
        "--t-text",
        "--t-text-muted",
        "--ty-card-title-color",
        "--ty-card-body-color",
      ]) {
        expect(contrastRatio(vars[key] ?? "", color), key).toBeGreaterThanOrEqual(AA_NORMAL);
      }
    },
  );

  it("палитра тегов читаема с автотекстом", () => {
    for (const color of SWATCHES) {
      expect(contrastRatio(readableText(color), color)).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });
});

describe("просмотр Word и Excel", () => {
  it("убирает скрипты, обработчики и опасные ссылки", () => {
    const html = sanitizeOfficeHtml(
      '<p onclick="x()">Текст</p><script>alert(1)</script><a href="javascript:alert(1)">ссылка</a>' +
        '<img src="https://evil.example/track.png"><img src="data:image/png;base64,AAAA" alt="схема">' +
        '<iframe src="https://evil.example"></iframe><table><tr><td colspan="2">ячейка</td></tr></table>',
    );
    expect(html).not.toMatch(/script|onclick|javascript:|iframe|evil\.example/);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('colspan="2"');
    expect(html).toContain("Текст");
  });

  it("картинки Word берутся только из самого документа", () => {
    const own = "/api/v1/documents/0d1c-aa/versions/2/images/0";
    const html = sanitizeOfficeHtml(
      `<img src="${own}" alt="схема"><img src="/api/v1/auth/me"><img src="https://evil.example${own}">`,
    );
    expect(html).toContain(`src="${own}"`);
    expect(html).toContain('loading="lazy"');
    expect(html).not.toMatch(/auth\/me|evil\.example/);
  });
});

describe("имя скачиваемого файла", () => {
  it("берёт кириллическое имя из filename*", () => {
    expect(filenameFrom(`attachment; filename=".docx"; filename*=UTF-8''%D0%A2%D0%97.docx`)).toBe(
      "ТЗ.docx",
    );
  });

  it("без filename* использует обычное имя", () => {
    expect(filenameFrom('attachment; filename="backup.json"')).toBe("backup.json");
    expect(filenameFrom("")).toBe("download.json");
  });
});

describe("длинная колонка", () => {
  const many = (count: number, values: (index: number) => Record<string, string[]>) =>
    Array.from({ length: count }, (_, index) =>
      card({ id: `c${index}`, title: `Карточка ${index}`, values: values(index) }),
    );
  const noTags = new Map<string, TagOut>();

  it("до порога карточки идут списком", () => {
    expect(
      splitOverflow(
        many(20, () => ({})),
        config,
        noTags,
      ),
    ).toBeNull();
  });

  it("сверху 5 карточек, остальные — блоками по эпику и «Без тега» в конце", () => {
    const cards = many(25, (index) => ({ epic: index % 3 === 0 ? [] : [index % 2 ? "a" : "b"] }));
    const split = splitOverflow(cards, config, noTags);
    expect(split?.head.map((item) => item.id)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(split?.groups.map((group) => group.label)).toEqual(["Альфа", "Бета", null]);
    const grouped = split?.groups.flatMap((group) => group.cards.map((item) => item.id)) ?? [];
    expect(grouped).toHaveLength(20);
    expect(new Set(grouped).size).toBe(20);
    expect(split?.groups.at(-1)?.cards.every((item) => !item.values.epic?.length)).toBe(true);
  });

  it("настройки конструктора: порог, видимые, источник и выключение", () => {
    const tuned = {
      ...config,
      layout: { column: { overflow: { threshold: 5, visible: 2, by: "dimension:ms" } } },
    } as typeof config;
    const cards = many(6, () => ({ ms: ["m1"] }));
    const split = splitOverflow(cards, tuned, noTags);
    expect(split?.head).toHaveLength(2);
    expect(overflowSource(tuned, cards)).toMatchObject({ dimension: { key: "ms" } });
    const off = {
      ...config,
      layout: { column: { overflow: { enabled: false } } },
    } as typeof config;
    expect(
      splitOverflow(
        many(50, () => ({})),
        off,
        noTags,
      ),
    ).toBeNull();
  });

  it("по тегам проекта и с видимой перетаскиваемой карточкой", () => {
    const tags = new Map<string, TagOut>([
      ["t1", { id: "t1", name: "Срочно", color: "#C92A2A", position: "a0" } as TagOut],
    ]);
    const byTags = {
      ...config,
      layout: { column: { overflow: { by: "tags" } } },
    } as typeof config;
    const cards = many(22, () => ({})).map((item, index) => ({
      ...item,
      tags: index % 2 ? ["t1"] : [],
    }));
    const split = splitOverflow(cards, byTags, tags, "c21");
    expect(split?.groups.map((group) => group.label)).toEqual(["Срочно", null]);
    expect(split?.head.map((item) => item.id)).toContain("c21");
  });
});

describe("аватар исполнителя", () => {
  it("белые инициалы читаются на каждом цвете", () => {
    for (const color of AVATAR_COLORS) {
      expect(contrastRatio("#FFFFFF", color), color).toBeGreaterThanOrEqual(AA_NORMAL);
    }
  });

  it("цвет и инициалы стабильны для человека", () => {
    expect(avatarColor("u1")).toBe(avatarColor("u1"));
    expect(initials("Анна Петрова")).toBe("АП");
    expect(initials("mallory@example.com")).toBe("ME");
    expect(initials("")).toBe("?");
  });
});
