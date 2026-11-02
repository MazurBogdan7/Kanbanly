/** Элементы конструктора: цвет с токенами, сортируемый список, раскрывающиеся секции. */
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

import { Button, Field, Input, Select } from "@/components/ui";
import { useT } from "@/i18n";
import type { BoardConfig } from "@/lib/api/types";

import { resolveHex, tokensOf } from "../boards/engine/theme";

export function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function SortableRow({ id, children, label }: { id: string; children: ReactNode; label: string }) {
  const { t } = useT();
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="flex items-start gap-1 rounded-md border border-line bg-panel p-2"
    >
      <button
        type="button"
        className="mt-1 cursor-grab rounded-sm p-0.5 text-ink-soft hover:bg-raised"
        aria-label={`${t("common.moveHandle")}: ${label}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function SortableList<T>({
  items,
  getKey,
  getLabel,
  onReorder,
  children,
}: {
  items: T[];
  getKey: (item: T) => string;
  getLabel: (item: T) => string;
  onReorder: (items: T[]) => void;
  children: (item: T, index: number) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = items.findIndex((item) => getKey(item) === active.id);
    const to = items.findIndex((item) => getKey(item) === over.id);
    onReorder(arrayMove(items, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleEnd}>
      <SortableContext items={items.map(getKey)} strategy={verticalListSortingStrategy}>
        <div className="grid gap-2">
          {items.map((item, index) => (
            <SortableRow key={getKey(item)} id={getKey(item)} label={getLabel(item)}>
              {children(item, index)}
            </SortableRow>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

export function Collapsible({
  title,
  children,
  open,
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
}) {
  return (
    <details open={open} className="group rounded-sm">
      <summary className="cursor-pointer py-1 text-xs font-medium text-ink-soft hover:text-ink">
        {title}
      </summary>
      <div className="grid gap-2 pt-2">{children}</div>
    </details>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" aria-label={label} onClick={onClick}>
      <Trash2 className="size-3.5" aria-hidden />
    </Button>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  config,
  allowEmpty,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  config: BoardConfig;
  allowEmpty?: boolean;
}) {
  const tokens = tokensOf(config);
  const isToken = value?.startsWith("{");
  const hex = resolveHex(value, tokens)?.slice(0, 7) ?? "#000000";
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex items-center gap-1">
          <input
            type="color"
            aria-label={`${label}: палитра`}
            className="size-8 shrink-0 cursor-pointer rounded-sm border border-line-strong bg-panel p-0.5"
            value={hex}
            onChange={(event) => onChange(event.target.value.toUpperCase())}
          />
          <Input
            id={id}
            className="min-w-0 font-mono text-xs"
            value={isToken ? "" : (value ?? "")}
            placeholder="#RRGGBB"
            maxLength={9}
            onChange={(event) => {
              const next = event.target.value;
              if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(next)) onChange(next);
              else if (!next && allowEmpty) onChange(null);
            }}
          />
          <Select
            aria-label={`${label}: токен`}
            className="w-28 shrink-0 text-xs"
            value={isToken ? (value ?? "") : ""}
            onChange={(event) => onChange(event.target.value || (allowEmpty ? null : hex))}
          >
            <option value="">токен…</option>
            {Object.keys(tokens).map((token) => (
              <option key={token} value={`{${token}}`}>
                {token}
              </option>
            ))}
          </Select>
        </div>
      )}
    </Field>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ""}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") onChange(null);
            else {
              const parsed = Number(raw);
              const inRange =
                (min === undefined || parsed >= min) && (max === undefined || parsed <= max);
              if (inRange) onChange(parsed);
            }
          }}
        />
      )}
    </Field>
  );
}
