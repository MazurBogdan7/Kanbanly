/** Единственное место с innerHTML: Markdown → HTML → санитизация DOMPurify. */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo, type MouseEvent } from "react";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "del",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
];

/** Префикс меток разделов: так id документа не совпадёт с id самой страницы. */
export const ANCHOR_PREFIX = "doc-";
const ANCHOR = /^doc-[\p{L}\p{N}_.-]{1,120}$/u;

/** Слаг заголовка как на GitHub: строчные буквы, без знаков препинания, пробелы → «-». */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

let headingSlugs = new Map<string, number>();

/** Внутренние ссылки (#раздел) остаются на странице; внешние открываются в новой вкладке. */
function linkTarget(node: Element) {
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    node.removeAttribute("target");
    return;
  }
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
}

const purifier = DOMPurify();
purifier.addHook("afterSanitizeAttributes", (node) => {
  linkTarget(node);
  // Заголовки получают метку, чтобы работало оглавление вида [Раздел](#раздел).
  if (/^H[1-6]$/.test(node.tagName)) {
    const base = slugify(node.textContent ?? "") || "section";
    const seen = headingSlugs.get(base) ?? 0;
    headingSlugs.set(base, seen + 1);
    node.setAttribute("id", `${ANCHOR_PREFIX}${seen ? `${base}-${seen}` : base}`);
  }
});

/** Переход по внутренней ссылке: прокрутка к разделу внутри этого же блока, адрес не меняется. */
export function followAnchor(event: MouseEvent<HTMLElement>) {
  const link = (event.target as Element).closest?.("a[href^='#']");
  if (!link) return;
  event.preventDefault();
  const raw = decodeURIComponent(link.getAttribute("href")?.slice(1) ?? "");
  const id = raw.startsWith(ANCHOR_PREFIX) ? raw : `${ANCHOR_PREFIX}${slugify(raw)}`;
  const target = Array.from(event.currentTarget.querySelectorAll("[id]")).find(
    (node) => node.id === id || node.id === `${ANCHOR_PREFIX}${raw}`,
  );
  target?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Сырой HTML в Markdown не поддерживается: показываем как текст, до DOM он не доходит.
const markdown = new Marked({
  async: false,
  gfm: true,
  breaks: true,
  renderer: { html: ({ text }) => escapeHtml(text) },
});

export function renderMarkdown(source: string): string {
  const html = markdown.parse(source, { async: false });
  headingSlugs = new Map();
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel", "id"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
  });
}

export function SafeMarkdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div className={className} onClick={followAnchor} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

const OFFICE_TAGS = [
  ...ALLOWED_TAGS,
  "b",
  "i",
  "u",
  "s",
  "sub",
  "sup",
  "h5",
  "h6",
  "img",
  "span",
  "caption",
];

/**
 * Просмотр Word и Excel. Сервер уже очистил HTML белым списком; здесь вторая линия защиты:
 * картинки только встроенные (data:image) или из самого документа (наш адрес /api/v1/…/images/N),
 * ссылки только http(s) и mailto.
 */
const DOCUMENT_IMAGE = /^\/api\/v1\/documents\/[\w-]+\/versions\/\d+\/images\/\d+$/;
const officePurifier = DOMPurify();
officePurifier.addHook("afterSanitizeAttributes", (node) => {
  linkTarget(node);
  // Метки разделов только с префиксом; ссылки только на них.
  if (node.hasAttribute("id") && !ANCHOR.test(node.getAttribute("id") ?? "")) {
    node.removeAttribute("id");
  }
  const href = node.getAttribute("href") ?? "";
  if (node.tagName === "A" && href.startsWith("#") && !ANCHOR.test(href.slice(1))) {
    node.removeAttribute("href");
  }
  // Внешние картинки в документе — это пиксели слежения: показываем только свои.
  const src = node.getAttribute("src") ?? "";
  if (node.tagName === "IMG" && !/^data:image\//i.test(src) && !DOCUMENT_IMAGE.test(src)) {
    node.removeAttribute("src");
  }
  if (node.tagName === "IMG") node.setAttribute("loading", "lazy");
});

export function sanitizeOfficeHtml(html: string): string {
  return officePurifier.sanitize(html, {
    ALLOWED_TAGS: OFFICE_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "colspan", "rowspan", "loading", "id"],
    ADD_URI_SAFE_ATTR: ["colspan", "rowspan", "loading"],
    ALLOWED_URI_REGEXP:
      /^(?:https?:|mailto:|#|data:image\/(?:png|jpe?g|gif|webp);|\/api\/v1\/documents\/[\w-]+\/versions\/\d+\/images\/\d+$)/i,
  });
}

export function SafeOfficeHtml({ html, className }: { html: string; className?: string }) {
  const clean = useMemo(() => sanitizeOfficeHtml(html), [html]);
  return (
    <div className={className} onClick={followAnchor} dangerouslySetInnerHTML={{ __html: clean }} />
  );
}
