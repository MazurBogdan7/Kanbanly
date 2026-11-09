import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { useT } from "@/i18n";
import type { BoardConfig, CardOut } from "@/lib/api/types";

import { accentColor } from "./CardFace";
import { todayIso } from "./model";

function monthStart(iso: string): Date {
  const [year, month] = iso.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, 1));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Сетка месяца с понедельника: 6 недель, чтобы высота не прыгала между месяцами. */
export function monthGrid(start: Date): Date[] {
  const offset = (start.getUTCDay() + 6) % 7;
  const first = new Date(start);
  first.setUTCDate(first.getUTCDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(first);
    day.setUTCDate(first.getUTCDate() + index);
    return day;
  });
}

export function CalendarView({
  config,
  cards,
  onOpen,
}: {
  config: BoardConfig;
  cards: CardOut[];
  onOpen?: (card: CardOut) => void;
}) {
  const { t, locale } = useT();
  const today = todayIso();
  const [month, setMonth] = useState(() => monthStart(today));
  const byDay = useMemo(() => {
    const map = new Map<string, CardOut[]>();
    for (const card of cards) {
      if (card.due_date) map.set(card.due_date, [...(map.get(card.due_date) ?? []), card]);
    }
    return map;
  }, [cards]);
  const undated = cards.filter((card) => !card.due_date).length;
  const days = monthGrid(month);
  const title = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(month);
  const weekdays = days
    .slice(0, 7)
    .map((day) =>
      new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(day),
    );
  const shift = (delta: number) =>
    setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1)));

  return (
    <section className="kb-calendar" aria-label={t("calendar.title")}>
      <div className="kb-calendar-bar">
        <button
          type="button"
          className="kb-btn"
          aria-label={t("calendar.prev")}
          onClick={() => shift(-1)}
        >
          <ChevronLeft aria-hidden />
        </button>
        <h2 className="kb-calendar-title">{title}</h2>
        <button
          type="button"
          className="kb-btn"
          aria-label={t("calendar.next")}
          onClick={() => shift(1)}
        >
          <ChevronRight aria-hidden />
        </button>
        <button type="button" className="kb-btn" onClick={() => setMonth(monthStart(today))}>
          {t("calendar.today")}
        </button>
        {undated > 0 && (
          <span className="kb-note">{t("calendar.undated", { count: undated })}</span>
        )}
      </div>
      <div className="kb-calendar-grid" role="grid" aria-label={title}>
        {weekdays.map((name) => (
          <div key={name} className="kb-calendar-weekday" role="columnheader">
            {name}
          </div>
        ))}
        {days.map((day) => {
          const key = iso(day);
          const list = byDay.get(key) ?? [];
          return (
            <div
              key={key}
              role="gridcell"
              className="kb-calendar-day"
              data-outside={day.getUTCMonth() !== month.getUTCMonth() || undefined}
              data-today={key === today || undefined}
              data-date={key}
            >
              <span className="kb-calendar-date">{day.getUTCDate()}</span>
              {list.map((card) => (
                <button
                  key={card.id}
                  type="button"
                  className="kb-calendar-card"
                  style={{
                    borderLeftColor:
                      accentColor(
                        card,
                        config,
                        config.columns.find((c) => c.key === card.column),
                      ) ?? "var(--t-accent)",
                  }}
                  onClick={() => onOpen?.(card)}
                >
                  {card.title}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
