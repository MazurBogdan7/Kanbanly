import { t } from "@/i18n";
/** Чистые операции над конфигурацией: роли измерений, контраст, плотность, палитры. */
import type { BoardConfig, DimensionRole, Widget } from "@/lib/api/types";
import { AA_NORMAL, contrastRatio, readableText } from "@/lib/contrast";

import { resolveHex, tokensOf } from "../boards/engine/theme";

export const ALL_ROLES: DimensionRole[] = [
  "accent",
  "badge",
  "filter_select",
  "filter_chips",
  "progress",
  "swimlanes",
  "table_group",
  "legend",
];

function widgets(config: BoardConfig): Widget[] {
  config.layout ??= {};
  config.layout.header ??= {};
  config.layout.header.widgets ??= [];
  return config.layout.header.widgets;
}

function cardLayout(config: BoardConfig) {
  config.layout ??= {};
  config.layout.card ??= {};
  return config.layout.card;
}

/** Зеркало dimension_roles на бэкенде: роли вычисляются из раскладки. */
export function rolesOf(config: BoardConfig, key: string): DimensionRole[] {
  const list = config.layout?.header?.widgets ?? [];
  const has: Record<DimensionRole, boolean> = {
    accent: config.layout?.card?.accent?.source === `dimension:${key}`,
    badge: (config.layout?.card?.badges ?? []).some((badge) => badge.dimension === key),
    filter_select: list.some((w) => w.type === "filter_bar" && w.selects?.includes(key)),
    filter_chips: list.some((w) => w.type === "filter_chips" && w.dimension === key),
    progress: list.some((w) => w.type === "progress_by_dimension" && w.dimension === key),
    swimlanes: config.layout?.board?.swimlanes === key,
    table_group: (config.views ?? []).some((view) => view.group_by === key),
    legend: list.some((w) => w.type === "legend" && w.dimension === key),
  };
  return ALL_ROLES.filter((role) => has[role]);
}

export function setRole(config: BoardConfig, key: string, role: DimensionRole, on: boolean): void {
  const list = widgets(config);
  const remove = (match: (widget: Widget) => boolean) => {
    config.layout!.header!.widgets = list.filter((widget) => !match(widget));
  };
  switch (role) {
    case "accent": {
      const card = cardLayout(config);
      card.accent = { ...card.accent, source: on ? `dimension:${key}` : "none" };
      break;
    }
    case "badge": {
      const card = cardLayout(config);
      card.badges = on
        ? [...(card.badges ?? []), { dimension: key }]
        : (card.badges ?? []).filter((badge) => badge.dimension !== key);
      if (on && !card.face?.includes("badges")) card.face = [...(card.face ?? []), "badges"];
      break;
    }
    case "filter_select": {
      let bar = list.find((widget) => widget.type === "filter_bar");
      if (!bar && on) {
        bar = { type: "filter_bar", search: true, selects: [] };
        list.push(bar);
      }
      if (bar?.type === "filter_bar") {
        bar.selects = on
          ? [...(bar.selects ?? []), key]
          : (bar.selects ?? []).filter((item) => item !== key);
      }
      break;
    }
    case "filter_chips":
      if (on) list.push({ type: "filter_chips", dimension: key, multi: true });
      else remove((widget) => widget.type === "filter_chips" && widget.dimension === key);
      break;
    case "progress":
      if (on) list.push({ type: "progress_by_dimension", dimension: key });
      else remove((widget) => widget.type === "progress_by_dimension" && widget.dimension === key);
      break;
    case "legend":
      if (on) list.push({ type: "legend", dimension: key });
      else remove((widget) => widget.type === "legend" && widget.dimension === key);
      break;
    case "swimlanes":
      config.layout ??= {};
      config.layout.board = { swimlanes: on ? key : null };
      break;
    case "table_group": {
      const name = config.dimensions?.find((item) => item.key === key)?.name ?? key;
      config.views = on
        ? [
            ...(config.views ?? []),
            { key: `table-${key}`, name: `Таблица: ${name}`, type: "table", group_by: key },
          ]
        : (config.views ?? []).filter((view) => view.group_by !== key);
      break;
    }
  }
  const dimension = config.dimensions?.find((item) => item.key === key);
  if (dimension) dimension.roles = rolesOf(config, key);
}

/** Удаление измерения снимает все ссылки на него из раскладки. */
export function removeDimension(config: BoardConfig, key: string): void {
  for (const role of rolesOf(config, key)) setRole(config, key, role, false);
  config.dimensions = (config.dimensions ?? []).filter((item) => item.key !== key);
  if (config.layout?.editor?.fields) {
    config.layout.editor.fields = config.layout.editor.fields.filter((item) => item !== key);
  }
}

export function removeField(config: BoardConfig, key: string): void {
  config.fields = (config.fields ?? []).filter((item) => item.key !== key);
  const card = config.layout?.card;
  if (card?.accent?.source === `field:${key}`) card.accent.source = "none";
  if (config.layout?.editor?.fields) {
    config.layout.editor.fields = config.layout.editor.fields.filter((item) => item !== key);
  }
}

export const DENSITY_PRESETS = {
  compact: { padding: [6, 8], gap: 5 },
  comfortable: { padding: [10, 12], gap: 8 },
  spacious: { padding: [14, 16], gap: 12 },
} as const;

export function applyDensity(config: BoardConfig, density: keyof typeof DENSITY_PRESETS): void {
  config.theme ??= {};
  config.theme.density = density;
  const card = cardLayout(config);
  card.padding = [...DENSITY_PRESETS[density].padding];
  card.gap = DENSITY_PRESETS[density].gap;
}

export interface ContrastIssue {
  pair: string;
  ratio: number;
}

export function contrastReport(config: BoardConfig): ContrastIssue[] {
  const tokens = tokensOf(config);
  const issues: ContrastIssue[] = [];
  const check = (pair: string, foreground?: string, background?: string) => {
    if (!foreground || !background) return;
    const ratio = contrastRatio(foreground.slice(0, 7), background.slice(0, 7));
    if (ratio < AA_NORMAL) issues.push({ pair, ratio: Math.round(ratio * 10) / 10 });
  };
  const color = (value: string | null | undefined, fallback: string) =>
    resolveHex(value, tokens) ?? tokens[fallback];
  const typography = config.typography ?? {};
  check(t("contrast.textBg"), tokens.text, tokens.bg);
  check(t("contrast.mutedColumn"), tokens["text-muted"], tokens.surface);
  check(t("contrast.mutedCard"), tokens["text-muted"], tokens["surface-2"]);
  check(t("contrast.cardText"), tokens.text, tokens["surface-2"]);
  check(t("contrast.boardTitle"), color(typography.board_title?.color, "text"), tokens.bg);
  check(t("contrast.columnTitle"), color(typography.column_title?.color, "text"), tokens.surface);
  check(t("contrast.cardTitle"), color(typography.card_title?.color, "text"), tokens["surface-2"]);
  check(
    t("contrast.cardText"),
    color(typography.card_body?.color, "text-muted"),
    tokens["surface-2"],
  );
  check(t("contrast.badge"), tokens["text-muted"], tokens.border);
  for (const dimension of config.dimensions ?? []) {
    for (const value of dimension.values ?? []) {
      const background = resolveHex(value.badge?.bg ?? value.color, tokens);
      if (!background) continue;
      const foreground =
        resolveHex(value.badge?.fg, tokens) ?? readableText(background.slice(0, 7));
      check(t("contrast.value", { name: value.name }), foreground, background);
    }
  }
  return issues;
}

export const PALETTES: { name: string; mode: "light" | "dark"; tokens: Record<string, string> }[] =
  [
    {
      name: "Чистая",
      mode: "light",
      tokens: {
        bg: "#F6F7F9",
        surface: "#EEF0F4",
        "surface-2": "#FFFFFF",
        border: "#DDE1E8",
        "border-strong": "#C2C8D3",
        "muted-strong": "#6B7280",
        accent: "#3B5BDB",
        "accent-hover": "#2F4AC0",
        "accent-soft": "#E3E9FF",
        "accent-dim": "#7C8FE0",
        danger: "#C92A2A",
        "danger-hover": "#A61E1E",
        text: "#1A1F2B",
        "text-muted": "#555E6E",
      },
    },
    {
      name: "Бумага",
      mode: "light",
      tokens: {
        bg: "#F4F1EA",
        surface: "#ECE7DB",
        "surface-2": "#FBF9F4",
        border: "#DDD6C6",
        "border-strong": "#C4BBA6",
        "muted-strong": "#7A7262",
        accent: "#8A3B12",
        "accent-hover": "#6E2E0D",
        "accent-soft": "#F2DDCD",
        "accent-dim": "#B97C58",
        danger: "#B3261E",
        "danger-hover": "#8C1D18",
        text: "#2B261D",
        "text-muted": "#5C5546",
      },
    },
    {
      name: "Мята",
      mode: "light",
      tokens: {
        bg: "#EFF7F4",
        surface: "#E2F0EB",
        "surface-2": "#FFFFFF",
        border: "#CFE3DC",
        "border-strong": "#AECDC3",
        "muted-strong": "#5F7D74",
        accent: "#0B7A5E",
        "accent-hover": "#086049",
        "accent-soft": "#CDEDE2",
        "accent-dim": "#5FAE97",
        danger: "#C0362C",
        "danger-hover": "#982A22",
        text: "#12302A",
        "text-muted": "#40605A",
      },
    },
    {
      name: "Графит",
      mode: "dark",
      tokens: {
        bg: "#0F1218",
        surface: "#161A22",
        "surface-2": "#1E232D",
        border: "#2A303C",
        "border-strong": "#3D4554",
        "muted-strong": "#7D8799",
        accent: "#91A7FF",
        "accent-hover": "#B2C1FF",
        "accent-soft": "#D9E1FF",
        "accent-dim": "#5C72C9",
        danger: "#FF8787",
        "danger-hover": "#FFA8A8",
        text: "#E8EBF1",
        "text-muted": "#A1ABBC",
      },
    },
    {
      name: "Обсидиан и золото",
      mode: "dark",
      tokens: {
        bg: "#0A0A0A",
        surface: "#111111",
        "surface-2": "#1A1714",
        border: "#2A2520",
        "border-strong": "#3D362E",
        "muted-strong": "#5C4F3C",
        accent: "#C9A84C",
        "accent-hover": "#E2C45E",
        "accent-soft": "#F5E6A3",
        "accent-dim": "#8B7441",
        danger: "#E38B8B",
        "danger-hover": "#FFB0A0",
        text: "#E8DFC8",
        "text-muted": "#9A8C72",
      },
    },
    {
      name: "Ночной лес",
      mode: "dark",
      tokens: {
        bg: "#0C1512",
        surface: "#121E1A",
        "surface-2": "#1A2A25",
        border: "#27392F",
        "border-strong": "#3A5247",
        "muted-strong": "#7B9587",
        accent: "#6FD6A0",
        "accent-hover": "#97E6BC",
        "accent-soft": "#D2F5E2",
        "accent-dim": "#3E9D73",
        danger: "#FF9B92",
        "danger-hover": "#FFBAB3",
        text: "#E5F0EA",
        "text-muted": "#A3B8AD",
      },
    },
  ];

type Look = Pick<BoardConfig, "theme" | "typography" | "layout">;

/**
 * Оформление другого шаблона без его структуры: тема, шрифты, геометрия колонок и карточек.
 * Бейджи, лицевая сторона и виджеты остаются свои: они ссылаются на измерения этой доски.
 */
export function applyLook<T extends Look>(target: T, source: Look): T {
  const card = source.layout?.card ?? {};
  const own = target.layout?.card ?? {};
  return {
    ...target,
    theme: structuredClone(source.theme ?? {}),
    typography: structuredClone(source.typography ?? {}),
    layout: {
      ...target.layout,
      column: structuredClone(source.layout?.column ?? {}),
      card: {
        ...own,
        radius: card.radius,
        padding: card.padding,
        gap: card.gap,
        shadow: card.shadow,
        border: card.border,
        hover: card.hover,
        accent: { ...own.accent, style: card.accent?.style, width: card.accent?.width },
      },
    },
  };
}
