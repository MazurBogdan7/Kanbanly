/** Редактор карточки. Вид (modal/drawer), сетка и состав полей задаются шаблоном. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  Button,
  cx,
  Drawer,
  ErrorNote,
  Field,
  Input,
  Modal,
  Select,
  SelectField,
  TextField,
  Textarea,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type { BoardConfig, CardOut, DimensionTemplate, FieldTemplate } from "@/lib/api/types";
import { SafeMarkdown } from "@/lib/markdown";

import { isConflict, keys, useCardDetail, useCreateCard, useDeleteCard } from "../boards/api";
import { CardExtras } from "./CardExtras";

interface Draft {
  title: string;
  description: string;
  column: string;
  due_date: string;
  cover_url: string;
  values: Record<string, string[]>;
  fields: Record<string, unknown>;
}

function defaultValues(config: BoardConfig): Record<string, string[]> {
  return Object.fromEntries(
    (config.dimensions ?? []).map((d) => [d.key, d.default ? [d.default] : []]),
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldTemplate;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useT();
  const common = { label: field.name };
  const text = (value as string | null | undefined) ?? "";
  switch (field.type) {
    case "long_text":
      return (
        <Field label={field.name} className="col-span-full">
          {(id) => (
            <Textarea
              id={id}
              value={text}
              onChange={(event) => onChange(event.target.value || null)}
            />
          )}
        </Field>
      );
    case "number":
    case "rating":
    case "progress":
      return (
        <TextField
          {...common}
          type="number"
          min={field.validation?.min ?? undefined}
          max={field.validation?.max ?? (field.type === "progress" ? 100 : undefined)}
          value={(value as number | null | undefined) ?? ""}
          onChange={(event) =>
            onChange(event.target.value === "" ? null : Number(event.target.value))
          }
        />
      );
    case "date":
      return (
        <TextField
          {...common}
          type="date"
          value={text}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );
    case "date_range": {
      const range = (value as { start?: string; end?: string } | null) ?? {};
      const update = (patch: Record<string, string>) => {
        const next = { ...range, ...patch };
        onChange(next.start && next.end ? next : null);
      };
      return (
        <Field label={field.name}>
          {(id) => (
            <div className="grid grid-cols-2 gap-2">
              <Input
                id={id}
                type="date"
                aria-label={`${field.name}: начало`}
                value={range.start ?? ""}
                onChange={(event) => update({ start: event.target.value })}
              />
              <Input
                type="date"
                aria-label={`${field.name}: конец`}
                value={range.end ?? ""}
                onChange={(event) => update({ end: event.target.value })}
              />
            </div>
          )}
        </Field>
      );
    }
    case "checkbox":
      return (
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(event) => onChange(event.target.checked)}
          />
          {field.name}
        </label>
      );
    case "url":
      return (
        <TextField
          {...common}
          type="url"
          placeholder="https://"
          value={text}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );
    case "attachment_link": {
      const link = (value as { name?: string; url?: string } | null) ?? {};
      return (
        <TextField
          {...common}
          type="url"
          placeholder="https://"
          value={link.url ?? ""}
          onChange={(event) =>
            onChange(event.target.value ? { name: field.name, url: event.target.value } : null)
          }
        />
      );
    }
    case "checklist": {
      const items = (value as { text: string; done?: boolean }[] | null) ?? [];
      return (
        <Field label={field.name} hint={t("card.addItem")} className="col-span-full">
          {(id) => (
            <Textarea
              id={id}
              value={items.map((item) => `${item.done ? "x " : ""}${item.text}`).join("\n")}
              onChange={(event) => {
                const lines = event.target.value.split("\n").filter(Boolean);
                onChange(
                  lines.length
                    ? lines.map((line) => ({
                        text: line.replace(/^x /, ""),
                        done: line.startsWith("x "),
                      }))
                    : null,
                );
              }}
            />
          )}
        </Field>
      );
    }
    default:
      return (
        <TextField
          {...common}
          value={text}
          maxLength={field.validation?.max_length ?? undefined}
          onChange={(event) => onChange(event.target.value || null)}
        />
      );
  }
}

function DimensionInput({
  dimension,
  value,
  onChange,
}: {
  dimension: DimensionTemplate;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  if (dimension.type === "multi_select") {
    return (
      <fieldset className="grid gap-1">
        <legend className="text-xs font-medium text-ink-soft">{dimension.name}</legend>
        <div className="flex flex-wrap gap-2">
          {dimension.values?.map((option) => (
            <label key={option.key} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={value.includes(option.key)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...value, option.key]
                      : value.filter((key) => key !== option.key),
                  )
                }
              />
              {option.name}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <SelectField
      label={dimension.name}
      value={value[0] ?? ""}
      onChange={(event) => onChange(event.target.value ? [event.target.value] : [])}
    >
      {!dimension.required && <option value="">—</option>}
      {dimension.values?.map((option) => (
        <option key={option.key} value={option.key}>
          {option.name}
        </option>
      ))}
    </SelectField>
  );
}

export function CardEditor({
  boardId,
  config,
  card,
  column,
  onClose,
  readOnly,
}: {
  boardId: string;
  config: BoardConfig;
  card: CardOut | null;
  column?: string;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const detail = useCardDetail(card?.id ?? null);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [draft, setDraft] = useState<Draft>(() => ({
    title: card?.title ?? "",
    description: card?.description ?? "",
    column: card?.column ?? column ?? config.columns[0]?.key ?? "",
    due_date: card?.due_date ?? "",
    cover_url: card?.cover_url ?? "",
    values: card ? { ...card.values } : defaultValues(config),
    fields: card
      ? { ...card.fields }
      : Object.fromEntries(
          (config.fields ?? [])
            .filter((field) => field.default != null)
            .map((field) => [field.key, field.default]),
        ),
  }));
  const version = detail.data?.version ?? card?.version;
  const create = useCreateCard(boardId);
  const removeCard = useDeleteCard(boardId);

  useEffect(() => {
    if (card) void queryClient.invalidateQueries({ queryKey: keys.card(card.id) });
  }, [card, queryClient]);

  const update = useMutation({
    mutationFn: () =>
      api.patch<CardOut>(
        `/cards/${card?.id}`,
        {
          title: draft.title,
          description: draft.description,
          column: draft.column,
          due_date: draft.due_date || null,
          cover_url: draft.cover_url || null,
          values: draft.values,
          fields: Object.fromEntries(
            Object.entries(draft.fields).map(([key, value]) => [key, value ?? null]),
          ),
        },
        { ifMatch: version },
      ),
    onSuccess: (saved) => {
      queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (cards = []) =>
        cards.map((item) => (item.id === saved.id ? saved : item)),
      );
      void queryClient.invalidateQueries({ queryKey: keys.card(saved.id) });
      onClose();
    },
    onError: (error) => {
      if (isConflict(error) && card) {
        toast.info(t("card.conflict"));
        void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
        void queryClient.invalidateQueries({ queryKey: keys.card(card.id) });
      } else {
        toast.error(error);
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) return;
    if (card) {
      update.mutate();
      return;
    }
    create.mutate({
      column: draft.column,
      title: draft.title.trim(),
      description: draft.description,
      values: draft.values,
      fields: draft.fields,
      due_date: draft.due_date || null,
      cover_url: draft.cover_url || null,
    });
    onClose();
  };

  const editor = config.layout?.editor ?? {};
  const dimensions = config.dimensions ?? [];
  const fields = config.fields ?? [];
  const defaults = [
    "title",
    "description",
    ...dimensions.map((d) => d.key),
    ...fields.map((f) => f.key),
    "status",
    "due_date",
    ...(config.layout?.card?.face?.includes("cover") ? ["cover_url"] : []),
  ];
  const order = editor.fields?.length ? editor.fields : defaults;
  const fullWidth: ReactNode[] = [];
  const grid: ReactNode[] = [];
  for (const key of order) {
    if (key === "title") {
      fullWidth.push(
        <TextField
          key={key}
          label={t("card.title")}
          required
          autoFocus
          maxLength={500}
          disabled={readOnly}
          value={draft.title}
          onChange={(event) => setDraft({ ...draft, title: event.target.value })}
        />,
      );
    } else if (key === "description") {
      fullWidth.push(
        <Field key={key} label={t("card.description")} hint={t("card.markdownHint")}>
          {(id, describedBy) => (
            <div className="grid gap-1">
              <div className="flex gap-1" role="group" aria-label={t("card.description")}>
                {(["edit", "preview"] as const).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={tab === mode ? "secondary" : "ghost"}
                    aria-pressed={tab === mode}
                    onClick={() => setTab(mode)}
                  >
                    {t(mode === "edit" ? "card.edit" : "card.preview")}
                  </Button>
                ))}
              </div>
              {tab === "edit" ? (
                <Textarea
                  id={id}
                  aria-describedby={describedBy}
                  maxLength={20000}
                  disabled={readOnly}
                  value={draft.description}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              ) : (
                <SafeMarkdown
                  source={draft.description}
                  className="prose-card min-h-24 rounded-sm border border-line p-2 text-sm"
                />
              )}
            </div>
          )}
        </Field>,
      );
    } else if (key === "status") {
      grid.push(
        <Field key={key} label={t("card.status")}>
          {(id) => (
            <Select
              id={id}
              value={draft.column}
              disabled={readOnly}
              onChange={(event) => setDraft({ ...draft, column: event.target.value })}
            >
              {config.columns.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.name}
                </option>
              ))}
            </Select>
          )}
        </Field>,
      );
    } else if (key === "due_date") {
      grid.push(
        <TextField
          key={key}
          label={t("card.dueDate")}
          type="date"
          disabled={readOnly}
          value={draft.due_date}
          onChange={(event) => setDraft({ ...draft, due_date: event.target.value })}
        />,
      );
    } else if (key === "cover_url") {
      grid.push(
        <TextField
          key={key}
          label={t("card.cover")}
          type="url"
          placeholder="https://"
          disabled={readOnly}
          value={draft.cover_url}
          onChange={(event) => setDraft({ ...draft, cover_url: event.target.value })}
        />,
      );
    } else {
      const dimension = dimensions.find((item) => item.key === key);
      const field = fields.find((item) => item.key === key);
      if (dimension) {
        grid.push(
          <DimensionInput
            key={key}
            dimension={dimension}
            value={draft.values[key] ?? []}
            onChange={(value) => setDraft({ ...draft, values: { ...draft.values, [key]: value } })}
          />,
        );
      } else if (field) {
        grid.push(
          <FieldInput
            key={key}
            field={field}
            value={draft.fields[key]}
            onChange={(value) => setDraft({ ...draft, fields: { ...draft.fields, [key]: value } })}
          />,
        );
      }
    }
  }

  const problem =
    update.error instanceof ApiError && !isConflict(update.error) ? update.error.message : null;
  const body = (
    <div className="grid gap-5">
      <form className="grid gap-3" onSubmit={submit} data-testid="card-form">
        {fullWidth}
        <div
          className={cx(
            "grid gap-3",
            (editor.fields_grid ?? 1) === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1",
          )}
        >
          {grid}
        </div>
        {problem && <ErrorNote message={problem} />}
        {!readOnly && (
          <div className="flex items-center justify-between gap-2">
            {card ? (
              <Button
                variant="danger"
                onClick={() => {
                  removeCard(card);
                  onClose();
                }}
              >
                {t("common.delete")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button onClick={onClose}>{t("common.cancel")}</Button>
              <Button type="submit" variant="primary" loading={update.isPending}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        )}
      </form>
      {card && detail.data && (
        <CardExtras boardId={boardId} card={detail.data} readOnly={readOnly} />
      )}
    </div>
  );
  const title = card ? card.title : t("card.new");
  const openChange = (open: boolean) => !open && onClose();
  return editor.type === "modal" ? (
    <Modal open onOpenChange={openChange} title={title}>
      {body}
    </Modal>
  ) : (
    <Drawer open onOpenChange={openChange} title={title}>
      {body}
    </Drawer>
  );
}
