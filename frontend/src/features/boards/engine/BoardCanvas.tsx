/** Движок доски: один компонент для доски, live-preview конструктора и миниатюр галереи. */
import { useEffect, useMemo } from "react";

import { useT } from "@/i18n";
import type { BoardConfig, CardOut, ViewTemplate } from "@/lib/api/types";

import "./board.css";
import { BoardHeader, type BoardActions } from "./HeaderWidgets";
import { KanbanView, type CardHandlers } from "./KanbanView";
import { matchesFilters, type Filters } from "./model";
import { TableView } from "./TableView";
import { boardStyle, loadConfigFonts, type Palette } from "./theme";

export interface BoardCanvasProps extends CardHandlers {
  name: string;
  config: BoardConfig;
  cards: CardOut[];
  filters: Filters;
  onFilters: (filters: Filters) => void;
  view?: ViewTemplate;
  palette?: Palette;
  interactive?: boolean;
  thumbnail?: boolean;
  actions?: BoardActions;
}

export function BoardCanvas({
  name,
  config,
  cards,
  filters,
  onFilters,
  view,
  palette = "primary",
  interactive = false,
  thumbnail = false,
  actions = {},
  onOpen,
  onMove,
  onQuickAdd,
}: BoardCanvasProps) {
  const { t } = useT();
  useEffect(() => loadConfigFonts(config), [config]);
  const style = useMemo(() => boardStyle(config, palette), [config, palette]);
  const visible = useMemo(
    () => cards.filter((card) => matchesFilters(card, filters)),
    [cards, filters],
  );
  const footer = config.layout?.footer_note;
  const viewType = view?.type ?? "kanban";
  return (
    <div className="kb-board" data-testid={thumbnail ? undefined : "board-canvas"} style={style}>
      <BoardHeader
        name={name}
        config={config}
        cards={cards}
        filters={filters}
        onFilters={onFilters}
        actions={actions}
      />
      {viewType === "kanban" ? (
        <KanbanView
          config={config}
          cards={visible}
          allCards={cards}
          interactive={interactive}
          onOpen={onOpen}
          onMove={onMove}
          onQuickAdd={onQuickAdd}
        />
      ) : (
        <>
          {viewType !== "table" && (
            <p className="kb-note kb-view-note">{t("board.calendarSoon")}</p>
          )}
          <TableView config={config} cards={visible} view={view} onOpen={onOpen} />
        </>
      )}
      {footer && <div className="kb-footer">{footer}</div>}
    </div>
  );
}
