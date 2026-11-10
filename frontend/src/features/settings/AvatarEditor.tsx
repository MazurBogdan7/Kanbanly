/**
 * Кадрирование аватара в браузере: картинку двигают и масштабируют под круг, на сервер уходит
 * только готовый квадрат 256×256 — исходное фото с компьютера никуда не загружается.
 */
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { Button, ErrorNote, Modal } from "@/components/ui";
import { useT } from "@/i18n";

const VIEW = 288;
const CIRCLE = 240;
const MARGIN = (VIEW - CIRCLE) / 2;
const OUTPUT = 256;
const MAX_ZOOM = 5;

export interface Crop {
  /** Масштаб относительно «вписать круг в картинку» (1 — минимальный). */
  zoom: number;
  /** Левый верхний угол картинки относительно круга, в пикселях экрана. */
  x: number;
  y: number;
}

/** Картинка всегда закрывает круг целиком: сдвиг ограничен её краями. */
export function clampCrop(crop: Crop, width: number, height: number): Crop {
  const zoom = Math.min(Math.max(crop.zoom, 1), MAX_ZOOM);
  const scale = (CIRCLE / Math.min(width, height)) * zoom;
  const clamp = (value: number, size: number) =>
    Math.min(0, Math.max(CIRCLE - size * scale, value));
  return { zoom, x: clamp(crop.x, width), y: clamp(crop.y, height) };
}

/** По умолчанию круг по центру картинки и вписан в её меньшую сторону. */
export function centeredCrop(width: number, height: number): Crop {
  const scale = CIRCLE / Math.min(width, height);
  return { zoom: 1, x: (CIRCLE - width * scale) / 2, y: (CIRCLE - height * scale) / 2 };
}

/** Масштаб вокруг центра круга: то, что было в центре, там и остаётся. */
export function zoomCrop(crop: Crop, next: number, width: number, height: number): Crop {
  const base = CIRCLE / Math.min(width, height);
  const from = base * crop.zoom;
  const zoom = Math.min(Math.max(next, 1), MAX_ZOOM);
  const to = base * zoom;
  const center = CIRCLE / 2;
  return clampCrop(
    {
      zoom,
      x: center - ((center - crop.x) * to) / from,
      y: center - ((center - crop.y) * to) / from,
    },
    width,
    height,
  );
}

async function exportCrop(image: HTMLImageElement, crop: Crop): Promise<Blob> {
  const scale = (CIRCLE / Math.min(image.naturalWidth, image.naturalHeight)) * crop.zoom;
  const canvas = document.createElement("canvas");
  canvas.width = OUTPUT;
  canvas.height = OUTPUT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.imageSmoothingQuality = "high";
  const size = CIRCLE / scale;
  context.drawImage(image, -crop.x / scale, -crop.y / scale, size, size, 0, 0, OUTPUT, OUTPUT);
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  // WebP компактнее; если браузер не умеет его кодировать — PNG.
  const webp = await encode("image/webp");
  if (webp && webp.type === "image/webp") return webp;
  const png = await encode("image/png");
  if (!png) throw new Error("encode");
  return png;
}

export function AvatarEditor({
  file,
  onCancel,
  onSave,
  saving,
}: {
  file: File;
  onCancel: () => void;
  onSave: (image: Blob) => void;
  saving?: boolean;
}) {
  const { t } = useT();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);

  useEffect(() => {
    // data:, а не blob: — политика безопасности страницы (CSP) разрешает картинки data:.
    let cancelled = false;
    const reader = new FileReader();
    reader.onload = () => {
      const element = new Image();
      element.onload = () => {
        if (cancelled) return;
        setImage(element);
        setCrop(centeredCrop(element.naturalWidth, element.naturalHeight));
      };
      element.onerror = () => !cancelled && setFailed(true);
      element.src = String(reader.result);
    };
    reader.onerror = () => !cancelled && setFailed(true);
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
      reader.abort();
    };
  }, [file]);

  const width = image?.naturalWidth ?? 1;
  const height = image?.naturalHeight ?? 1;
  const scale = (CIRCLE / Math.min(width, height)) * crop.zoom;
  const zoomTo = (next: number) => setCrop((current) => zoomCrop(current, next, width, height));
  const move = (dx: number, dy: number) =>
    setCrop((current) =>
      clampCrop({ ...current, x: current.x + dx, y: current.y + dy }, width, height),
    );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, crop };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    setCrop(
      clampCrop(
        {
          ...start.crop,
          x: start.crop.x + event.clientX - start.x,
          y: start.crop.y + event.clientY - start.y,
        },
        width,
        height,
      ),
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 30 : 8;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => move(step, 0),
      ArrowRight: () => move(-step, 0),
      ArrowUp: () => move(0, step),
      ArrowDown: () => move(0, -step),
      "+": () => zoomTo(crop.zoom * 1.1),
      "=": () => zoomTo(crop.zoom * 1.1),
      "-": () => zoomTo(crop.zoom / 1.1),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t("avatar.cropTitle")}
      width={380}
    >
      <div className="grid justify-items-center gap-4">
        {failed ? (
          <ErrorNote message={t("avatar.unreadable")} />
        ) : (
          <>
            <p className="text-center text-xs text-ink-soft">{t("avatar.cropHint")}</p>
            <div
              role="application"
              aria-label={t("avatar.cropArea")}
              tabIndex={0}
              data-testid="avatar-crop"
              className="relative cursor-grab touch-none overflow-hidden rounded-md bg-black select-none focus-visible:outline-2 focus-visible:outline-brand active:cursor-grabbing"
              style={{ width: VIEW, height: VIEW }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onWheel={(event) => zoomTo(crop.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08))}
              onKeyDown={onKeyDown}
            >
              {image && (
                <img
                  src={image.src}
                  alt=""
                  draggable={false}
                  className="pointer-events-none absolute max-w-none"
                  style={{
                    left: MARGIN + crop.x,
                    top: MARGIN + crop.y,
                    width: width * scale,
                    height: height * scale,
                  }}
                />
              )}
              {/* Затемнение вокруг круга: видно, что попадёт в аватар. */}
              <div
                aria-hidden
                className="pointer-events-none absolute rounded-full border-2 border-white/90"
                style={{
                  left: MARGIN,
                  top: MARGIN,
                  width: CIRCLE,
                  height: CIRCLE,
                  boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
                }}
              />
            </div>
            <div className="flex w-full items-center gap-2">
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("avatar.zoomOut")}
                onClick={() => zoomTo(crop.zoom / 1.2)}
              >
                <Minus className="size-4" aria-hidden />
              </Button>
              <input
                type="range"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={crop.zoom}
                aria-label={t("avatar.zoom")}
                className="flex-1 accent-brand"
                onChange={(event) => zoomTo(Number(event.target.value))}
              />
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("avatar.zoomIn")}
                onClick={() => zoomTo(crop.zoom * 1.2)}
              >
                <Plus className="size-4" aria-hidden />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("avatar.reset")}
                title={t("avatar.reset")}
                onClick={() => image && setCrop(centeredCrop(width, height))}
              >
                <RotateCcw className="size-4" aria-hidden />
              </Button>
            </div>
          </>
        )}
        <div className="flex w-full justify-end gap-2">
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            disabled={!image}
            loading={saving}
            onClick={() => {
              if (image) void exportCrop(image, crop).then(onSave);
            }}
          >
            {t("avatar.save")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
