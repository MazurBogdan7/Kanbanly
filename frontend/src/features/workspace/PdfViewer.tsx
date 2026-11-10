/**
 * Просмотр PDF через pdf.js: страницы рисуются на canvas, файл не открывается как документ браузера.
 * Модуль грузится лениво — pdf.js нужен только тем, кто открыл PDF.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";

import { ErrorNote, Skeleton } from "@/components/ui";
import { useT } from "@/i18n";
import { send } from "@/lib/api/client";

import type { OutlineItem } from "./Outline";

GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_PAGES = 200;
const MAX_OUTLINE = 400;

type OutlineNode = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

export function pageAnchor(number: number): string {
  return `pdf-page-${number}`;
}

/** Закладки PDF → пункты содержания с номером страницы. Закладки без страницы пропускаются. */
async function outlineOf(pdf: PDFDocumentProxy): Promise<OutlineItem[]> {
  const items: OutlineItem[] = [];
  const pageOf = async (node: OutlineNode): Promise<number | null> => {
    try {
      const dest = typeof node.dest === "string" ? await pdf.getDestination(node.dest) : node.dest;
      const ref = dest?.[0];
      if (ref === undefined || ref === null) return null;
      const index = typeof ref === "number" ? ref : await pdf.getPageIndex(ref);
      return index + 1;
    } catch {
      return null;
    }
  };
  const walk = async (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      if (items.length >= MAX_OUTLINE) return;
      const page = await pageOf(node);
      const title = node.title.replace(/\s+/g, " ").trim();
      if (page !== null && page <= MAX_PAGES && title) {
        items.push({ anchor: pageAnchor(page), title, level });
      }
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk((await pdf.getOutline()) ?? [], 1);
  // Несколько закладок на одной странице ведут к ней же; ключ должен быть уникален.
  const seen = new Map<string, number>();
  return items.map((item) => {
    const count = seen.get(item.anchor) ?? 0;
    seen.set(item.anchor, count + 1);
    return count ? { ...item, key: `${item.anchor}#${count}` } : item;
  });
}

function Page({ pdf, number, width }: { pdf: PDFDocumentProxy; number: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(number <= 2);
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (visible || !holder.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true);
      },
      { rootMargin: "800px" },
    );
    observer.observe(holder.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !canvas.current || width <= 0) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    void pdf.getPage(number).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * ratio });
      const element = canvas.current;
      element.width = viewport.width;
      element.height = viewport.height;
      element.style.width = `${width}px`;
      element.style.height = `${viewport.height / ratio}px`;
      const render = page.render({ canvas: element, viewport });
      task = render;
      render.promise.catch(() => undefined);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number, width, visible]);

  return (
    <div
      ref={holder}
      id={pageAnchor(number)}
      className="mx-auto scroll-mt-4 bg-white shadow-sm"
      style={{ minHeight: visible ? undefined : width * 1.3 }}
    >
      <canvas ref={canvas} aria-label={`${number}`} />
    </div>
  );
}

export default function PdfViewer({
  path,
  onOutline,
}: {
  path: string;
  onOutline?: (items: OutlineItem[]) => void;
}) {
  const { t } = useT();
  const box = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setPdf(null);
    setFailed(false);
    void send("GET", path)
      .then((response) => response.arrayBuffer())
      .then((data) => getDocument({ data, isEvalSupported: false }).promise)
      .then((document) => {
        loaded = document;
        if (cancelled) void document.destroy();
        else setPdf(document);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [path]);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.min(Math.floor(entry.contentRect.width), 1000));
    });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!pdf || !onOutline) return;
    let cancelled = false;
    void outlineOf(pdf)
      .then((items) => !cancelled && onOutline(items))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pdf, onOutline]);

  const pages = pdf ? Math.min(pdf.numPages, MAX_PAGES) : 0;
  return (
    <div ref={box} className="grid gap-3" data-testid="pdf-viewer">
      {failed && <ErrorNote message={t("docs.previewFailed")} />}
      {!pdf && !failed && <Skeleton className="h-96" />}
      {pdf &&
        Array.from({ length: pages }, (_, index) => (
          <Page key={index + 1} pdf={pdf} number={index + 1} width={width} />
        ))}
      {pdf && pdf.numPages > MAX_PAGES && (
        <p className="text-center text-sm text-ink-soft">
          {t("docs.pdfTruncated", { count: MAX_PAGES })}
        </p>
      )}
    </div>
  );
}
