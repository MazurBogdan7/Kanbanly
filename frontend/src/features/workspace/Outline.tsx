/**
 * Содержание документа: строится по заголовкам (Word, Markdown) или закладкам (PDF).
 * Закреплено сбоку, подсвечивает текущий раздел и прокручивает к выбранному.
 */
import { ListTree } from "lucide-react";
import { useEffect, useState } from "react";

import { cx } from "@/components/ui";
import { useT } from "@/i18n";

export interface OutlineItem {
  /** id элемента на странице, к которому ведёт пункт. */
  anchor: string;
  title: string;
  level: number;
  /** Уникальный ключ, если несколько пунктов ведут к одному месту (закладки PDF на одной странице). */
  key?: string;
}

const HEADINGS = "h1, h2, h3, h4, h5, h6";
const MAX_ITEMS = 400;

/** Заголовки отрисованного документа; заголовок без метки получает свою (doc-h-N). */
export function headingsOf(root: HTMLElement): OutlineItem[] {
  const items: OutlineItem[] = [];
  root.querySelectorAll<HTMLElement>(HEADINGS).forEach((heading, index) => {
    const title = (heading.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!title || items.length >= MAX_ITEMS) return;
    if (!heading.id) heading.id = `doc-h-${index}`;
    items.push({ anchor: heading.id, title, level: Number(heading.tagName.slice(1)) });
  });
  return items;
}

export function scrollToAnchor(anchor: string) {
  document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Текущий раздел — последний, чей заголовок уже поднялся к верху экрана. */
function useActive(items: OutlineItem[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!items.length) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let current: string | null = null;
        for (const item of items) {
          const element = document.getElementById(item.anchor);
          if (!element) continue;
          if (element.getBoundingClientRect().top <= 140) current = item.anchor;
          else break;
        }
        setActive(current ?? items[0]?.anchor ?? null);
      });
    };
    update();
    // Прокручивается не окно, а основная область приложения: слушаем всё в фазе перехвата.
    document.addEventListener("scroll", update, { capture: true, passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", update, { capture: true });
      window.removeEventListener("resize", update);
    };
  }, [items]);
  return active;
}

function Items({
  items,
  active,
  onPick,
}: {
  items: OutlineItem[];
  active: string | null;
  onPick?: () => void;
}) {
  const top = Math.min(...items.map((item) => item.level));
  return (
    <ol className="grid gap-0.5 text-sm">
      {items.map((item) => (
        <li key={item.key ?? item.anchor}>
          <button
            type="button"
            aria-current={active === item.anchor ? "location" : undefined}
            className={cx(
              "w-full rounded-sm py-1 pr-2 text-left leading-snug transition-colors [overflow-wrap:anywhere]",
              active === item.anchor
                ? "bg-brand-soft font-medium text-ink"
                : "text-ink-soft hover:bg-raised hover:text-ink",
            )}
            style={{ paddingLeft: `${8 + Math.min(item.level - top, 4) * 12}px` }}
            onClick={() => {
              scrollToAnchor(item.anchor);
              onPick?.();
            }}
          >
            {item.title}
          </button>
        </li>
      ))}
    </ol>
  );
}

/** Закреплённая колонка слева (широкий экран). */
export function OutlineSidebar({ items }: { items: OutlineItem[] }) {
  const { t } = useT();
  const active = useActive(items);
  return (
    <nav
      aria-label={t("docs.outline")}
      data-testid="document-outline"
      className="sticky top-4 grid max-h-[calc(100dvh-6rem)] content-start gap-2 overflow-y-auto rounded-lg border border-line bg-panel p-3"
    >
      <h2 className="flex items-center gap-2 px-2 text-xs font-semibold tracking-wide text-ink-soft uppercase">
        <ListTree className="size-4" aria-hidden />
        {t("docs.outline")}
      </h2>
      <Items items={items} active={active} />
    </nav>
  );
}

/** Закреплённая кнопка над документом (узкий экран): раскрывает тот же список. */
export function OutlineBar({ items }: { items: OutlineItem[] }) {
  const { t } = useT();
  const active = useActive(items);
  const [open, setOpen] = useState(false);
  const current = items.find((item) => item.anchor === active);
  return (
    <div className="sticky top-0 z-10 mb-3 rounded-md border border-line bg-panel shadow-sm">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((value) => !value)}
      >
        <ListTree className="size-4 shrink-0 text-ink-soft" aria-hidden />
        <span className="font-medium">{t("docs.outline")}</span>
        {current && <span className="min-w-0 truncate text-ink-soft">· {current.title}</span>}
      </button>
      {open && (
        <div className="max-h-[60dvh] overflow-y-auto border-t border-line p-2">
          <Items items={items} active={active} onPick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
