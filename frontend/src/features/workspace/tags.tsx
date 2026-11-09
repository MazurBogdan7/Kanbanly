/** Теги проекта: общие для карточек всех досок и для документов. */
import { Check, Plus, Tag as TagIcon, Trash2, X } from "lucide-react";
import { createContext, useContext, useMemo, useState, type FormEvent } from "react";

import { Button, cx, Input, Section } from "@/components/ui";
import { useT } from "@/i18n";
import type { TagOut } from "@/lib/api/types";
import { strongText } from "@/lib/contrast";

import { useTagMutations, useTags } from "./api";

/** Палитра подобрана так, чтобы текст на каждом цвете читался (контраст WCAG AA). */
export const SWATCHES = [
  "#C92A2A",
  "#E8590C",
  "#F59F00",
  "#2F9E44",
  "#0B7285",
  "#1971C2",
  "#5F3DC4",
  "#C2255C",
  "#495057",
  "#FFE8A3",
  "#D3F9D8",
  "#D0EBFF",
  "#E5DBFF",
  "#FFDEEB",
  "#F1F3F5",
] as const;

/** Справочник тегов проекта для лиц карточек: без него карточка не знает имён и цветов. */
export const ProjectTagsContext = createContext<Map<string, TagOut>>(new Map());

export function useTagIndex(projectId: string | undefined): Map<string, TagOut> {
  const tags = useTags(projectId);
  return useMemo(() => new Map((tags.data ?? []).map((tag) => [tag.id, tag])), [tags.data]);
}

export function useProjectTag(id: string): TagOut | undefined {
  return useContext(ProjectTagsContext).get(id);
}

export function TagChip({
  tag,
  onRemove,
  className,
}: {
  tag: Pick<TagOut, "name" | "color">;
  onRemove?: () => void;
  className?: string;
}) {
  const { t } = useT();
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        className,
      )}
      style={{ background: tag.color, color: strongText(tag.color) }}
    >
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          className="-mr-1 rounded-full p-0.5 hover:bg-black/10"
          aria-label={t("tags.removeFrom", { name: tag.name })}
          onClick={onRemove}
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

export function ColorSwatches({
  value,
  onChange,
  label,
  allowNone,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  label: string;
  allowNone?: boolean;
}) {
  const { t } = useT();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      {allowNone && (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          aria-label={t("tags.noColor")}
          title={t("tags.noColor")}
          className={cx(
            "grid size-7 place-items-center rounded-full border border-line bg-panel text-ink-soft",
            value === null && "ring-2 ring-brand ring-offset-1 ring-offset-panel",
          )}
          onClick={() => onChange(null)}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
      {SWATCHES.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value?.toUpperCase() === color}
          aria-label={color}
          title={color}
          className={cx(
            "grid size-7 place-items-center rounded-full border border-black/10",
            value?.toUpperCase() === color && "ring-2 ring-brand ring-offset-1 ring-offset-panel",
          )}
          style={{ background: color, color: strongText(color) }}
          onClick={() => onChange(color)}
        >
          {value?.toUpperCase() === color && <Check className="size-3.5" aria-hidden />}
        </button>
      ))}
      <label className="relative grid size-7 cursor-pointer place-items-center rounded-full border border-dashed border-line text-ink-soft">
        <span className="sr-only">{t("tags.customColor")}</span>
        <Plus className="size-3.5" aria-hidden />
        <input
          type="color"
          className="absolute inset-0 cursor-pointer opacity-0"
          value={value ?? "#1971C2"}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
        />
      </label>
    </div>
  );
}

/** Выбор тегов карточки или документа; новый тег можно создать тут же, он сохранится в проекте. */
export function TagPicker({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useT();
  const tags = useTags(projectId);
  const { create } = useTagMutations(projectId);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(SWATCHES[5]);
  const all = tags.data ?? [];
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((item) => item !== id) : [...value, id]);
  const add = (event: FormEvent | { preventDefault: () => void }) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = all.find((tag) => tag.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      if (!value.includes(existing.id)) onChange([...value, existing.id]);
      setName("");
      return;
    }
    create.mutate(
      { name: trimmed, color },
      {
        onSuccess: (tag) => {
          onChange([...value, tag.id]);
          setName("");
        },
      },
    );
  };
  return (
    <div className="grid gap-2" data-testid="tag-picker">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("tags.title")}>
        {all.length === 0 && <span className="text-xs text-ink-soft">{t("tags.empty")}</span>}
        {all.map((tag) => {
          const selected = value.includes(tag.id);
          return (
            <button
              key={tag.id}
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              className={cx(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium transition",
                selected
                  ? "ring-2 ring-brand ring-offset-1 ring-offset-panel"
                  : "opacity-60 hover:opacity-100",
              )}
              style={{ background: tag.color, color: strongText(tag.color) }}
              onClick={() => toggle(tag.id)}
            >
              {selected && <Check className="size-3" aria-hidden />}
              {tag.name}
            </button>
          );
        })}
      </div>
      {!disabled && (
        <div className="grid gap-2 rounded-md border border-dashed border-line p-2">
          <div className="flex gap-2">
            <Input
              aria-label={t("tags.newName")}
              placeholder={t("tags.newName")}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add(event);
              }}
            />
            <Button size="sm" onClick={add} loading={create.isPending} disabled={!name.trim()}>
              <Plus className="size-3.5" aria-hidden />
              {t("tags.create")}
            </Button>
          </div>
          <ColorSwatches
            value={color}
            onChange={(next) => next && setColor(next)}
            label={t("tags.color")}
          />
        </div>
      )}
    </div>
  );
}

function TagRow({ tag, projectId, canEdit }: { tag: TagOut; projectId: string; canEdit: boolean }) {
  const { t } = useT();
  const { update, remove } = useTagMutations(projectId);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const [sure, setSure] = useState(false);
  if (!editing) {
    return (
      <li className="flex items-center justify-between gap-2 py-1.5">
        <TagChip tag={tag} />
        {canEdit && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t("common.rename")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("tags.delete", { name: tag.name })}
              onClick={() => (sure ? remove.mutate(tag.id) : setSure(true))}
            >
              <Trash2 className="size-3.5" aria-hidden />
              {sure && t("common.confirmAgain")}
            </Button>
          </div>
        )}
      </li>
    );
  }
  return (
    <li className="grid gap-2 rounded-md border border-line p-2">
      <div className="flex gap-2">
        <Input
          aria-label={t("common.name")}
          maxLength={60}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            update.mutate(
              { id: tag.id, name: name.trim() || tag.name },
              { onSuccess: () => setEditing(false) },
            )
          }
        >
          {t("common.save")}
        </Button>
        <Button size="sm" onClick={() => setEditing(false)}>
          {t("common.cancel")}
        </Button>
      </div>
      <ColorSwatches
        value={tag.color}
        label={t("tags.color")}
        onChange={(color) => color && update.mutate({ id: tag.id, color })}
      />
    </li>
  );
}

/** Управление тегами на странице проекта. */
export function ProjectTags({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { t } = useT();
  const tags = useTags(projectId);
  const { create } = useTagMutations(projectId);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(SWATCHES[0]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), color }, { onSuccess: () => setName("") });
  };
  return (
    <Section title={t("tags.title")} description={t("tags.hint")}>
      <div className="grid gap-3">
        {(tags.data ?? []).length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-ink-soft">
            <TagIcon className="size-4" aria-hidden />
            {t("tags.empty")}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {(tags.data ?? []).map((tag) => (
              <TagRow key={tag.id} tag={tag} projectId={projectId} canEdit={canEdit} />
            ))}
          </ul>
        )}
        {canEdit && (
          <form className="grid gap-2" onSubmit={submit}>
            <div className="flex gap-2">
              <Input
                aria-label={t("tags.newName")}
                placeholder={t("tags.newName")}
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
                <Plus className="size-3.5" aria-hidden />
                {t("tags.create")}
              </Button>
            </div>
            <ColorSwatches
              value={color}
              onChange={(next) => next && setColor(next)}
              label={t("tags.color")}
            />
            <span className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
              {t("tags.previewLabel")}
              <TagChip tag={{ name: name.trim() || t("tags.sample"), color }} />
            </span>
          </form>
        )}
      </div>
    </Section>
  );
}
