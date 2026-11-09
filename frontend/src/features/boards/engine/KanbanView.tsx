import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Plus } from "lucide-react";
import { memo, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "@/i18n";
import type { BoardConfig, CardOut, ColumnTemplate, DimensionTemplate } from "@/lib/api/types";

import { cardShellProps, CardFace } from "./CardFace";
import { groupByColumn, groupCards, hasRule } from "./model";
import { resolveColor } from "./theme";

export interface MoveRequest {
  cardId: string;
  column: string;
  beforeId: string | null;
  afterId: string | null;
  lane?: { dimension: string; value: string | null };
}

export interface CardHandlers {
  onOpen?: (card: CardOut) => void;
  onMove?: (move: MoveRequest) => void;
  onQuickAdd?: (column: string, title: string) => void;
}

interface ColumnProps extends CardHandlers {
  column: ColumnTemplate;
  cards: CardOut[];
  config: BoardConfig;
  laneKey: string;
  interactive: boolean;
  total: number;
  draggingId: string | null;
}

function dropId(lane: string, column: string): string {
  return `drop::${lane}::${column}`;
}

function parseDrop(id: string): { lane: string; column: string } | null {
  const parts = id.split("::");
  return parts[0] === "drop" && parts[1] && parts[2] ? { lane: parts[1], column: parts[2] } : null;
}

const StaticCard = memo(function StaticCard({
  card,
  config,
  column,
}: {
  card: CardOut;
  config: BoardConfig;
  column: ColumnTemplate | undefined;
}) {
  return (
    <article className="kb-card" data-card-id={card.id} {...cardShellProps(card, config, column)}>
      <CardFace card={card} config={config} column={column} />
    </article>
  );
});

const SortableCard = memo(function SortableCard({
  card,
  config,
  column,
  onOpen,
}: {
  card: CardOut;
  config: BoardConfig;
  column: ColumnTemplate | undefined;
  onOpen?: (card: CardOut) => void;
}) {
  const { t } = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });
  const shell = cardShellProps(card, config, column);
  const style = {
    ...shell.style,
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key.toLowerCase() === "e") {
      event.preventDefault();
      onOpen?.(card);
      return;
    }
    listeners?.onKeyDown?.(event);
  };
  return (
    <div
      ref={setNodeRef}
      className="kb-card"
      data-card-id={card.id}
      {...shell}
      {...attributes}
      {...listeners}
      style={style}
      aria-roledescription={t("board.cardRole")}
      onKeyDown={handleKeyDown}
      onClick={() => onOpen?.(card)}
    >
      <CardFace card={card} config={config} column={column} />
    </div>
  );
});

function QuickAdd({ column, onAdd }: { column: ColumnTemplate; onAdd: (title: string) => void }) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  if (!editing) {
    return (
      <button type="button" className="kb-add" onClick={() => setEditing(true)}>
        <Plus aria-hidden /> {t("board.addToColumn")}
      </button>
    );
  }
  return (
    <div className="kb-add-form">
      <input
        className="kb-input"
        autoFocus
        value={title}
        aria-label={`${t("board.quickAddPlaceholder")}: ${column.name}`}
        placeholder={t("board.quickAddPlaceholder")}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={() => !title && setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setTitle("");
            setEditing(false);
          }
          if (event.key === "Enter" && title.trim()) {
            onAdd(title.trim());
            setTitle("");
          }
        }}
      />
    </div>
  );
}

function ColumnHeader({
  column,
  config,
  count,
  collapsed,
  onToggle,
}: {
  column: ColumnTemplate;
  config: BoardConfig;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useT();
  const layout = config.layout?.column ?? {};
  const limit = column.wip_limit;
  const showWip = layout.show_wip !== false && limit != null;
  const label = showWip ? `${count}/${limit}` : count;
  return (
    <h2 className="kb-col-head">
      <span className="kb-col-name">
        {layout.collapsible && (
          <button
            type="button"
            className="kb-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("board.expand") : t("board.collapse")}
            onClick={onToggle}
          >
            <ChevronRight aria-hidden />
          </button>
        )}
        {column.icon && <span aria-hidden>{column.icon} </span>}
        {column.name}
      </span>
      {(layout.show_count !== false || showWip) && (
        <em aria-label={t("board.count", { count })}>{label}</em>
      )}
    </h2>
  );
}

function Column({
  column,
  cards,
  config,
  laneKey,
  interactive,
  total,
  draggingId,
  onOpen,
  onQuickAdd,
}: ColumnProps) {
  const { t } = useT();
  const layout = config.layout?.column ?? {};
  const [collapsed, setCollapsed] = useState(column.collapsed ?? false);
  const { setNodeRef, isOver } = useDroppable({
    id: dropId(laneKey, column.key),
    disabled: !interactive,
  });
  const exceeded =
    hasRule(config, "highlight_wip_exceeded") &&
    column.wip_limit != null &&
    total > column.wip_limit;
  const width = column.width ?? layout.fixed_width;
  const style = {
    "--col-basis": `${width ?? layout.min_width ?? 280}px`,
    "--col-grow": width ? 0 : 1,
    "--col-color": resolveColor(column.color),
  } as React.CSSProperties;
  const ids = useMemo(() => cards.map((card) => card.id), [cards]);
  const list = (
    <div
      ref={setNodeRef}
      className="kb-list"
      data-column={column.key}
      data-over={(isOver && draggingId !== null) || undefined}
    >
      {cards.length === 0 && (
        <div className="kb-empty">{column.empty_text ?? layout.empty_text ?? t("board.empty")}</div>
      )}
      {cards.map((card) =>
        interactive ? (
          <SortableCard key={card.id} card={card} config={config} column={column} onOpen={onOpen} />
        ) : (
          <StaticCard key={card.id} card={card} config={config} column={column} />
        ),
      )}
    </div>
  );
  return (
    <section
      className="kb-col"
      data-kind={column.kind ?? "custom"}
      data-key={column.key}
      data-header-style={column.header_style ?? layout.header_style ?? "flat-with-divider"}
      data-collapsed={collapsed || undefined}
      data-wip-exceeded={exceeded || undefined}
      style={style}
    >
      <ColumnHeader
        column={column}
        config={config}
        count={cards.length}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
      />
      {!collapsed &&
        (interactive ? (
          <SortableContext
            id={dropId(laneKey, column.key)}
            items={ids}
            strategy={verticalListSortingStrategy}
          >
            {list}
          </SortableContext>
        ) : (
          list
        ))}
      {interactive && !collapsed && onQuickAdd && (
        <QuickAdd column={column} onAdd={(title) => onQuickAdd(column.key, title)} />
      )}
    </section>
  );
}

type Layout = Map<string, CardOut[]>;

function layoutKey(lane: string, column: string): string {
  return `${lane}::${column}`;
}

interface Lane {
  key: string;
  label: string | null;
  cards: CardOut[];
}

function buildLanes(cards: CardOut[], dimension: DimensionTemplate | undefined): Lane[] {
  if (!dimension) return [{ key: "all", label: null, cards }];
  return groupCards(cards, dimension).map((group) => ({
    key: group.key,
    label: group.value?.name ?? "—",
    cards: group.cards,
  }));
}

function buildLayout(lanes: Lane[], columns: ColumnTemplate[]): Layout {
  const layout: Layout = new Map();
  for (const lane of lanes) {
    const groups = groupByColumn(lane.cards, columns);
    for (const column of columns) {
      layout.set(layoutKey(lane.key, column.key), groups.get(column.key) ?? []);
    }
  }
  return layout;
}

function findContainer(layout: Layout, cardId: string): string | null {
  for (const [key, cards] of layout) {
    if (cards.some((card) => card.id === cardId)) return key;
  }
  return null;
}

export function KanbanView({
  config,
  cards,
  allCards,
  interactive,
  onOpen,
  onMove,
  onQuickAdd,
}: CardHandlers & {
  config: BoardConfig;
  cards: CardOut[];
  allCards: CardOut[];
  interactive: boolean;
}) {
  const { t } = useT();
  const columns = config.columns;
  const swimlaneKey = config.layout?.board?.swimlanes;
  const dimension = config.dimensions?.find((item) => item.key === swimlaneKey);
  const lanes = useMemo(() => buildLanes(cards, dimension), [cards, dimension]);
  const stableLayout = useMemo(() => buildLayout(lanes, columns), [lanes, columns]);
  const [dragLayout, setDragLayout] = useState<Layout | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const liveLayout = useRef<Layout | null>(null);
  const layout = dragLayout ?? stableLayout;
  const activeCard = activeId ? cards.find((card) => card.id === activeId) : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );

  const columnTotals = useMemo(() => groupByColumn(allCards, columns), [allCards, columns]);

  const updateLayout = (next: Layout) => {
    liveLayout.current = next;
    setDragLayout(next);
  };

  const handleStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    updateLayout(new Map(stableLayout));
  };

  const containerOf = (id: string, current: Layout): string | null => {
    const drop = parseDrop(id);
    return drop ? layoutKey(drop.lane, drop.column) : findContainer(current, id);
  };

  const handleOver = ({ active, over }: DragOverEvent) => {
    const current = liveLayout.current;
    if (!over || !current) return;
    const activeKey = String(active.id);
    const overKey = String(over.id);
    const from = findContainer(current, activeKey);
    const to = containerOf(overKey, current);
    if (!from || !to || from === to) return;
    const source = current.get(from) ?? [];
    const target = current.get(to) ?? [];
    const moving = source.find((card) => card.id === activeKey);
    if (!moving) return;
    const overIndex = target.findIndex((card) => card.id === overKey);
    const index = overIndex >= 0 ? overIndex : target.length;
    const next = new Map(current);
    next.set(
      from,
      source.filter((card) => card.id !== activeKey),
    );
    next.set(to, [...target.slice(0, index), moving, ...target.slice(index)]);
    updateLayout(next);
  };

  const finish = () => {
    setActiveId(null);
    setDragLayout(null);
    liveLayout.current = null;
  };

  const handleEnd = ({ active, over }: DragEndEvent) => {
    const current = liveLayout.current;
    if (!current || !over) {
      finish();
      return;
    }
    const activeKey = String(active.id);
    const container = findContainer(current, activeKey);
    if (!container) {
      finish();
      return;
    }
    const [laneKeyValue = "", columnKey = ""] = container.split("::");
    let list = current.get(container) ?? [];
    const from = list.findIndex((card) => card.id === activeKey);
    const to = list.findIndex((card) => card.id === String(over.id));
    if (to >= 0 && from !== to) {
      const reordered = [...list];
      const [moved] = reordered.splice(from, 1);
      if (moved) reordered.splice(to, 0, moved);
      list = reordered;
    }
    const index = list.findIndex((card) => card.id === activeKey);
    const original = cards.find((card) => card.id === activeKey);
    const before = list[index - 1]?.id ?? null;
    const after = list[index + 1]?.id ?? null;
    const originalList = stableLayout.get(findContainer(stableLayout, activeKey) ?? "") ?? [];
    const originalIndex = originalList.findIndex((card) => card.id === activeKey);
    const unchanged =
      original?.column === columnKey &&
      originalList[originalIndex - 1]?.id === (before ?? undefined) &&
      originalList[originalIndex + 1]?.id === (after ?? undefined);
    if (!unchanged) {
      const laneChanged =
        dimension && findContainer(stableLayout, activeKey)?.split("::")[0] !== laneKeyValue;
      onMove?.({
        cardId: activeKey,
        column: columnKey,
        beforeId: before,
        afterId: after,
        lane:
          laneChanged && dimension
            ? {
                dimension: dimension.key,
                value: laneKeyValue === "__none" ? null : laneKeyValue,
              }
            : undefined,
      });
    }
    finish();
  };

  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t("dnd.pickup", {
        title: cards.find((card) => card.id === String(active.id))?.title ?? "",
      }),
    onDragOver: ({ over }) => {
      const key = over ? containerOf(String(over.id), layout) : null;
      const column = columns.find((item) => item.key === key?.split("::")[1]);
      return column ? t("dnd.over", { column: column.name }) : undefined;
    },
    onDragEnd: ({ over }) => {
      const key = over ? containerOf(String(over.id), layout) : null;
      const column = columns.find((item) => item.key === key?.split("::")[1]);
      return column ? t("dnd.drop", { column: column.name }) : t("dnd.cancel");
    },
    onDragCancel: () => t("dnd.cancel"),
  };

  const content = lanes.map((lane) => (
    <div key={lane.key} className="kb-lane">
      {lane.label !== null && <h3 className="kb-lane-title">{lane.label}</h3>}
      <main className="kb-columns">
        {columns.map((column) => (
          <Column
            key={column.key}
            column={column}
            cards={layout.get(layoutKey(lane.key, column.key)) ?? []}
            config={config}
            laneKey={lane.key}
            interactive={interactive}
            total={columnTotals.get(column.key)?.length ?? 0}
            draggingId={activeId}
            onOpen={onOpen}
            onQuickAdd={onQuickAdd}
          />
        ))}
      </main>
    </div>
  ));

  if (!interactive) return <>{content}</>;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t("dnd.instructions") },
      }}
      onDragStart={handleStart}
      onDragOver={handleOver}
      onDragEnd={handleEnd}
      onDragCancel={finish}
    >
      {content}
      <DragOverlay dropAnimation={{ duration: 200, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
        {activeCard ? (
          <article
            className="kb-card kb-card-overlay"
            {...cardShellProps(
              activeCard,
              config,
              columns.find((column) => column.key === activeCard.column),
            )}
          >
            <CardFace
              card={activeCard}
              config={config}
              column={columns.find((column) => column.key === activeCard.column)}
            />
          </article>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
