import { useT } from "@/i18n";
import type { BoardConfig, CardOut, ViewTemplate } from "@/lib/api/types";

import { accentColor } from "./CardFace";
import { isDone, progressByDimension } from "./model";
import { resolveColor } from "./theme";

/** Измерение таймлайна: из представления, иначе первое упорядоченное (вехи, спринты). */
export function timelineDimension(config: BoardConfig, view: ViewTemplate | undefined) {
  const dimensions = config.dimensions ?? [];
  return (
    dimensions.find((dimension) => dimension.key === view?.group_by) ??
    dimensions.find((dimension) => dimension.type === "ordered_select")
  );
}

export function TimelineView({
  config,
  cards,
  allCards,
  view,
  onOpen,
}: {
  config: BoardConfig;
  cards: CardOut[];
  allCards: CardOut[];
  view: ViewTemplate | undefined;
  onOpen?: (card: CardOut) => void;
}) {
  const { t } = useT();
  const dimension = timelineDimension(config, view);
  if (!dimension) return <p className="kb-note kb-view-note">{t("timeline.noDimension")}</p>;
  const rule = "column_kind:done";
  const progress = progressByDimension(allCards, dimension, rule, config);
  return (
    <section className="kb-timeline" aria-label={`${t("timeline.title")}: ${dimension.name}`}>
      {progress.map(({ value, done, total, percent }) => {
        const list = cards.filter((card) => card.values[dimension.key]?.includes(value.key));
        return (
          <article key={value.key} className="kb-timeline-stage" data-value={value.key}>
            <header className="kb-timeline-head">
              <h2>{value.name}</h2>
              <span>
                {done}/{total}
              </span>
              {value.hint && <p className="kb-ms-hint">{value.hint}</p>}
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
                    background: resolveColor(value.color) ?? "var(--t-accent)",
                  }}
                />
              </div>
            </header>
            <ul className="kb-timeline-list">
              {list.map((card) => (
                <li key={card.id}>
                  <button
                    type="button"
                    className="kb-timeline-card"
                    data-done={isDone(card, rule, config) || undefined}
                    style={{
                      borderLeftColor:
                        accentColor(
                          card,
                          config,
                          config.columns.find((c) => c.key === card.column),
                        ) ?? "var(--t-accent-dim)",
                    }}
                    onClick={() => onOpen?.(card)}
                  >
                    <span>{card.title}</span>
                    <small>
                      {config.columns.find((column) => column.key === card.column)?.name}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
    </section>
  );
}
