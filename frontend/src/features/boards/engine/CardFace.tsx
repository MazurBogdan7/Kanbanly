import { AlertTriangle, CalendarDays, CheckSquare, MessageSquare } from "lucide-react";
import { memo, type CSSProperties, type ReactNode } from "react";

import { useT } from "@/i18n";
import type {
  BadgeConfig,
  BoardConfig,
  CardOut,
  ColumnTemplate,
  DimensionTemplate,
  DimensionValueTemplate,
  FaceSlot,
  FieldTemplate,
} from "@/lib/api/types";
import { blend, readableOpacity, readableText } from "@/lib/contrast";
import { isSafeImageUrl } from "@/lib/templateFile";

import { hasRule, isOverdue, missingRequired, todayIso } from "./model";
import { resolveColor, resolveHex, tokensOf } from "./theme";

function badgeLabel(value: DimensionValueTemplate, display: BadgeConfig["display"]): string {
  const icon = value.icon ? `${value.icon} ` : "";
  switch (display) {
    case "short":
      return value.short ?? value.name;
    case "icon":
      return value.icon ?? value.short ?? value.name;
    case "icon+name":
      return `${icon}${value.name}`;
    default:
      return value.name;
  }
}

function badgeStyle(
  value: DimensionValueTemplate,
  config: BadgeConfig,
  tokens: Record<string, string>,
): { style: CSSProperties; dot?: string } {
  const own = value.badge;
  const style: CSSProperties = {
    borderRadius: config.radius ?? undefined,
  };
  const colored = (background: string | null | undefined) => {
    const hex = resolveHex(background, tokens);
    style.background = resolveColor(background);
    style.color = resolveColor(own?.fg) ?? (hex ? readableText(hex) : undefined);
  };
  switch (config.style ?? "neutral") {
    case "per-value":
      if (own?.bg || value.color) colored(own?.bg ?? value.color);
      if (own?.border) style.boxShadow = `inset 0 0 0 1px ${resolveColor(own.border)}`;
      break;
    case "filled":
      colored(own?.bg ?? value.color ?? "{accent}");
      break;
    case "outlined":
      style.background = resolveColor(own?.bg) ?? "transparent";
      style.color = resolveColor(own?.fg) ?? "var(--t-text)";
      style.boxShadow = `inset 0 0 0 1px ${resolveColor(own?.border) ?? "var(--t-border-strong)"}`;
      break;
    case "dot":
      return { style, dot: resolveColor(value.color) ?? "var(--t-accent-dim)" };
  }
  return { style };
}

export function ValueBadge({
  value,
  config,
  tokens,
}: {
  value: DimensionValueTemplate;
  config: BadgeConfig;
  tokens: Record<string, string>;
}) {
  const { style, dot } = badgeStyle(value, config, tokens);
  return (
    <span className="kb-tag" data-size={config.size ?? "sm"} style={style}>
      {dot && <i className="kb-tag-dot" style={{ background: dot }} aria-hidden />}
      {badgeLabel(value, config.display)}
    </span>
  );
}

function isHidden(
  value: DimensionValueTemplate,
  dimension: DimensionTemplate,
  config: BadgeConfig,
): boolean {
  if (dimension.hide_empty && dimension.empty_value === value.key) return true;
  return (config.hide_values ?? []).some((hidden) => hidden === value.name || hidden === value.key);
}

function Badges({
  card,
  config,
  tokens,
}: {
  card: CardOut;
  config: BoardConfig;
  tokens: Record<string, string>;
}) {
  const badges = config.layout?.card?.badges ?? [];
  const items: ReactNode[] = [];
  for (const badge of badges) {
    const dimension = config.dimensions?.find((item) => item.key === badge.dimension);
    if (!dimension) continue;
    for (const key of card.values[dimension.key] ?? []) {
      const value = dimension.values?.find((item) => item.key === key);
      if (value && !isHidden(value, dimension, badge)) {
        items.push(
          <ValueBadge
            key={`${dimension.key}:${key}`}
            value={value}
            config={badge}
            tokens={tokens}
          />,
        );
      }
    }
  }
  return items.length ? <div className="kb-meta">{items}</div> : null;
}

export function formatFieldValue(field: FieldTemplate, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  switch (field.type) {
    case "checkbox":
      return value ? "✓" : null;
    case "rating":
      return "★".repeat(Number(value));
    case "progress":
      return `${String(value)}%`;
    case "date_range": {
      const range = value as { start: string; end: string };
      return `${range.start} — ${range.end}`;
    }
    case "checklist": {
      const items = value as { done?: boolean }[];
      return `${items.filter((item) => item.done).length}/${items.length}`;
    }
    case "attachment_link":
      return (value as { name?: string }).name ?? "Ссылка";
    case "url":
      return String(value).replace(/^https?:\/\//, "");
    case "number":
      return field.format ? `${String(value)} ${field.format}` : String(value);
    default:
      return String(value);
  }
}

function FaceFields({ card, config }: { card: CardOut; config: BoardConfig }) {
  const rows = (config.fields ?? [])
    .filter((field) => field.show_on_face)
    .map((field) => ({ field, text: formatFieldValue(field, card.fields[field.key]) }))
    .filter((row) => row.text !== null);
  if (!rows.length) return null;
  return (
    <dl className="kb-fields">
      {rows.map(({ field, text }) => (
        <div key={field.key}>
          <dt>{field.name}</dt>
          <dd>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function Assignees({ card, config }: { card: CardOut; config: BoardConfig }) {
  const people = (config.dimensions ?? [])
    .filter((dimension) => dimension.type === "user")
    .flatMap((dimension) =>
      (card.values[dimension.key] ?? [])
        .filter((key) => key !== dimension.empty_value)
        .map((key) => dimension.values?.find((value) => value.key === key)),
    )
    .filter((value): value is DimensionValueTemplate => !!value);
  if (!people.length) return null;
  return (
    <div className="kb-assignees">
      {people.map((person) => (
        <span key={person.key} className="kb-avatar" title={person.name}>
          {initials(person.name)}
        </span>
      ))}
    </div>
  );
}

function slot(
  name: FaceSlot,
  card: CardOut,
  config: BoardConfig,
  tokens: Record<string, string>,
  titleStyle: CSSProperties | undefined,
): ReactNode {
  switch (name) {
    case "title":
      return (
        <div key={name} className="kb-card-title" style={titleStyle}>
          {card.title}
        </div>
      );
    case "description":
      return card.description ? (
        <div key={name} className="kb-card-body">
          {card.description}
        </div>
      ) : null;
    case "badges":
      return <Badges key={name} card={card} config={config} tokens={tokens} />;
    case "fields":
      return <FaceFields key={name} card={card} config={config} />;
    case "cover":
      return isSafeImageUrl(card.cover_url) ? (
        <img
          key={name}
          className="kb-cover"
          src={card.cover_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null;
    case "assignees":
      return <Assignees key={name} card={card} config={config} />;
    case "due_date":
      return card.due_date ? (
        <div
          key={name}
          className="kb-inline"
          data-overdue={isOverdue(card, config, todayIso()) || undefined}
        >
          <CalendarDays aria-hidden />
          {card.due_date}
        </div>
      ) : null;
    case "checklist_progress":
      return card.checklist_total ? (
        <div key={name} className="kb-inline">
          <CheckSquare aria-hidden />
          {card.checklist_done}/{card.checklist_total}
        </div>
      ) : null;
    case "comments_count":
      return card.comments_count ? (
        <div key={name} className="kb-inline">
          <MessageSquare aria-hidden />
          {card.comments_count}
        </div>
      ) : null;
    case "custom_text":
      return config.layout?.card?.custom_text ? (
        <div key={name} className="kb-inline">
          {config.layout.card.custom_text}
        </div>
      ) : null;
  }
}

export function accentColor(
  card: CardOut,
  config: BoardConfig,
  column: ColumnTemplate | undefined,
): string | undefined {
  const source = config.layout?.card?.accent?.source ?? "none";
  if (source === "column") return resolveColor(column?.color);
  if (source.startsWith("dimension:")) {
    const key = source.slice("dimension:".length);
    const dimension = config.dimensions?.find((item) => item.key === key);
    const selected = card.values[key]?.[0];
    return resolveColor(dimension?.values?.find((value) => value.key === selected)?.color);
  }
  if (source.startsWith("field:")) {
    const value = card.fields[source.slice("field:".length)];
    return typeof value === "string" ? resolveColor(value) : undefined;
  }
  return undefined;
}

export interface CardFaceProps {
  card: CardOut;
  config: BoardConfig;
  column: ColumnTemplate | undefined;
}

export const CardFace = memo(function CardFace({ card, config, column }: CardFaceProps) {
  const { t } = useT();
  const tokens = tokensOf(config);
  const face = config.layout?.card?.face ?? ["title", "description", "badges"];
  const cardStyle = column?.card_style;
  const titleStyle: CSSProperties | undefined = cardStyle?.title_strikethrough
    ? {
        textDecoration: "line-through",
        textDecorationColor: resolveColor(cardStyle.strikethrough_color) ?? undefined,
      }
    : undefined;
  const missing = hasRule(config, "warn_missing_required") ? missingRequired(card, config) : [];
  return (
    <>
      {missing.length > 0 && (
        <span
          className="kb-warning"
          title={t("board.missingRequired", { names: missing.join(", ") })}
        >
          <AlertTriangle aria-hidden />
          <span className="sr-only">
            {t("board.missingRequired", { names: missing.join(", ") })}
          </span>
        </span>
      )}
      {face.map((name) => slot(name, card, config, tokens, titleStyle))}
    </>
  );
});

const dimCache = new WeakMap<BoardConfig, Map<number, number>>();

/** Непрозрачность текста приглушённой карточки: не ниже запрошенной и не ниже WCAG AA. */
function textOpacity(config: BoardConfig, requested: number): number {
  const cached = dimCache.get(config) ?? new Map<number, number>();
  dimCache.set(config, cached);
  const known = cached.get(requested);
  if (known !== undefined) return known;
  const tokens = tokensOf(config);
  const card = tokens["surface-2"] ?? "#000000";
  const value = readableOpacity(
    requested,
    [
      [tokens["text-muted"] ?? "#000000", card],
      [tokens["text-muted"] ?? "#000000", tokens.border ?? card],
    ],
    blend(card, tokens.surface ?? card, requested),
  );
  cached.set(requested, value);
  return value;
}

export function cardShellProps(card: CardOut, config: BoardConfig, column?: ColumnTemplate) {
  const layout = config.layout?.card ?? {};
  const accent = layout.accent ?? {};
  const color = accentColor(card, config, column);
  const accentStyle = column?.card_style?.accent_style ?? accent.style ?? "left-border";
  const hasAccent = (accent.source ?? "none") !== "none";
  const style: Record<string, string | number | undefined> = {
    "--c": color ?? "var(--t-accent-dim)",
    "--c-w": `${accent.width ?? 3}px`,
  };
  const dim = column?.card_style?.opacity ?? undefined;
  if (dim) {
    style["--kb-dim"] = dim;
    style["--kb-dim-text"] = textOpacity(config, dim);
  }
  return {
    style: style as CSSProperties,
    "data-accent": hasAccent ? accentStyle : undefined,
    "data-shadow": layout.shadow ?? "none",
    "data-hover": layout.hover ?? "border",
    "data-border": layout.border === false ? "off" : undefined,
    "data-dim": dim ? true : undefined,
    "data-mute-badges": column?.card_style?.mute_badges || undefined,
  };
}
