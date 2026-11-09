import { describe, expect, it } from "vitest";

import { cardColorVars } from "@/features/boards/engine/CardFace";
import { SWATCHES } from "@/features/workspace/tags";
import { filenameFrom } from "@/lib/api/client";
import { AA_NORMAL, contrastRatio, readableText } from "@/lib/contrast";
import { sanitizeOfficeHtml } from "@/lib/markdown";

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
