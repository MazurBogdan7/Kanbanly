/** Белый список шрифтов (совпадает с FONTS на бэкенде). Файлы self-hosted, грузятся по запросу. */

interface FontEntry {
  stack: string;
  load?: () => Promise<unknown>;
}

export const FONTS: Record<string, FontEntry> = {
  Inter: {
    stack: "Inter, system-ui, sans-serif",
    load: () =>
      Promise.all([
        import("@fontsource/inter/400.css"),
        import("@fontsource/inter/500.css"),
        import("@fontsource/inter/600.css"),
        import("@fontsource/inter/700.css"),
      ]),
  },
  Manrope: {
    stack: "Manrope, system-ui, sans-serif",
    load: () =>
      Promise.all([
        import("@fontsource/manrope/400.css"),
        import("@fontsource/manrope/500.css"),
        import("@fontsource/manrope/600.css"),
        import("@fontsource/manrope/700.css"),
        import("@fontsource/manrope/800.css"),
      ]),
  },
  "IBM Plex Sans": {
    stack: '"IBM Plex Sans", system-ui, sans-serif',
    load: () =>
      Promise.all([
        import("@fontsource/ibm-plex-sans/400.css"),
        import("@fontsource/ibm-plex-sans/500.css"),
        import("@fontsource/ibm-plex-sans/600.css"),
      ]),
  },
  Roboto: {
    stack: "Roboto, system-ui, sans-serif",
    load: () =>
      Promise.all([
        import("@fontsource/roboto/400.css"),
        import("@fontsource/roboto/500.css"),
        import("@fontsource/roboto/700.css"),
      ]),
  },
  Nunito: {
    stack: "Nunito, system-ui, sans-serif",
    load: () =>
      Promise.all([
        import("@fontsource/nunito/400.css"),
        import("@fontsource/nunito/500.css"),
        import("@fontsource/nunito/700.css"),
      ]),
  },
  "Space Grotesk": {
    stack: '"Space Grotesk", system-ui, sans-serif',
    load: () =>
      Promise.all([
        import("@fontsource/space-grotesk/400.css"),
        import("@fontsource/space-grotesk/500.css"),
        import("@fontsource/space-grotesk/700.css"),
      ]),
  },
  "Cormorant SC": {
    stack: '"Cormorant SC", Georgia, serif',
    load: () =>
      Promise.all([
        import("@fontsource/cormorant-sc/600.css"),
        import("@fontsource/cormorant-sc/700.css"),
      ]),
  },
  "Playfair Display": {
    stack: '"Playfair Display", Georgia, serif',
    load: () =>
      Promise.all([
        import("@fontsource/playfair-display/400.css"),
        import("@fontsource/playfair-display/700.css"),
      ]),
  },
  Lora: {
    stack: "Lora, Georgia, serif",
    load: () =>
      Promise.all([
        import("@fontsource/lora/400.css"),
        import("@fontsource/lora/600.css"),
        import("@fontsource/lora/700.css"),
      ]),
  },
  "PT Serif": {
    stack: '"PT Serif", Georgia, serif',
    load: () =>
      Promise.all([import("@fontsource/pt-serif/400.css"), import("@fontsource/pt-serif/700.css")]),
  },
  "JetBrains Mono": {
    stack: '"JetBrains Mono", ui-monospace, monospace',
    load: () =>
      Promise.all([
        import("@fontsource/jetbrains-mono/400.css"),
        import("@fontsource/jetbrains-mono/500.css"),
        import("@fontsource/jetbrains-mono/600.css"),
        import("@fontsource/jetbrains-mono/700.css"),
      ]),
  },
  "system-ui": { stack: "system-ui, sans-serif" },
  serif: { stack: "Georgia, serif" },
  monospace: { stack: "ui-monospace, monospace" },
};

export const FONT_NAMES = Object.keys(FONTS);

const loaded = new Set<string>();

export function fontStack(name: string | null | undefined): string | undefined {
  return name ? FONTS[name]?.stack : undefined;
}

export function ensureFont(name: string | null | undefined): void {
  if (!name || loaded.has(name)) return;
  loaded.add(name);
  void FONTS[name]?.load?.();
}
