/** Единственное место с innerHTML: Markdown → HTML → санитизация DOMPurify. */
import DOMPurify from "dompurify";
import { Marked } from "marked";
import { useMemo } from "react";

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

const purifier = DOMPurify();
purifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

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
  return purifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  });
}

export function SafeMarkdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
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
 * картинки только встроенные (data:image), ссылки только http(s) и mailto.
 */
const officePurifier = DOMPurify();
officePurifier.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
  // Внешние картинки в документе — это пиксели слежения: показываем только встроенные.
  if (node.tagName === "IMG" && !/^data:image\//i.test(node.getAttribute("src") ?? "")) {
    node.removeAttribute("src");
  }
});

export function sanitizeOfficeHtml(html: string): string {
  return officePurifier.sanitize(html, {
    ALLOWED_TAGS: OFFICE_TAGS,
    ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "colspan", "rowspan"],
    ADD_URI_SAFE_ATTR: ["colspan", "rowspan"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp);)/i,
  });
}

export function SafeOfficeHtml({ html, className }: { html: string; className?: string }) {
  const clean = useMemo(() => sanitizeOfficeHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}
