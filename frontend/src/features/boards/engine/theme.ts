/** Конфигурация → CSS-переменные. Цвет — hex или ссылка на токен, ничего больше. */
import type { CSSProperties } from "react";

import { ensureFont, fontStack } from "@/design-system/fonts";
import type { Background, BoardConfig, TypeRole } from "@/lib/api/types";
import { ensureContrast, readableText } from "@/lib/contrast";
import { isSafeImageUrl } from "@/lib/templateFile";

export const DEFAULT_TOKENS: Record<string, string> = {
  bg: "#F6F7F9",
  surface: "#FFFFFF",
  "surface-2": "#FFFFFF",
  border: "#E3E6EB",
  "border-strong": "#C9CFD8",
  "muted-strong": "#6B7280",
  accent: "#3B5BDB",
  "accent-hover": "#2F4AC0",
  "accent-soft": "#E7ECFF",
  "accent-dim": "#7C8FE0",
  danger: "#C92A2A",
  "danger-hover": "#A61E1E",
  text: "#1A1F2B",
  "text-muted": "#5B6472",
};

export const BASE_TOKEN_NAMES = Object.keys(DEFAULT_TOKENS);

const TOKEN_REF = /^\{([a-z][a-z0-9-]*)\}$/;
const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export type Palette = "primary" | "alt";

export function tokensOf(
  config: BoardConfig,
  palette: Palette = "primary",
): Record<string, string> {
  const primary = { ...DEFAULT_TOKENS, ...config.theme?.tokens };
  return palette === "alt" ? { ...primary, ...config.theme?.alt_tokens } : primary;
}

export function resolveColor(color: string | null | undefined): string | undefined {
  if (!color) return undefined;
  const token = TOKEN_REF.exec(color);
  if (token) return `var(--t-${token[1]})`;
  return HEX.test(color) ? color : undefined;
}

export function resolveHex(
  color: string | null | undefined,
  tokens: Record<string, string>,
): string | undefined {
  if (!color) return undefined;
  const token = TOKEN_REF.exec(color);
  if (token?.[1]) return tokens[token[1]];
  return HEX.test(color) ? color : undefined;
}

export function backgroundCss(background: Background | null | undefined): string | undefined {
  if (!background) return undefined;
  switch (background.type) {
    case "color":
      return resolveColor(background.value);
    case "linear-gradient":
      return `linear-gradient(${background.angle ?? 180}deg, ${background.stops.map(resolveColor).join(", ")})`;
    case "radial-gradient":
      return `radial-gradient(circle, ${background.stops.map(resolveColor).join(", ")})`;
    case "image": {
      if (!isSafeImageUrl(background.url)) return undefined;
      const overlay = resolveColor(background.overlay ?? "#000000");
      const amount = Math.round((background.overlay_opacity ?? 0.4) * 100);
      const shade = `color-mix(in srgb, ${overlay} ${amount}%, transparent)`;
      return `linear-gradient(${shade}, ${shade}), center / cover no-repeat url("${background.url}")`;
    }
  }
}

const CASE_MAP = {
  as_is: "none",
  upper: "uppercase",
  lower: "lowercase",
  capitalize: "capitalize",
} as const;

const ROLE_DEFAULTS = {
  base: { font: "Inter", size: 14, line_height: 1.45, weight: 400 },
  board_title: { weight: 700, size: 24, color: "{text}" },
  board_subtitle: { weight: 500, size: 12, color: "{text-muted}" },
  column_title: { weight: 700, size: 14, color: "{text}" },
  card_title: { weight: 600, size: 13, color: "{text}" },
  card_body: { weight: 400, size: 12, color: "{text-muted}", line_clamp: 2 },
  badge: { weight: 400, size: 10.5 },
} satisfies Record<string, TypeRole>;

export type RoleName = keyof typeof ROLE_DEFAULTS;
export const TYPE_ROLES = Object.keys(ROLE_DEFAULTS) as RoleName[];

const HEADING_ROLES = new Set(["column-title"]);

function roleVars(
  name: string,
  role: TypeRole,
  base: TypeRole,
): Record<string, string | number | null | undefined> {
  const prefix = `--ty-${name}`;
  return {
    [`${prefix}-font`]: fontStack(role.font ?? base.font),
    [`${prefix}-weight`]: role.weight ?? base.weight ?? 400,
    [`${prefix}-size`]: role.size ? `${role.size}px` : undefined,
    [`${prefix}-spacing`]: role.letter_spacing ? `${role.letter_spacing}em` : "0",
    // Заголовок колонки компактный: по метрикам шрифта, а не по базовому интервалу.
    [`${prefix}-line`]: role.line_height ?? (HEADING_ROLES.has(name) ? "normal" : base.line_height),
    [`${prefix}-case`]: CASE_MAP[role.case ?? "as_is"],
    [`${prefix}-color`]: resolveColor(role.color),
    [`${prefix}-clamp`]: role.line_clamp ?? undefined,
  };
}

const DENSITY = { compact: 0.75, comfortable: 1, spacious: 1.25 } as const;

export function loadConfigFonts(config: BoardConfig): void {
  const typography = config.typography ?? {};
  ensureFont(ROLE_DEFAULTS.base.font);
  for (const role of TYPE_ROLES) ensureFont(typography[role]?.font);
}

/** Цвета — в переменные на корне доски: смена токена перекрашивает всё сразу. */
export function boardStyle(config: BoardConfig, palette: Palette = "primary"): CSSProperties {
  const tokens = tokensOf(config, palette);
  const vars: Record<string, string | number | null | undefined> = {};
  for (const [name, value] of Object.entries(tokens)) vars[`--t-${name}`] = value;
  const typography = config.typography ?? {};
  const base: TypeRole = { ...ROLE_DEFAULTS.base, ...stripNull(typography.base) };
  for (const role of TYPE_ROLES) {
    const merged: TypeRole = { ...ROLE_DEFAULTS[role], ...stripNull(typography[role]) };
    Object.assign(vars, roleVars(role.replace("_", "-"), merged, base));
  }
  const theme = config.theme ?? {};
  const headerBackground =
    palette === "alt"
      ? (theme.alt_header_background ?? theme.header_background)
      : theme.header_background;
  const boardBackground =
    palette === "alt"
      ? (theme.alt_board_background ?? theme.board_background)
      : theme.board_background;
  vars["--kb-on-accent"] = readableText(tokens.accent ?? "#000000");
  vars["--kb-danger-text"] = ensureContrast(
    tokens["danger-hover"] ?? "#000000",
    tokens["surface-2"] ?? "#FFFFFF",
  );
  vars["--kb-header-bg"] = backgroundCss(headerBackground) ?? "var(--t-surface)";
  vars["--kb-board-bg"] = backgroundCss(boardBackground) ?? "var(--t-bg)";
  vars["--kb-density"] = DENSITY[theme.density ?? "comfortable"];
  const layout = config.layout ?? {};
  const card = layout.card ?? {};
  const column = layout.column ?? {};
  const padding = card.padding ?? [10, 12];
  vars["--kb-card-radius"] = `${card.radius ?? 8}px`;
  vars["--kb-card-pad-y"] = `${padding[0]}px`;
  vars["--kb-card-pad-x"] = `${padding[1]}px`;
  vars["--kb-card-gap"] = `${card.gap ?? 8}px`;
  vars["--kb-col-radius"] = `${column.radius ?? 10}px`;
  return vars as CSSProperties;
}

function stripNull(role: TypeRole | undefined): Partial<TypeRole> {
  return Object.fromEntries(
    Object.entries(role ?? {}).filter(([, value]) => value !== null && value !== undefined),
  );
}

export function initialPalette(config: BoardConfig): Palette {
  return config.theme?.mode === "both" && prefersDark() ? "alt" : "primary";
}

function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}
