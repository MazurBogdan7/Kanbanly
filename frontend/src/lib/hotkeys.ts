import { useEffect, useRef } from "react";

export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export type HotkeyMap = Record<string, (event: KeyboardEvent) => void>;

/** Ключи: "n", "?", "/", "mod+k", "mod+z", "mod+shift+z". В полях ввода работает только mod+k. */
export function matchHotkey(
  event: KeyboardEvent,
  map: HotkeyMap,
): ((e: KeyboardEvent) => void) | null {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const typing = isTyping(event.target);
  if (mod) {
    // Ctrl+Z в поле ввода остаётся браузеру: это отмена набора, а не действия на доске.
    if (typing && key !== "k") return null;
    return map[event.shiftKey ? `mod+shift+${key}` : `mod+${key}`] ?? null;
  }
  if (event.altKey || typing) return null;
  return map[event.key] ?? map[key] ?? null;
}

export function useHotkeys(map: HotkeyMap): void {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const action = matchHotkey(event, latest.current);
      if (!action) return;
      event.preventDefault();
      action(event);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

/** Навигация стрелками: двигает фокус между карточками доски. */
export function moveCardFocus(key: string): void {
  const current = document.activeElement?.closest<HTMLElement>("[data-card-id]") ?? null;
  const columns = [...document.querySelectorAll<HTMLElement>(".kb-list")];
  if (!current) {
    columns.flatMap((c) => [...c.querySelectorAll<HTMLElement>("[data-card-id]")])[0]?.focus();
    return;
  }
  const list = current.closest<HTMLElement>(".kb-list");
  const cards = [...(list?.querySelectorAll<HTMLElement>("[data-card-id]") ?? [])];
  const index = cards.indexOf(current);
  if (key === "ArrowDown") cards[index + 1]?.focus();
  if (key === "ArrowUp") cards[index - 1]?.focus();
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const step = key === "ArrowLeft" ? -1 : 1;
    let columnIndex = list ? columns.indexOf(list) + step : -1;
    while (columns[columnIndex]) {
      const target = [...columns[columnIndex]!.querySelectorAll<HTMLElement>("[data-card-id]")];
      if (target.length) {
        (target[Math.min(index, target.length - 1)] as HTMLElement).focus();
        return;
      }
      columnIndex += step;
    }
  }
}
