/** Контраст WCAG: автотекст на цветных бейджах и предупреждения конструктора. */

export function parseHex(hex: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
  if (!match?.[1]) return null;
  const value = parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export const AA_NORMAL = 4.5;
export const AA_LARGE = 3;

/** Цвет текста, читаемый на заданном фоне. */
export function readableText(background: string): "#111111" | "#FFFFFF" {
  return contrastRatio(background, "#111111") >= contrastRatio(background, "#FFFFFF")
    ? "#111111"
    : "#FFFFFF";
}

function toHex(rgb: number[]): string {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

/** Цвет foreground с прозрачностью alpha поверх background. */
export function blend(foreground: string, background: string, alpha: number): string {
  const top = parseHex(foreground) ?? [0, 0, 0];
  const bottom = parseHex(background) ?? [0, 0, 0];
  return toHex(top.map((value, index) => value * alpha + (bottom[index] ?? 0) * (1 - alpha)));
}

/** Сдвигает цвет к читаемому полюсу, пока он не наберёт нужный контраст на фоне. */
export function ensureContrast(color: string, background: string, minimum = AA_NORMAL): string {
  const pole = readableText(background);
  for (let step = 0; step <= 20; step += 1) {
    const candidate = blend(pole, color, step / 20);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return pole;
}

/**
 * Наименьшая непрозрачность не ниже запрошенной, при которой текст остаётся читаемым.
 * Приглушение «Готово» задаётся шаблоном, но не должно опускать текст ниже WCAG AA.
 */
export function readableOpacity(
  requested: number,
  pairs: [foreground: string, background: string][],
  backdrop: string,
): number {
  for (let alpha = requested; alpha < 1; alpha += 0.01) {
    const passes = pairs.every(([foreground, background]) => {
      // Элемент с opacity компонуется целиком: и фон, и текст смешиваются с подложкой.
      const solid = blend(background, backdrop, alpha);
      return contrastRatio(blend(foreground, backdrop, alpha), solid) >= AA_NORMAL;
    });
    if (passes) return Math.round(alpha * 100) / 100;
  }
  return 1;
}
