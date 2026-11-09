/** Вкладки «Колонки», «Измерения», «Поля», «Правила». */
import { Plus } from "lucide-react";

import { Button, SelectField, TextField, Toggle } from "@/components/ui";
import { useT, type MessageKey } from "@/i18n";
import type {
  BoardConfig,
  ColumnKind,
  ColumnTemplate,
  DimensionRole,
  DimensionTemplate,
  DimensionValueTemplate,
  FieldTemplate,
  FieldType,
  Rule,
  ViewTemplate,
} from "@/lib/api/types";

import { ALL_ROLES, removeDimension, removeField, rolesOf, setRole } from "./config-ops";
import {
  Collapsible,
  ColorField,
  newKey,
  NumberField,
  RemoveButton,
  SortableList,
} from "./controls";
import { overflowSettings } from "../boards/engine/model";
import { useDraft } from "./draft";

const COLUMN_KINDS: ColumnKind[] = ["backlog", "todo", "in_progress", "review", "done", "custom"];
const HEADER_STYLES = ["flat-with-divider", "pill", "color-bar"] as const;
const ACCENT_STYLES = [
  "left-border",
  "top-border",
  "background-tint",
  "dot",
  "full-border",
] as const;
const DIMENSION_TYPES = ["select", "multi_select", "ordered_select", "user"] as const;
const FIELD_TYPES: FieldType[] = [
  "text",
  "long_text",
  "number",
  "date",
  "date_range",
  "checkbox",
  "url",
  "rating",
  "progress",
  "checklist",
  "attachment_link",
];
const ROLE_LABELS: Record<DimensionRole, MessageKey> = {
  accent: "role.accent",
  badge: "role.badge",
  filter_select: "role.filter_select",
  filter_chips: "role.filter_chips",
  progress: "role.progress",
  swimlanes: "role.swimlanes",
  table_group: "role.table_group",
  legend: "role.legend",
};

function useChange() {
  return useDraft((state) => state.change);
}

function ColumnEditor({ column, config }: { column: ColumnTemplate; config: BoardConfig }) {
  const { t } = useT();
  const change = useChange();
  const update = (patch: Partial<ColumnTemplate>) =>
    change((draft) => {
      const target = draft.columns.find((item) => item.key === column.key);
      if (target) Object.assign(target, patch);
    });
  const style = (patch: NonNullable<ColumnTemplate["card_style"]>) =>
    update({ card_style: { ...column.card_style, ...patch } });
  return (
    <div className="grid gap-2">
      <div className="flex items-end gap-2">
        <TextField
          className="flex-1"
          label={t("common.name")}
          value={column.name}
          onChange={(event) => update({ name: event.target.value })}
        />
        {config.columns.length > 1 && (
          <RemoveButton
            label={`${t("common.delete")}: ${column.name}`}
            onClick={() =>
              change((draft) => {
                draft.columns = draft.columns.filter((item) => item.key !== column.key);
              })
            }
          />
        )}
      </div>
      <SelectField
        label={t("ctor.kind")}
        value={column.kind ?? "custom"}
        onChange={(event) => update({ kind: event.target.value as ColumnKind })}
      >
        {COLUMN_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kind}
          </option>
        ))}
      </SelectField>
      <Collapsible title={t("ctor.advanced")}>
        <ColorField
          label={t("ctor.color")}
          config={config}
          allowEmpty
          value={column.color}
          onChange={(color) => update({ color })}
        />
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label={t("ctor.icon")}
            maxLength={8}
            value={column.icon ?? ""}
            onChange={(event) => update({ icon: event.target.value || null })}
          />
          <NumberField
            label={t("ctor.wipLimit")}
            min={1}
            max={999}
            value={column.wip_limit}
            onChange={(wip_limit) => update({ wip_limit })}
          />
          <NumberField
            label={t("ctor.width")}
            min={120}
            max={800}
            value={column.width}
            onChange={(width) => update({ width })}
          />
          <SelectField
            label={t("ctor.headerStyle")}
            value={column.header_style ?? ""}
            onChange={(event) =>
              update({
                header_style: (event.target.value || null) as ColumnTemplate["header_style"],
              })
            }
          >
            <option value="">—</option>
            {HEADER_STYLES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </SelectField>
        </div>
        <TextField
          label={t("ctor.emptyText")}
          value={column.empty_text ?? ""}
          onChange={(event) => update({ empty_text: event.target.value || null })}
        />
        <Toggle
          label={t("ctor.collapsed")}
          checked={column.collapsed ?? false}
          onChange={(collapsed) => update({ collapsed })}
        />
        <NumberField
          label={t("ctor.opacity")}
          min={0.1}
          max={1}
          step={0.05}
          value={column.card_style?.opacity}
          onChange={(opacity) => style({ opacity })}
        />
        <Toggle
          label={t("ctor.strike")}
          checked={column.card_style?.title_strikethrough ?? false}
          onChange={(title_strikethrough) => style({ title_strikethrough })}
        />
        {column.card_style?.title_strikethrough && (
          <ColorField
            label={t("ctor.strikeColor")}
            config={config}
            allowEmpty
            value={column.card_style.strikethrough_color}
            onChange={(strikethrough_color) => style({ strikethrough_color })}
          />
        )}
        <Toggle
          label={t("ctor.muteBadges")}
          checked={column.card_style?.mute_badges ?? false}
          onChange={(mute_badges) => style({ mute_badges })}
        />
        <SelectField
          label={t("ctor.accentOverride")}
          value={column.card_style?.accent_style ?? ""}
          onChange={(event) =>
            style({
              accent_style: (event.target.value || null) as NonNullable<
                ColumnTemplate["card_style"]
              >["accent_style"],
            })
          }
        >
          <option value="">—</option>
          {ACCENT_STYLES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </SelectField>
      </Collapsible>
    </div>
  );
}

export function ColumnsTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useChange();
  const layout = config.layout?.column ?? {};
  const common = (patch: Partial<typeof layout>) =>
    change((draft) => {
      draft.layout ??= {};
      draft.layout.column = { ...draft.layout.column, ...patch };
    });
  const overflow = overflowSettings(config);
  const setOverflow = (patch: Partial<typeof overflow>) =>
    common({ overflow: { ...overflow, ...patch } });
  return (
    <div className="grid gap-3">
      <p className="text-xs text-ink-soft">{t("ctor.dropColumnWarning")}</p>
      <SortableList
        items={config.columns}
        getKey={(item) => item.key}
        getLabel={(item) => item.name}
        onReorder={(columns) =>
          change((draft) => {
            draft.columns = columns;
          })
        }
      >
        {(column) => <ColumnEditor column={column} config={config} />}
      </SortableList>
      <Button
        onClick={() =>
          change((draft) => {
            draft.columns.push({ key: newKey("col"), name: t("ctor.newColumn"), kind: "custom" });
          })
        }
      >
        <Plus className="size-3.5" aria-hidden />
        {t("ctor.addColumn")}
      </Button>
      <Collapsible title={t("ctor.columnsCommon")}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("ctor.minWidth")}
            min={120}
            max={800}
            value={layout.min_width ?? 280}
            onChange={(min_width) => min_width && common({ min_width })}
          />
          <NumberField
            label={t("ctor.radius")}
            min={0}
            max={32}
            value={layout.radius ?? 10}
            onChange={(radius) => common({ radius: radius ?? 0 })}
          />
        </div>
        <SelectField
          label={t("ctor.headerStyle")}
          value={layout.header_style ?? "flat-with-divider"}
          onChange={(event) =>
            common({ header_style: event.target.value as (typeof HEADER_STYLES)[number] })
          }
        >
          {HEADER_STYLES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t("ctor.emptyText")}
          value={layout.empty_text ?? ""}
          onChange={(event) => common({ empty_text: event.target.value })}
        />
        <Toggle
          label={t("ctor.showCount")}
          checked={layout.show_count !== false}
          onChange={(show_count) => common({ show_count })}
        />
        <Toggle
          label={t("ctor.showWip")}
          checked={layout.show_wip !== false}
          onChange={(show_wip) => common({ show_wip })}
        />
        <Toggle
          label={t("ctor.collapsible")}
          checked={layout.collapsible ?? false}
          onChange={(collapsible) => common({ collapsible })}
        />
      </Collapsible>
      <Collapsible title={t("ctor.overflow")}>
        <p className="text-xs text-ink-soft">{t("ctor.overflowHint")}</p>
        <Toggle
          label={t("ctor.overflowEnabled")}
          checked={overflow.enabled}
          onChange={(enabled) => setOverflow({ enabled })}
        />
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("ctor.overflowThreshold")}
            min={2}
            max={1000}
            value={overflow.threshold}
            onChange={(threshold) => threshold && setOverflow({ threshold })}
          />
          <NumberField
            label={t("ctor.overflowVisible")}
            min={0}
            max={100}
            value={overflow.visible}
            onChange={(visible) => setOverflow({ visible: visible ?? 0 })}
          />
        </div>
        <SelectField
          label={t("ctor.overflowBy")}
          value={overflow.by}
          onChange={(event) => setOverflow({ by: event.target.value })}
        >
          <option value="auto">{t("ctor.overflowAuto")}</option>
          <option value="tags">{t("ctor.overflowTags")}</option>
          {(config.dimensions ?? []).map((dimension) => (
            <option key={dimension.key} value={`dimension:${dimension.key}`}>
              {dimension.name}
            </option>
          ))}
        </SelectField>
      </Collapsible>
    </div>
  );
}

function ValueEditor({
  value,
  dimension,
  config,
}: {
  value: DimensionValueTemplate;
  dimension: DimensionTemplate;
  config: BoardConfig;
}) {
  const { t } = useT();
  const change = useChange();
  const edit = (update: (target: DimensionValueTemplate) => void) =>
    change((draft) => {
      const owner = draft.dimensions?.find((item) => item.key === dimension.key);
      const target = owner?.values?.find((item) => item.key === value.key);
      if (target) update(target);
    });
  return (
    <div className="grid gap-2">
      <div className="flex items-end gap-2">
        <TextField
          className="flex-1"
          label={t("common.name")}
          value={value.name}
          onChange={(event) => edit((target) => (target.name = event.target.value))}
        />
        <RemoveButton
          label={`${t("common.delete")}: ${value.name}`}
          onClick={() =>
            change((draft) => {
              const owner = draft.dimensions?.find((item) => item.key === dimension.key);
              if (!owner) return;
              owner.values = owner.values?.filter((item) => item.key !== value.key);
              if (owner.default === value.key) owner.default = null;
              if (owner.empty_value === value.key) owner.empty_value = null;
            })
          }
        />
      </div>
      <ColorField
        label={t("ctor.color")}
        config={config}
        allowEmpty
        value={value.color}
        onChange={(color) => edit((target) => (target.color = color))}
      />
      <Collapsible title={t("ctor.advanced")}>
        <div className="grid grid-cols-2 gap-2">
          <TextField
            label={t("ctor.short")}
            maxLength={32}
            value={value.short ?? ""}
            onChange={(event) => edit((target) => (target.short = event.target.value || null))}
          />
          <TextField
            label={t("ctor.icon")}
            maxLength={8}
            value={value.icon ?? ""}
            onChange={(event) => edit((target) => (target.icon = event.target.value || null))}
          />
        </div>
        <TextField
          label={t("ctor.hint")}
          value={value.hint ?? ""}
          onChange={(event) => edit((target) => (target.hint = event.target.value || null))}
        />
        {(["bg", "fg", "border"] as const).map((part) => (
          <ColorField
            key={part}
            label={t(
              part === "bg" ? "ctor.badgeBg" : part === "fg" ? "ctor.badgeFg" : "ctor.badgeBorder",
            )}
            config={config}
            allowEmpty
            value={value.badge?.[part]}
            onChange={(color) =>
              edit((target) => {
                target.badge = { ...target.badge, [part]: color };
              })
            }
          />
        ))}
      </Collapsible>
    </div>
  );
}

function DimensionEditor({
  dimension,
  config,
}: {
  dimension: DimensionTemplate;
  config: BoardConfig;
}) {
  const { t } = useT();
  const change = useChange();
  const update = (patch: Partial<DimensionTemplate>) =>
    change((draft) => {
      const target = draft.dimensions?.find((item) => item.key === dimension.key);
      if (target) Object.assign(target, patch);
    });
  const roles = rolesOf(config, dimension.key);
  const values = dimension.values ?? [];
  return (
    <div className="grid gap-2">
      <div className="flex items-end gap-2">
        <TextField
          className="flex-1"
          label={t("common.name")}
          value={dimension.name}
          onChange={(event) => update({ name: event.target.value })}
        />
        <RemoveButton
          label={`${t("common.delete")}: ${dimension.name}`}
          onClick={() => change((draft) => removeDimension(draft, dimension.key))}
        />
      </div>
      <SelectField
        label={t("ctor.dimType")}
        value={dimension.type ?? "select"}
        onChange={(event) =>
          update({ type: event.target.value as (typeof DIMENSION_TYPES)[number] })
        }
      >
        {DIMENSION_TYPES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </SelectField>
      <fieldset className="grid gap-1">
        <legend className="text-xs font-medium text-ink-soft">{t("ctor.roles")}</legend>
        <div className="grid grid-cols-2 gap-1">
          {ALL_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                data-role={role}
                checked={roles.includes(role)}
                onChange={(event) =>
                  change((draft) => setRole(draft, dimension.key, role, event.target.checked))
                }
              />
              {t(ROLE_LABELS[role])}
            </label>
          ))}
        </div>
      </fieldset>
      <Collapsible title={`${t("ctor.values")}: ${values.length}`}>
        <SortableList
          items={values}
          getKey={(item) => item.key}
          getLabel={(item) => item.name}
          onReorder={(next) => update({ values: next })}
        >
          {(value) => <ValueEditor value={value} dimension={dimension} config={config} />}
        </SortableList>
        <Button
          size="sm"
          onClick={() =>
            update({ values: [...values, { key: newKey("v"), name: t("ctor.newValue") }] })
          }
        >
          {t("ctor.addValue")}
        </Button>
      </Collapsible>
      <Collapsible title={t("ctor.advanced")}>
        <Toggle
          label={t("ctor.required")}
          checked={dimension.required ?? false}
          onChange={(required) => update({ required })}
        />
        <SelectField
          label={t("ctor.default")}
          value={dimension.default ?? ""}
          onChange={(event) => update({ default: event.target.value || null })}
        >
          <option value="">—</option>
          {values.map((value) => (
            <option key={value.key} value={value.key}>
              {value.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t("ctor.emptyValue")}
          value={dimension.empty_value ?? ""}
          onChange={(event) => update({ empty_value: event.target.value || null })}
        >
          <option value="">—</option>
          {values.map((value) => (
            <option key={value.key} value={value.key}>
              {value.name}
            </option>
          ))}
        </SelectField>
        <Toggle
          label={t("ctor.hideEmpty")}
          checked={dimension.hide_empty ?? false}
          onChange={(hide_empty) => update({ hide_empty })}
        />
      </Collapsible>
    </div>
  );
}

export function DimensionsTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useChange();
  const dimensions = config.dimensions ?? [];
  return (
    <div className="grid gap-3">
      <SortableList
        items={dimensions}
        getKey={(item) => item.key}
        getLabel={(item) => item.name}
        onReorder={(next) =>
          change((draft) => {
            draft.dimensions = next;
          })
        }
      >
        {(dimension) => <DimensionEditor dimension={dimension} config={config} />}
      </SortableList>
      <Button
        onClick={() =>
          change((draft) => {
            draft.dimensions = [
              ...(draft.dimensions ?? []),
              {
                key: newKey("dim"),
                name: t("ctor.newDimension"),
                type: "select",
                values: [{ key: newKey("v"), name: t("ctor.value") }],
              },
            ];
          })
        }
      >
        <Plus className="size-3.5" aria-hidden />
        {t("ctor.addDimension")}
      </Button>
    </div>
  );
}

function FieldEditor({ field }: { field: FieldTemplate }) {
  const { t } = useT();
  const change = useChange();
  const update = (patch: Partial<FieldTemplate>) =>
    change((draft) => {
      const target = draft.fields?.find((item) => item.key === field.key);
      if (target) Object.assign(target, patch);
    });
  const validation = (patch: NonNullable<FieldTemplate["validation"]>) =>
    update({ validation: { ...field.validation, ...patch } });
  return (
    <div className="grid gap-2">
      <div className="flex items-end gap-2">
        <TextField
          className="flex-1"
          label={t("common.name")}
          value={field.name}
          onChange={(event) => update({ name: event.target.value })}
        />
        <RemoveButton
          label={`${t("common.delete")}: ${field.name}`}
          onClick={() => change((draft) => removeField(draft, field.key))}
        />
      </div>
      <SelectField
        label={t("ctor.fieldType")}
        value={field.type}
        onChange={(event) => update({ type: event.target.value as FieldType, default: null })}
      >
        {FIELD_TYPES.map((item) => (
          <option key={item} value={item}>
            {item}
          </option>
        ))}
      </SelectField>
      <Toggle
        label={t("ctor.onFace")}
        checked={field.show_on_face ?? false}
        onChange={(show_on_face) => update({ show_on_face })}
      />
      <Toggle
        label={t("ctor.required")}
        checked={field.required ?? false}
        onChange={(required) => update({ required })}
      />
      <Collapsible title={t("ctor.advanced")}>
        {["text", "long_text", "number", "date", "url"].includes(field.type) && (
          <TextField
            label={t("ctor.defaultValue")}
            type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
            value={field.default == null ? "" : String(field.default)}
            onChange={(event) => {
              const raw = event.target.value;
              update({ default: raw === "" ? null : field.type === "number" ? Number(raw) : raw });
            }}
          />
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("ctor.min")}
            value={field.validation?.min}
            onChange={(min) => validation({ min })}
          />
          <NumberField
            label={t("ctor.max")}
            value={field.validation?.max}
            onChange={(max) => validation({ max })}
          />
        </div>
        <TextField
          label={t("ctor.regex")}
          maxLength={200}
          value={field.validation?.regex ?? ""}
          onChange={(event) => validation({ regex: event.target.value || null })}
        />
        <TextField
          label={t("ctor.format")}
          maxLength={32}
          value={field.format ?? ""}
          onChange={(event) => update({ format: event.target.value || null })}
        />
      </Collapsible>
    </div>
  );
}

export function FieldsTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useChange();
  const fields = config.fields ?? [];
  return (
    <div className="grid gap-3">
      <SortableList
        items={fields}
        getKey={(item) => item.key}
        getLabel={(item) => item.name}
        onReorder={(next) =>
          change((draft) => {
            draft.fields = next;
          })
        }
      >
        {(field) => <FieldEditor field={field} />}
      </SortableList>
      <Button
        onClick={() =>
          change((draft) => {
            draft.fields = [
              ...(draft.fields ?? []),
              { key: newKey("fld"), name: t("ctor.newField"), type: "text" },
            ];
          })
        }
      >
        <Plus className="size-3.5" aria-hidden />
        {t("ctor.addField")}
      </Button>
    </div>
  );
}

const RULE_TYPES: { type: Rule["type"]; label: MessageKey }[] = [
  { type: "set_completed_on_kind", label: "rule.completed" },
  { type: "highlight_wip_exceeded", label: "rule.wip" },
  { type: "warn_missing_required", label: "rule.required" },
];

function ViewsEditor({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useChange();
  const views = config.views ?? [];
  const update = (key: string, patch: Partial<ViewTemplate>) =>
    change((draft) => {
      draft.views = draft.views?.map((view) => {
        if (view.key === key) return { ...view, ...patch };
        return patch.is_default ? { ...view, is_default: false } : view;
      });
    });
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium text-ink-soft">{t("ctor.views")}</h3>
      <SortableList
        items={views}
        getKey={(item) => item.key}
        getLabel={(item) => item.name}
        onReorder={(next) =>
          change((draft) => {
            draft.views = next;
          })
        }
      >
        {(view) => (
          <div className="grid gap-2">
            <div className="flex items-end gap-2">
              <TextField
                className="flex-1"
                label={t("common.name")}
                value={view.name}
                onChange={(event) => update(view.key, { name: event.target.value })}
              />
              <RemoveButton
                label={`${t("common.delete")}: ${view.name}`}
                onClick={() =>
                  change((draft) => {
                    draft.views = draft.views?.filter((item) => item.key !== view.key);
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <SelectField
                label={t("ctor.viewType")}
                value={view.type ?? "kanban"}
                onChange={(event) =>
                  update(view.key, { type: event.target.value as ViewTemplate["type"] })
                }
              >
                {["kanban", "table", "calendar", "timeline"].map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </SelectField>
              <SelectField
                label={t("ctor.groupBy")}
                value={view.group_by ?? ""}
                onChange={(event) => update(view.key, { group_by: event.target.value || null })}
              >
                <option value="">—</option>
                {config.dimensions?.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <Toggle
              label={t("ctor.isDefault")}
              checked={view.is_default ?? false}
              onChange={(is_default) => update(view.key, { is_default })}
            />
          </div>
        )}
      </SortableList>
      <Button
        size="sm"
        onClick={() =>
          change((draft) => {
            draft.views = [
              ...(draft.views ?? []),
              { key: newKey("view"), name: t("ctor.newView"), type: "table" },
            ];
          })
        }
      >
        {t("ctor.addView")}
      </Button>
    </section>
  );
}

export function RulesTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useChange();
  const rules = config.rules ?? [];
  return (
    <div className="grid gap-3">
      {RULE_TYPES.map(({ type, label: labelKey }) => {
        const label = t(labelKey);
        const rule = rules.find((item) => item.type === type);
        return (
          <div key={type} className="grid gap-2 rounded-md border border-line p-3">
            <Toggle
              label={label}
              checked={!!rule && rule.enabled !== false}
              onChange={(on) =>
                change((draft) => {
                  const list = draft.rules ?? [];
                  const existing = list.find((item) => item.type === type);
                  if (existing) existing.enabled = on;
                  else if (on) list.push({ key: newKey("rule"), type } as Rule);
                  draft.rules = list;
                })
              }
            />
            {rule?.type === "set_completed_on_kind" && (
              <SelectField
                label={t("ctor.kind")}
                value={rule.column_kind ?? "done"}
                onChange={(event) =>
                  change((draft) => {
                    const target = draft.rules?.find((item) => item.type === type);
                    if (target?.type === "set_completed_on_kind") {
                      target.column_kind = event.target.value as ColumnKind;
                    }
                  })
                }
              >
                {COLUMN_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
        );
      })}
      <ViewsEditor config={config} />
    </div>
  );
}
