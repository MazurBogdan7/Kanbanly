/** Вкладки «Карточка», «Шапка», «Тема», «Типографика». */
import { AlertTriangle, CheckCircle2, Plus } from "lucide-react";
import { useState } from "react";

import { Button, cx, SelectField, TextField, Toggle } from "@/components/ui";
import { FONT_NAMES, fontStack } from "@/design-system/fonts";
import { useT } from "@/i18n";
import type {
  Background,
  BadgeConfig,
  BoardConfig,
  CardLayout,
  FaceSlot,
  Theme,
  TypeRole,
  Widget,
} from "@/lib/api/types";

import { BASE_TOKEN_NAMES, TYPE_ROLES, type RoleName } from "../boards/engine/theme";
import { normalizedWidgets } from "../boards/engine/HeaderWidgets";
import { applyDensity, contrastReport, DENSITY_PRESETS, PALETTES } from "./config-ops";
import { Collapsible, ColorField, NumberField, RemoveButton, SortableList } from "./controls";
import { useDraft } from "./draft";

const FACE_SLOTS: FaceSlot[] = [
  "title",
  "description",
  "badges",
  "fields",
  "cover",
  "assignees",
  "due_date",
  "checklist_progress",
  "comments_count",
  "custom_text",
];
const SLOT_LABELS: Record<FaceSlot, string> = {
  title: "Заголовок",
  description: "Описание",
  badges: "Бейджи",
  fields: "Поля",
  cover: "Обложка",
  assignees: "Исполнители",
  due_date: "Срок",
  checklist_progress: "Прогресс чек-листа",
  comments_count: "Счётчик комментариев",
  custom_text: "Свой текст",
};
const ACCENT_STYLES = [
  "left-border",
  "top-border",
  "background-tint",
  "dot",
  "full-border",
] as const;
const BADGE_DISPLAY = ["name", "short", "icon", "icon+name"] as const;
const BADGE_STYLES = ["per-value", "neutral", "outlined", "filled", "dot"] as const;
const WEIGHTS = [300, 400, 500, 600, 700, 800];
const CASES = ["as_is", "upper", "lower", "capitalize"] as const;
const ROLE_NAMES: Record<RoleName, string> = {
  board_title: "Заголовок доски",
  board_subtitle: "Подзаголовок",
  column_title: "Заголовок колонки",
  card_title: "Заголовок карточки",
  card_body: "Текст карточки",
  badge: "Бейдж",
  base: "Базовый текст",
};
const WIDGET_LABELS: Record<Widget["type"], string> = {
  title: "Заголовок",
  actions: "Панель действий",
  progress_by_dimension: "Прогресс по измерению",
  filter_bar: "Панель фильтров",
  filter_chips: "Чипы-фильтры",
  stats: "Счётчики",
  note: "Заметка",
  legend: "Легенда",
};

function useCardChange() {
  const change = useDraft((state) => state.change);
  return (update: (card: CardLayout) => void) =>
    change((draft) => {
      draft.layout ??= {};
      draft.layout.card ??= {};
      update(draft.layout.card);
    });
}

function BadgeEditor({
  badge,
  config,
  index,
}: {
  badge: BadgeConfig;
  config: BoardConfig;
  index: number;
}) {
  const { t } = useT();
  const changeCard = useCardChange();
  const update = (patch: Partial<BadgeConfig>) =>
    changeCard((card) => {
      const target = card.badges?.[index];
      if (target) Object.assign(target, patch);
    });
  return (
    <div className="grid gap-2">
      <div className="flex items-end gap-2">
        <SelectField
          className="flex-1"
          label={t("ctor.badgeDimension")}
          value={badge.dimension}
          onChange={(event) => update({ dimension: event.target.value })}
        >
          {config.dimensions?.map((item) => (
            <option key={item.key} value={item.key}>
              {item.name}
            </option>
          ))}
        </SelectField>
        <RemoveButton
          label={t("common.remove")}
          onClick={() => changeCard((card) => void card.badges?.splice(index, 1))}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label={t("ctor.badgeDisplay")}
          value={badge.display ?? "name"}
          onChange={(event) => update({ display: event.target.value as BadgeConfig["display"] })}
        >
          {BADGE_DISPLAY.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t("ctor.badgeStyle")}
          value={badge.style ?? "neutral"}
          onChange={(event) => update({ style: event.target.value as BadgeConfig["style"] })}
        >
          {BADGE_STYLES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t("ctor.badgeSize")}
          value={badge.size ?? "sm"}
          onChange={(event) => update({ size: event.target.value as BadgeConfig["size"] })}
        >
          <option value="sm">sm</option>
          <option value="md">md</option>
        </SelectField>
        <NumberField
          label={t("ctor.badgeRadius")}
          min={0}
          max={999}
          value={badge.radius}
          onChange={(radius) => update({ radius })}
        />
      </div>
      <TextField
        label={t("ctor.hideValues")}
        value={(badge.hide_values ?? []).join(", ")}
        onChange={(event) =>
          update({
            hide_values: event.target.value
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          })
        }
      />
    </div>
  );
}

function EditorFields({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useDraft((state) => state.change);
  const options = [
    { key: "title", name: t("card.title") },
    { key: "description", name: t("card.description") },
    ...(config.dimensions ?? []).map((item) => ({ key: item.key, name: item.name })),
    ...(config.fields ?? []).map((item) => ({ key: item.key, name: item.name })),
    { key: "status", name: t("card.status") },
    { key: "due_date", name: t("card.dueDate") },
    { key: "cover_url", name: t("card.cover") },
  ];
  const label = (key: string) => options.find((item) => item.key === key)?.name ?? key;
  const chosen = config.layout?.editor?.fields?.length
    ? config.layout.editor.fields
    : options.filter((item) => item.key !== "cover_url").map((item) => item.key);
  const set = (fields: string[]) =>
    change((draft) => {
      draft.layout ??= {};
      draft.layout.editor = { ...draft.layout.editor, fields };
    });
  return (
    <div className="grid gap-2">
      <p className="text-xs font-medium text-ink-soft">{t("ctor.editorFields")}</p>
      <SortableList items={chosen} getKey={(item) => item} getLabel={label} onReorder={set}>
        {(key) => (
          <div className="flex items-center justify-between text-sm">
            {label(key)}
            {key !== "title" && (
              <RemoveButton
                label={`${t("common.remove")}: ${label(key)}`}
                onClick={() => set(chosen.filter((item) => item !== key))}
              />
            )}
          </div>
        )}
      </SortableList>
      <div className="flex flex-wrap gap-1">
        {options
          .filter((item) => !chosen.includes(item.key))
          .map((item) => (
            <Button key={item.key} size="sm" onClick={() => set([...chosen, item.key])}>
              + {item.name}
            </Button>
          ))}
      </div>
    </div>
  );
}

export function CardTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const changeCard = useCardChange();
  const change = useDraft((state) => state.change);
  const card = config.layout?.card ?? {};
  const face = card.face ?? ["title", "description", "badges"];
  const accent = card.accent ?? {};
  const editor = config.layout?.editor ?? {};
  const inactive = FACE_SLOTS.filter((slot) => !face.includes(slot));
  const sources = [
    { value: "none", label: "—" },
    { value: "column", label: "Колонка" },
    ...(config.dimensions ?? []).map((item) => ({
      value: `dimension:${item.key}`,
      label: `Измерение: ${item.name}`,
    })),
    ...(config.fields ?? []).map((item) => ({
      value: `field:${item.key}`,
      label: `Поле: ${item.name}`,
    })),
  ];
  const padding = card.padding ?? [10, 12];
  return (
    <div className="grid gap-4">
      <Collapsible title={t("ctor.faceSlots")} open>
        <SortableList
          items={face}
          getKey={(item) => item}
          getLabel={(item) => SLOT_LABELS[item]}
          onReorder={(next) => changeCard((target) => (target.face = next))}
        >
          {(slot) => (
            <div className="flex items-center justify-between text-sm">
              {SLOT_LABELS[slot]}
              <RemoveButton
                label={`${t("common.remove")}: ${SLOT_LABELS[slot]}`}
                onClick={() =>
                  changeCard((target) => {
                    target.face = face.filter((item) => item !== slot);
                  })
                }
              />
            </div>
          )}
        </SortableList>
        {inactive.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {inactive.map((slot) => (
              <Button
                key={slot}
                size="sm"
                onClick={() => changeCard((target) => (target.face = [...face, slot]))}
              >
                + {SLOT_LABELS[slot]}
              </Button>
            ))}
          </div>
        )}
        {face.includes("custom_text") && (
          <TextField
            label={t("ctor.customText")}
            value={card.custom_text ?? ""}
            onChange={(event) => changeCard((target) => (target.custom_text = event.target.value))}
          />
        )}
      </Collapsible>
      <Collapsible title={t("ctor.accent")} open>
        <SelectField
          label={t("ctor.accentSource")}
          value={accent.source ?? "none"}
          onChange={(event) =>
            changeCard((target) => {
              target.accent = { ...target.accent, source: event.target.value };
            })
          }
        >
          {sources.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            label={t("ctor.accentStyle")}
            value={accent.style ?? "left-border"}
            onChange={(event) =>
              changeCard((target) => {
                target.accent = {
                  ...target.accent,
                  style: event.target.value as (typeof ACCENT_STYLES)[number],
                };
              })
            }
          >
            {ACCENT_STYLES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </SelectField>
          <NumberField
            label={t("ctor.accentWidth")}
            min={1}
            max={12}
            value={accent.width ?? 3}
            onChange={(width) =>
              width &&
              changeCard((target) => {
                target.accent = { ...target.accent, width };
              })
            }
          />
        </div>
      </Collapsible>
      <Collapsible title={t("ctor.badges")} open>
        {(card.badges ?? []).map((badge, index) => (
          <div key={`${badge.dimension}-${index}`} className="rounded-md border border-line p-2">
            <BadgeEditor badge={badge} config={config} index={index} />
          </div>
        ))}
        {(config.dimensions?.length ?? 0) > 0 && (
          <Button
            size="sm"
            onClick={() =>
              changeCard((target) => {
                target.badges = [
                  ...(target.badges ?? []),
                  { dimension: config.dimensions?.[0]?.key ?? "" },
                ];
              })
            }
          >
            {t("ctor.addBadge")}
          </Button>
        )}
      </Collapsible>
      <Collapsible title={t("ctor.geometry")}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t("ctor.radius")}
            min={0}
            max={32}
            value={card.radius ?? 8}
            onChange={(radius) => changeCard((target) => (target.radius = radius ?? 0))}
          />
          <NumberField
            label={t("ctor.gap")}
            min={0}
            max={48}
            value={card.gap ?? 8}
            onChange={(gap) => changeCard((target) => (target.gap = gap ?? 0))}
          />
          <NumberField
            label={t("ctor.paddingV")}
            min={0}
            max={48}
            value={padding[0]}
            onChange={(value) =>
              changeCard((target) => (target.padding = [value ?? 0, padding[1] ?? 0]))
            }
          />
          <NumberField
            label={t("ctor.paddingH")}
            min={0}
            max={48}
            value={padding[1]}
            onChange={(value) =>
              changeCard((target) => (target.padding = [padding[0] ?? 0, value ?? 0]))
            }
          />
        </div>
        <SelectField
          label={t("ctor.shadow")}
          value={card.shadow ?? "none"}
          onChange={(event) =>
            changeCard((target) => (target.shadow = event.target.value as CardLayout["shadow"]))
          }
        >
          {["none", "sm", "md"].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </SelectField>
        <SelectField
          label={t("ctor.hover")}
          value={card.hover ?? "border"}
          onChange={(event) =>
            changeCard((target) => (target.hover = event.target.value as CardLayout["hover"]))
          }
        >
          {["none", "border", "lift", "glow"].map((item) => (
            <option key={item}>{item}</option>
          ))}
        </SelectField>
        <Toggle
          label={t("ctor.border")}
          checked={card.border !== false}
          onChange={(border) => changeCard((target) => (target.border = border))}
        />
      </Collapsible>
      <Collapsible title={t("ctor.editor")}>
        <SelectField
          label={t("ctor.editorType")}
          value={editor.type ?? "drawer"}
          onChange={(event) =>
            change((draft) => {
              draft.layout ??= {};
              draft.layout.editor = {
                ...draft.layout.editor,
                type: event.target.value as "modal" | "drawer",
              };
            })
          }
        >
          <option value="drawer">drawer</option>
          <option value="modal">modal</option>
        </SelectField>
        <SelectField
          label={t("ctor.editorGrid")}
          value={editor.fields_grid ?? 1}
          onChange={(event) =>
            change((draft) => {
              draft.layout ??= {};
              draft.layout.editor = {
                ...draft.layout.editor,
                fields_grid: Number(event.target.value) as 1 | 2,
              };
            })
          }
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
        </SelectField>
        <EditorFields config={config} />
      </Collapsible>
    </div>
  );
}

function WidgetEditor({
  widget,
  config,
  index,
}: {
  widget: Widget;
  config: BoardConfig;
  index: number;
}) {
  const { t } = useT();
  const change = useDraft((state) => state.change);
  const update = (patch: Record<string, unknown>) =>
    change((draft) => {
      const target = draft.layout?.header?.widgets?.[index];
      if (target) Object.assign(target, patch);
    });
  const dimensionSelect = (value: string) => (
    <SelectField
      label={t("ctor.badgeDimension")}
      value={value}
      onChange={(event) => update({ dimension: event.target.value })}
    >
      {config.dimensions?.map((item) => (
        <option key={item.key} value={item.key}>
          {item.name}
        </option>
      ))}
    </SelectField>
  );
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Toggle
          label={WIDGET_LABELS[widget.type]}
          checked={widget.enabled !== false}
          onChange={(enabled) => update({ enabled })}
        />
        <RemoveButton
          label={`${t("common.remove")}: ${WIDGET_LABELS[widget.type]}`}
          onClick={() =>
            change((draft) => {
              draft.layout?.header?.widgets?.splice(index, 1);
            })
          }
        />
      </div>
      {widget.type === "progress_by_dimension" && (
        <>
          {dimensionSelect(widget.dimension)}
          <TextField
            label="Правило «готово»"
            value={widget.done_rule ?? "column_kind:done"}
            onChange={(event) => update({ done_rule: event.target.value })}
          />
          <Toggle
            label="Показывать подсказку"
            checked={widget.show_hint !== false}
            onChange={(show_hint) => update({ show_hint })}
          />
          <ColorField
            label="Цвет полосы"
            config={config}
            value={widget.bar_color ?? "{accent}"}
            onChange={(bar_color) => update({ bar_color })}
          />
        </>
      )}
      {widget.type === "filter_chips" && (
        <>
          {dimensionSelect(widget.dimension)}
          <SelectField
            label="Стиль чипа"
            value={widget.chip_style ?? "left-border-color"}
            onChange={(event) => update({ chip_style: event.target.value })}
          >
            {["left-border-color", "filled", "dot"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </SelectField>
          <Toggle
            label="Мультивыбор"
            checked={widget.multi !== false}
            onChange={(multi) => update({ multi })}
          />
        </>
      )}
      {widget.type === "legend" && dimensionSelect(widget.dimension)}
      {widget.type === "filter_bar" && (
        <>
          <Toggle
            label="Поиск"
            checked={widget.search !== false}
            onChange={(search) => update({ search })}
          />
          <fieldset className="grid gap-1">
            <legend className="text-xs text-ink-soft">Селекты</legend>
            {config.dimensions?.map((item) => (
              <label key={item.key} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={widget.selects?.includes(item.key) ?? false}
                  onChange={(event) =>
                    update({
                      selects: event.target.checked
                        ? [...(widget.selects ?? []), item.key]
                        : widget.selects?.filter((key) => key !== item.key),
                    })
                  }
                />
                {item.name}
              </label>
            ))}
          </fieldset>
        </>
      )}
      {widget.type === "note" && (
        <TextField
          label="Текст"
          value={widget.text}
          onChange={(event) => update({ text: event.target.value })}
        />
      )}
      {widget.type === "stats" && (
        <fieldset className="grid gap-1">
          <legend className="text-xs text-ink-soft">Метрики</legend>
          {(["total", "in_progress", "overdue", "wip_exceeded"] as const).map((metric) => (
            <label key={metric} className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={widget.metrics?.includes(metric) ?? false}
                onChange={(event) =>
                  update({
                    metrics: event.target.checked
                      ? [...(widget.metrics ?? []), metric]
                      : widget.metrics?.filter((item) => item !== metric),
                  })
                }
              />
              {t(`stats.${metric}`)}
            </label>
          ))}
        </fieldset>
      )}
      {widget.type === "actions" && (
        <div className="grid gap-1">
          {(["add_card", "export", "import", "reset"] as const).map((action) => (
            <Toggle
              key={action}
              label={action}
              checked={widget[action] !== false}
              onChange={(value) => update({ [action]: value })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function HeaderTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useDraft((state) => state.change);
  const header = config.layout?.header ?? {};
  const widgets = header.widgets ?? [];
  const firstDimension = config.dimensions?.[0]?.key;
  const add = (widget: Widget) =>
    change((draft) => {
      draft.layout ??= {};
      draft.layout.header ??= {};
      // Неявные заголовок и действия становятся явными: их можно сортировать и выключать.
      const current = draft.layout.header.widgets ?? [];
      draft.layout.header.widgets = [...current, widget];
    });
  const missingBase = (["title", "actions"] as const).filter(
    (type) => !widgets.some((widget) => widget.type === type),
  );
  return (
    <div className="grid gap-4">
      <TextField
        label={t("ctor.subtitle")}
        value={header.subtitle ?? ""}
        onChange={(event) =>
          change((draft) => {
            draft.layout ??= {};
            draft.layout.header = { ...draft.layout.header, subtitle: event.target.value };
          })
        }
      />
      <TextField
        label={t("ctor.footer")}
        value={config.layout?.footer_note ?? ""}
        onChange={(event) =>
          change((draft) => {
            draft.layout ??= {};
            draft.layout.footer_note = event.target.value;
          })
        }
      />
      <Collapsible title={t("ctor.widgets")} open>
        <SortableList
          items={widgets.map((widget, index) => ({ widget, id: `${widget.type}-${index}` }))}
          getKey={(item) => item.id}
          getLabel={(item) => WIDGET_LABELS[item.widget.type]}
          onReorder={(next) =>
            change((draft) => {
              draft.layout!.header!.widgets = next.map((item) => item.widget);
            })
          }
        >
          {(item, index) => <WidgetEditor widget={item.widget} config={config} index={index} />}
        </SortableList>
        <div className="flex flex-wrap gap-1">
          {missingBase.map((type) => (
            <Button key={type} size="sm" onClick={() => add({ type } as Widget)}>
              + {WIDGET_LABELS[type]}
            </Button>
          ))}
          {firstDimension && (
            <>
              <Button
                size="sm"
                onClick={() => add({ type: "progress_by_dimension", dimension: firstDimension })}
              >
                + {WIDGET_LABELS.progress_by_dimension}
              </Button>
              <Button
                size="sm"
                onClick={() => add({ type: "filter_chips", dimension: firstDimension })}
              >
                + {WIDGET_LABELS.filter_chips}
              </Button>
              <Button size="sm" onClick={() => add({ type: "legend", dimension: firstDimension })}>
                + {WIDGET_LABELS.legend}
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => add({ type: "filter_bar", selects: [] })}>
            + {WIDGET_LABELS.filter_bar}
          </Button>
          <Button
            size="sm"
            onClick={() => add({ type: "stats", metrics: ["total", "in_progress"] })}
          >
            + {WIDGET_LABELS.stats}
          </Button>
          <Button size="sm" onClick={() => add({ type: "note", text: "Заметка" })}>
            + {WIDGET_LABELS.note}
          </Button>
        </div>
        <p className="text-xs text-ink-soft">{normalizedWidgets(config).length} активн.</p>
      </Collapsible>
      <SelectField
        label={t("ctor.swimlanes")}
        value={config.layout?.board?.swimlanes ?? ""}
        onChange={(event) =>
          change((draft) => {
            draft.layout ??= {};
            draft.layout.board = { swimlanes: event.target.value || null };
          })
        }
      >
        <option value="">—</option>
        {config.dimensions?.map((item) => (
          <option key={item.key} value={item.key}>
            {item.name}
          </option>
        ))}
      </SelectField>
    </div>
  );
}

function BackgroundEditor({
  label,
  value,
  config,
  onChange,
}: {
  label: string;
  value: Background | null | undefined;
  config: BoardConfig;
  onChange: (background: Background | null) => void;
}) {
  const { t } = useT();
  const type = value?.type ?? "";
  const setType = (next: string) => {
    if (next === "color") onChange({ type: "color", value: "{bg}" });
    else if (next === "linear-gradient")
      onChange({ type: "linear-gradient", angle: 180, stops: ["{surface}", "{bg}"] });
    else if (next === "radial-gradient")
      onChange({ type: "radial-gradient", stops: ["{surface}", "{bg}"] });
    else if (next === "image")
      onChange({ type: "image", url: "https://", overlay: "#000000", overlay_opacity: 0.4 });
    else onChange(null);
  };
  return (
    <Collapsible title={label}>
      <SelectField
        label={t("ctor.bgType")}
        value={type}
        onChange={(event) => setType(event.target.value)}
      >
        <option value="">—</option>
        <option value="color">color</option>
        <option value="linear-gradient">linear-gradient</option>
        <option value="radial-gradient">radial-gradient</option>
        <option value="image">image</option>
      </SelectField>
      {value?.type === "color" && (
        <ColorField
          label={t("ctor.color")}
          config={config}
          value={value.value}
          onChange={(color) => color && onChange({ ...value, value: color })}
        />
      )}
      {(value?.type === "linear-gradient" || value?.type === "radial-gradient") && (
        <>
          {value.type === "linear-gradient" && (
            <NumberField
              label={t("ctor.bgAngle")}
              min={0}
              max={360}
              value={value.angle ?? 180}
              onChange={(angle) => onChange({ ...value, angle: angle ?? 0 })}
            />
          )}
          {value.stops.map((stop, index) => (
            <ColorField
              key={index}
              label={`${t("ctor.color")} ${index + 1}`}
              config={config}
              value={stop}
              onChange={(color) =>
                color &&
                onChange({
                  ...value,
                  stops: value.stops.map((item, position) => (position === index ? color : item)),
                })
              }
            />
          ))}
        </>
      )}
      {value?.type === "image" && (
        <>
          <TextField
            label={t("ctor.bgUrl")}
            type="url"
            value={value.url}
            onChange={(event) => onChange({ ...value, url: event.target.value })}
          />
          <NumberField
            label={t("ctor.bgOverlay")}
            min={0}
            max={1}
            step={0.05}
            value={value.overlay_opacity ?? 0.4}
            onChange={(overlay_opacity) =>
              onChange({ ...value, overlay_opacity: overlay_opacity ?? 0 })
            }
          />
        </>
      )}
    </Collapsible>
  );
}

function TokenGrid({
  tokens,
  config,
  field,
}: {
  tokens: Record<string, string>;
  config: BoardConfig;
  field: "tokens" | "alt_tokens";
}) {
  const { t } = useT();
  const change = useDraft((state) => state.change);
  const [newToken, setNewToken] = useState("");
  const names = [...new Set([...BASE_TOKEN_NAMES, ...Object.keys(tokens)])];
  const setToken = (name: string, value: string) =>
    change((draft) => {
      draft.theme ??= {};
      draft.theme[field] = { ...draft.theme[field], [name]: value };
    });
  return (
    <div className="grid gap-2">
      {names.map((name) => (
        <div key={name} className="flex items-center gap-2" data-token={name}>
          <input
            type="color"
            aria-label={name}
            className="size-7 shrink-0 cursor-pointer rounded-sm border border-line-strong bg-panel p-0.5"
            value={(tokens[name] ?? config.theme?.tokens?.[name] ?? "#000000").slice(0, 7)}
            onChange={(event) => setToken(name, event.target.value.toUpperCase())}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{name}</span>
          <input
            aria-label={`${name}: hex`}
            className="w-24 rounded-sm border border-line-strong bg-panel px-1 py-0.5 font-mono text-xs"
            key={tokens[name]}
            defaultValue={tokens[name] ?? ""}
            onBlur={(event) => {
              if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(event.target.value)) {
                setToken(name, event.target.value);
              }
            }}
          />
        </div>
      ))}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (/^[a-z][a-z0-9-]{0,39}$/.test(newToken)) {
            setToken(newToken, "#808080");
            setNewToken("");
          }
        }}
      >
        <TextField
          className="flex-1"
          label={t("ctor.tokenName")}
          placeholder="brand-pink"
          pattern="[a-z][a-z0-9\-]{0,39}"
          value={newToken}
          onChange={(event) => setNewToken(event.target.value.trim().toLowerCase())}
        />
        <Button type="submit">
          <Plus className="size-3.5" aria-hidden />
          {t("ctor.addToken")}
        </Button>
      </form>
    </div>
  );
}

export function ThemeTab({ config }: { config: BoardConfig }) {
  const { t } = useT();
  const change = useDraft((state) => state.change);
  const theme: Theme = config.theme ?? {};
  const issues = contrastReport(config);
  const patch = (update: Partial<Theme>) =>
    change((draft) => {
      draft.theme = { ...draft.theme, ...update };
    });
  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-2">
        <SelectField
          label={t("ctor.mode")}
          value={theme.mode ?? "light"}
          onChange={(event) => patch({ mode: event.target.value as Theme["mode"] })}
        >
          <option value="light">light</option>
          <option value="dark">dark</option>
          <option value="both">both</option>
        </SelectField>
        <SelectField
          label={t("ctor.density")}
          value={theme.density ?? "comfortable"}
          onChange={(event) =>
            change((draft) =>
              applyDensity(draft, event.target.value as keyof typeof DENSITY_PRESETS),
            )
          }
        >
          <option value="compact">compact</option>
          <option value="comfortable">comfortable</option>
          <option value="spacious">spacious</option>
        </SelectField>
      </div>
      <Collapsible title={t("ctor.gallery")} open>
        <div className="grid grid-cols-2 gap-2">
          {PALETTES.map((palette) => (
            <button
              key={palette.name}
              type="button"
              className="grid gap-1 rounded-md border border-line p-2 text-left text-xs hover:border-brand"
              onClick={() => patch({ tokens: palette.tokens, mode: palette.mode })}
            >
              <span className="flex h-5 overflow-hidden rounded-sm" aria-hidden>
                {["bg", "surface-2", "accent", "text"].map((token) => (
                  <i key={token} className="flex-1" style={{ background: palette.tokens[token] }} />
                ))}
              </span>
              {palette.name}
            </button>
          ))}
        </div>
      </Collapsible>
      <div
        role="status"
        data-testid="contrast-report"
        className={cx(
          "grid gap-1 rounded-md p-2 text-xs",
          issues.length ? "bg-danger-soft text-danger" : "bg-raised text-success",
        )}
      >
        {issues.length === 0 ? (
          <span className="flex items-center gap-1">
            <CheckCircle2 className="size-3.5" aria-hidden />
            {t("ctor.contrastOk")}
          </span>
        ) : (
          issues.slice(0, 6).map((issue) => (
            <span key={issue.pair} className="flex items-center gap-1">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              {t("ctor.contrastLow", { ratio: issue.ratio, pair: issue.pair })}
            </span>
          ))
        )}
      </div>
      <Collapsible title={t("ctor.palette")} open>
        <TokenGrid tokens={theme.tokens ?? {}} config={config} field="tokens" />
      </Collapsible>
      {theme.mode === "both" && (
        <Collapsible title={t("ctor.altPalette")}>
          <TokenGrid tokens={theme.alt_tokens ?? {}} config={config} field="alt_tokens" />
        </Collapsible>
      )}
      <BackgroundEditor
        label={t("ctor.headerBg")}
        value={theme.header_background}
        config={config}
        onChange={(header_background) => patch({ header_background })}
      />
      <BackgroundEditor
        label={t("ctor.boardBg")}
        value={theme.board_background}
        config={config}
        onChange={(board_background) => patch({ board_background })}
      />
    </div>
  );
}

function RoleEditor({
  role,
  value,
  config,
}: {
  role: RoleName;
  value: TypeRole;
  config: BoardConfig;
}) {
  const { t } = useT();
  const change = useDraft((state) => state.change);
  const update = (patch: Partial<TypeRole>) =>
    change((draft) => {
      draft.typography = { ...draft.typography, [role]: { ...draft.typography?.[role], ...patch } };
    });
  return (
    <Collapsible title={ROLE_NAMES[role]}>
      <div data-role-editor={role} className="grid gap-2">
        <SelectField
          label={t("ctor.font")}
          value={value.font ?? ""}
          onChange={(event) => update({ font: event.target.value || null })}
        >
          <option value="">—</option>
          {FONT_NAMES.map((font) => (
            <option key={font} value={font} style={{ fontFamily: fontStack(font) }}>
              {font}
            </option>
          ))}
        </SelectField>
        <div className="grid grid-cols-2 gap-2">
          <SelectField
            label={t("ctor.weight")}
            value={value.weight ?? ""}
            onChange={(event) =>
              update({ weight: event.target.value ? Number(event.target.value) : null })
            }
          >
            <option value="">—</option>
            {WEIGHTS.map((weight) => (
              <option key={weight}>{weight}</option>
            ))}
          </SelectField>
          <NumberField
            label={t("ctor.size")}
            min={8}
            max={72}
            step={0.5}
            value={value.size}
            onChange={(size) => update({ size })}
          />
          <NumberField
            label={t("ctor.letterSpacing")}
            min={-0.2}
            max={1}
            step={0.01}
            value={value.letter_spacing}
            onChange={(letter_spacing) => update({ letter_spacing })}
          />
          <NumberField
            label={t("ctor.lineHeight")}
            min={0.8}
            max={3}
            step={0.05}
            value={value.line_height}
            onChange={(line_height) => update({ line_height })}
          />
          <SelectField
            label={t("ctor.case")}
            value={value.case ?? "as_is"}
            onChange={(event) => update({ case: event.target.value as TypeRole["case"] })}
          >
            {CASES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </SelectField>
          <NumberField
            label={t("ctor.lineClamp")}
            min={1}
            max={20}
            value={value.line_clamp}
            onChange={(line_clamp) => update({ line_clamp })}
          />
        </div>
        <ColorField
          label={t("ctor.color")}
          config={config}
          allowEmpty
          value={value.color}
          onChange={(color) => update({ color })}
        />
      </div>
    </Collapsible>
  );
}

export function TypographyTab({ config }: { config: BoardConfig }) {
  return (
    <div className="grid gap-2">
      {TYPE_ROLES.map((role) => (
        <RoleEditor
          key={role}
          role={role}
          value={config.typography?.[role] ?? {}}
          config={config}
        />
      ))}
    </div>
  );
}
