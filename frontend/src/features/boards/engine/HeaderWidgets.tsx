import { useRef, useState, type ReactNode } from "react";

import { useT } from "@/i18n";
import type { BoardConfig, CardOut, DimensionTemplate, Widget } from "@/lib/api/types";

import { computeStat, progressByDimension, todayIso, type Filters, type StatMetric } from "./model";
import { resolveColor } from "./theme";

export interface BoardActions {
  onAddCard?: () => void;
  onExport?: () => void;
  onImport?: (file: File) => void;
  onReset?: () => void;
}

interface WidgetProps {
  config: BoardConfig;
  cards: CardOut[];
  filters: Filters;
  onFilters: (filters: Filters) => void;
}

function findDimension(config: BoardConfig, key: string): DimensionTemplate | undefined {
  return config.dimensions?.find((dimension) => dimension.key === key);
}

function ConfirmButton({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const { t } = useT();
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  return (
    <button
      type="button"
      className="kb-btn kb-btn-danger"
      onBlur={() => setArmed(false)}
      onClick={() => {
        clearTimeout(timer.current);
        if (armed) {
          setArmed(false);
          onConfirm();
          return;
        }
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), 3000);
      }}
    >
      {armed ? t("common.confirmAgain") : label}
    </button>
  );
}

function Actions({
  widget,
  actions,
}: {
  widget: Extract<Widget, { type: "actions" }>;
  actions: BoardActions;
}) {
  const { t } = useT();
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="kb-actions">
      {widget.add_card !== false && (
        <button type="button" className="kb-btn kb-btn-primary" onClick={actions.onAddCard}>
          {t("board.addCard")}
        </button>
      )}
      {widget.export !== false && (
        <button type="button" className="kb-btn" onClick={actions.onExport}>
          {t("board.exportJson")}
        </button>
      )}
      {widget.import !== false && (
        <>
          <button type="button" className="kb-btn" onClick={() => fileInput.current?.click()}>
            {t("board.import")}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json"
            hidden
            aria-label={t("board.import")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) actions.onImport?.(file);
              event.target.value = "";
            }}
          />
        </>
      )}
      {widget.reset !== false && (
        <ConfirmButton label={t("board.reset")} onConfirm={() => actions.onReset?.()} />
      )}
    </div>
  );
}

function Progress({
  widget,
  config,
  cards,
}: {
  widget: Extract<Widget, { type: "progress_by_dimension" }>;
  config: BoardConfig;
  cards: CardOut[];
}) {
  const dimension = findDimension(config, widget.dimension);
  if (!dimension) return null;
  const rows = progressByDimension(
    cards,
    dimension,
    widget.done_rule ?? "column_kind:done",
    config,
  );
  return (
    <div className="kb-ms-row" data-widget="progress">
      {rows.map(({ value, done, total, percent }) => (
        <div key={value.key} className="kb-ms" title={value.hint ?? undefined}>
          <b>{value.name}</b>
          {widget.show_counter !== false && (
            <span data-testid={`progress-${value.key}`}>
              {done}/{total}
            </span>
          )}
          {widget.show_hint !== false && value.hint && (
            <div className="kb-ms-hint">{value.hint}</div>
          )}
          <div
            className="kb-bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={value.name}
          >
            <i
              style={{
                width: `${percent}%`,
                background: resolveColor(widget.bar_color ?? "{accent}"),
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function FilterBar({
  widget,
  config,
  filters,
  onFilters,
}: WidgetProps & { widget: Extract<Widget, { type: "filter_bar" }> }) {
  const { t } = useT();
  return (
    <div className="kb-filters" data-widget="filter-bar">
      {widget.search !== false && (
        <input
          className="kb-input"
          type="search"
          value={filters.search}
          placeholder={t("board.searchPlaceholder")}
          aria-label={t("board.searchPlaceholder")}
          onChange={(event) => onFilters({ ...filters, search: event.target.value })}
        />
      )}
      {(widget.selects ?? []).map((key) => {
        const dimension = findDimension(config, key);
        if (!dimension) return null;
        const label = t("board.all", { name: dimension.name });
        return (
          <select
            key={key}
            className="kb-input"
            aria-label={label}
            data-dimension={key}
            value={filters.dimensions[key]?.[0] ?? ""}
            onChange={(event) =>
              onFilters({
                ...filters,
                dimensions: {
                  ...filters.dimensions,
                  [key]: event.target.value ? [event.target.value] : [],
                },
              })
            }
          >
            <option value="">{label}</option>
            {dimension.values?.map((value) => (
              <option key={value.key} value={value.key}>
                {value.name === "—" ? t("board.unassigned") : value.name}
              </option>
            ))}
          </select>
        );
      })}
    </div>
  );
}

function Chips({
  widget,
  config,
  filters,
  onFilters,
}: WidgetProps & { widget: Extract<Widget, { type: "filter_chips" }> }) {
  const dimension = findDimension(config, widget.dimension);
  if (!dimension) return null;
  const selected = filters.dimensions[dimension.key] ?? [];
  const toggle = (key: string) => {
    const next = selected.includes(key)
      ? selected.filter((item) => item !== key)
      : widget.multi === false
        ? [key]
        : [...selected, key];
    onFilters({ ...filters, dimensions: { ...filters.dimensions, [dimension.key]: next } });
  };
  const style = widget.chip_style ?? "left-border-color";
  return (
    <div className="kb-chips" data-widget="chips" data-dimension={dimension.key}>
      {dimension.values?.map((value) => {
        const color = resolveColor(value.color);
        return (
          <button
            key={value.key}
            type="button"
            className="kb-chip"
            aria-pressed={selected.includes(value.key)}
            data-chip-style={style}
            data-value={value.key}
            style={{ "--chip": color ?? "var(--t-border-strong)" } as React.CSSProperties}
            onClick={() => toggle(value.key)}
          >
            {style === "dot" && <i className="kb-tag-dot" aria-hidden />}
            {value.name}
          </button>
        );
      })}
    </div>
  );
}

function Stats({
  widget,
  config,
  cards,
}: {
  widget: Extract<Widget, { type: "stats" }>;
  config: BoardConfig;
  cards: CardOut[];
}) {
  const { t } = useT();
  const today = todayIso();
  return (
    <dl className="kb-stats" data-widget="stats">
      {(widget.metrics ?? []).map((metric) => (
        <div key={metric}>
          <dt>{t(`stats.${metric}`)}</dt>
          <dd data-testid={`stat-${metric}`}>
            {computeStat(metric as StatMetric, cards, config, today)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Legend({
  widget,
  config,
}: {
  widget: Extract<Widget, { type: "legend" }>;
  config: BoardConfig;
}) {
  const dimension = findDimension(config, widget.dimension);
  if (!dimension) return null;
  return (
    <ul className="kb-legend" data-widget="legend" aria-label={dimension.name}>
      {dimension.values?.map((value) => (
        <li key={value.key}>
          <i
            className="kb-tag-dot"
            style={{ background: resolveColor(value.color) ?? "var(--t-accent-dim)" }}
            aria-hidden
          />
          {value.icon ? `${value.icon} ` : ""}
          {value.name}
        </li>
      ))}
    </ul>
  );
}

function renderWidget(widget: Widget, props: WidgetProps): ReactNode {
  switch (widget.type) {
    case "progress_by_dimension":
      return <Progress widget={widget} config={props.config} cards={props.cards} />;
    case "filter_bar":
      return <FilterBar widget={widget} {...props} />;
    case "filter_chips":
      return <Chips widget={widget} {...props} />;
    case "stats":
      return <Stats widget={widget} config={props.config} cards={props.cards} />;
    case "note":
      return <p className="kb-note">{widget.text}</p>;
    case "legend":
      return <Legend widget={widget} config={props.config} />;
    default:
      return null;
  }
}

/** Заголовок и действия по умолчанию включены, даже если шаблон их не перечисляет. */
export function normalizedWidgets(config: BoardConfig): Widget[] {
  const widgets = config.layout?.header?.widgets ?? [];
  const implicit: Widget[] = [];
  if (!widgets.some((widget) => widget.type === "title")) implicit.push({ type: "title" });
  if (!widgets.some((widget) => widget.type === "actions")) implicit.push({ type: "actions" });
  return [...implicit, ...widgets].filter((widget) => widget.enabled !== false);
}

export function BoardHeader({
  name,
  actions,
  ...props
}: WidgetProps & { name: string; actions: BoardActions }) {
  const subtitle = props.config.layout?.header?.subtitle;
  const widgets = normalizedWidgets(props.config);
  const blocks: ReactNode[] = [];
  let row: Widget[] = [];
  const flushRow = () => {
    if (!row.length) return;
    blocks.push(
      <div key={`top-${blocks.length}`} className="kb-top">
        {row.map((widget) =>
          widget.type === "title" ? (
            <h1 key="title" className="kb-title">
              {name}
              {subtitle && <small className="kb-subtitle">{subtitle}</small>}
            </h1>
          ) : (
            <Actions
              key="actions"
              widget={widget as Extract<Widget, { type: "actions" }>}
              actions={actions}
            />
          ),
        )}
      </div>,
    );
    row = [];
  };
  widgets.forEach((widget, index) => {
    if (widget.type === "title" || widget.type === "actions") {
      row.push(widget);
      return;
    }
    flushRow();
    blocks.push(<div key={`w-${index}`}>{renderWidget(widget, props)}</div>);
  });
  flushRow();
  return <header className="kb-header">{blocks}</header>;
}
