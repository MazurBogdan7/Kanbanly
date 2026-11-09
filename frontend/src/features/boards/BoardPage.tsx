import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  Download,
  MoreHorizontal,
  Palette as PaletteIcon,
  Settings2,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  cx,
  ErrorNote,
  Input,
  Menu,
  MenuItem,
  Modal,
  Skeleton,
  TextField,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, downloadFrom, saveJson } from "@/lib/api/client";
import type { BoardOut, BoardTemplate, CardOut, ViewTemplate } from "@/lib/api/types";
import { moveCardFocus, useHotkeys } from "@/lib/hotkeys";
import { isPrototypeExport, prototypeToSamples } from "@/lib/prototypeImport";
import { useUndo } from "@/lib/undo";

import { CardEditor } from "../cards/CardEditor";
import { ConstructorPanel } from "../settings/ConstructorPanel";
import { useDraft } from "../settings/draft";
import { TemplateImportDialog } from "../templates/TemplateImportDialog";
import {
  isPending,
  keys,
  useBoard,
  useCards,
  useCreateCard,
  useLiveBoard,
  useMoveCard,
} from "./api";
import { ProjectTagsContext, useTagIndex } from "../workspace/tags";
import { BoardCanvas } from "./engine/BoardCanvas";
import type { MoveRequest } from "./engine/KanbanView";
import { EMPTY_FILTERS, filtersFromView, type Filters } from "./engine/model";
import { initialPalette, type Palette } from "./engine/theme";

function InlineName({ board, readOnly }: { board: BoardOut; readOnly: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(board.name);
  useEffect(() => setValue(board.name), [board.name]);
  const save = () => {
    const name = value.trim();
    if (!name || name === board.name) {
      setValue(board.name);
      return;
    }
    api
      .patch<BoardOut>(`/boards/${board.id}`, { name }, { ifMatch: board.version })
      .then((saved) => queryClient.setQueryData(keys.board(board.id), saved))
      .catch((error: unknown) => {
        toast.error(error);
        setValue(board.name);
        void queryClient.invalidateQueries({ queryKey: keys.board(board.id) });
      });
  };
  return (
    <Input
      aria-label={t("board.renameLabel")}
      readOnly={readOnly}
      className="h-7 w-44 border-transparent bg-transparent font-medium hover:border-line-strong md:w-64"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
    />
  );
}

function ViewTabs({
  board,
  active,
  onSelect,
  onSave,
}: {
  board: BoardOut;
  active: ViewTemplate | undefined;
  onSelect: (view: ViewTemplate) => void;
  onSave: () => void;
}) {
  const { t } = useT();
  const views = board.config.views ?? [];
  return (
    <div
      role="group"
      aria-label={t("board.views")}
      className="flex items-center gap-1 overflow-x-auto"
    >
      {views.map((view) => (
        <button
          key={view.key}
          type="button"
          aria-pressed={active?.key === view.key}
          onClick={() => onSelect(view)}
          className={cx(
            "rounded-sm px-2 py-1 text-xs font-medium whitespace-nowrap transition-colors",
            active?.key === view.key
              ? "bg-brand-soft text-ink"
              : "text-ink-soft hover:bg-raised hover:text-ink",
          )}
        >
          {view.name}
        </button>
      ))}
      <Button variant="ghost" size="sm" onClick={onSave}>
        {t("board.saveView")}
      </Button>
    </div>
  );
}

export function BoardPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { boardId } = useParams({ strict: false }) as { boardId: string };
  const search = new URLSearchParams(window.location.search);
  const board = useBoard(boardId);
  const cards = useCards(boardId);
  const tagIndex = useTagIndex(board.data?.project_id);
  useLiveBoard(boardId);
  const moveCard = useMoveCard(boardId);
  const createCard = useCreateCard(boardId);
  const [view, setView] = useState<ViewTemplate | undefined>();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [opened, setOpened] = useState<{ id: string | null; column?: string } | null>(null);
  const [constructorOpen, setConstructorOpen] = useState(search.get("builder") === "1");
  const [saveView, setSaveView] = useState(false);
  const [viewName, setViewName] = useState("");
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [importing, setImporting] = useState<File | null>(null);
  const [paletteChoice, setPaletteChoice] = useState<Palette | null>(null);
  const draft = useDraft((state) => state.draft);
  const initialized = useRef(false);

  useEffect(() => {
    if (!board.data || initialized.current) return;
    initialized.current = true;
    const first = board.data.config.views?.find((item) => item.is_default);
    setView(first);
    setFilters(filtersFromView(first));
  }, [board.data]);

  useEffect(() => useUndo.getState().clear(), [boardId]);

  const canEdit = board.data?.role !== "viewer";
  const config = constructorOpen && draft ? draft : board.data?.config;
  const openCard = useMemo(
    () => cards.data?.find((card) => card.id === opened?.id) ?? null,
    [cards.data, opened],
  );

  const handleMove = (move: MoveRequest) => {
    if (isPending({ id: move.cardId })) return;
    void moveCard(move).then(() => {
      if (!move.lane) return;
      const { dimension, value } = move.lane;
      api
        .patch<CardOut>(`/cards/${move.cardId}`, { values: { [dimension]: value ? [value] : [] } })
        .then((saved) =>
          queryClient.setQueryData<CardOut[]>(keys.cards(boardId), (list = []) =>
            list.map((card) => (card.id === saved.id ? saved : card)),
          ),
        )
        .catch(toast.error);
    });
  };

  useHotkeys({
    n: () => canEdit && setOpened({ id: null }),
    "mod+z": () => (constructorOpen ? useDraft.getState().undo() : void useUndo.getState().undo()),
    ArrowUp: () => moveCardFocus("ArrowUp"),
    ArrowDown: () => moveCardFocus("ArrowDown"),
    ArrowLeft: () => moveCardFocus("ArrowLeft"),
    ArrowRight: () => moveCardFocus("ArrowRight"),
  });

  const reset = useMutation({
    mutationFn: () => api.post<BoardOut>(`/boards/${boardId}/reset`, { cards: true }),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.board(boardId), saved);
      void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
      toast.info(t("board.resetDone"));
    },
    onError: toast.error,
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/boards/${boardId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      toast.info(t("board.deleted"), {
        label: t("common.undo"),
        run: () =>
          void api
            .post(`/boards/${boardId}/restore`)
            .then(() => queryClient.invalidateQueries({ queryKey: keys.projects })),
      });
      void navigate({
        to: "/projects/$projectId",
        params: { projectId: board.data?.project_id ?? "" },
      });
    },
    onError: toast.error,
  });

  const toggleFavorite = useMutation({
    mutationFn: () =>
      api.patch<BoardOut>(`/boards/${boardId}`, { is_favorite: !board.data?.is_favorite }),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.board(boardId), saved);
      void queryClient.invalidateQueries({ queryKey: keys.projects });
    },
  });

  const createView = useMutation({
    mutationFn: () =>
      api.post(`/boards/${boardId}/views`, {
        key: `view-${crypto.randomUUID().slice(0, 8)}`,
        name: viewName,
        type: view?.type ?? "kanban",
        filters,
        group_by: view?.group_by,
        sort: view?.sort,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.board(boardId) });
      setSaveView(false);
      setViewName("");
    },
    onError: toast.error,
  });

  const createTemplate = useMutation({
    mutationFn: () =>
      api.post("/templates/from-board", {
        board_id: boardId,
        name: templateName,
        include_cards: false,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.templates });
      toast.info(t("board.templateSaved"));
      setSaveTemplate(false);
    },
    onError: toast.error,
  });

  /** Файл шаблона уходит в диалог превью, экспорт прототипа — в новую доску рядом. */
  const importFile = async (file: File) => {
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch {
      setImporting(file);
      return;
    }
    if (!isPrototypeExport(document) || !board.data) {
      setImporting(file);
      return;
    }
    try {
      const template = await api.get<BoardTemplate>(`/boards/${boardId}/template`);
      const { samples, skipped } = prototypeToSamples(document, template);
      const created = await api.post<BoardOut>(`/projects/${board.data.project_id}/boards`, {
        name: t("board.importedName", { name: board.data.name }),
        template: { ...template, sample_cards: samples },
      });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      toast.info(t("board.prototypeImported", { count: samples.length, skipped }));
      void navigate({ to: "/boards/$boardId", params: { boardId: created.id } });
    } catch (error) {
      toast.error(error);
    }
  };

  const exportTemplate = () =>
    api
      .get<object>(`/boards/${boardId}/template`, { include_cards: true })
      .then((document) => saveJson(document, `${board.data?.name ?? "board"}.template.json`))
      .catch(toast.error);

  if (board.isError) {
    return (
      <div className="p-8">
        <ErrorNote message={t("common.error")} onRetry={() => void board.refetch()} />
      </div>
    );
  }
  if (!board.data || !config || !cards.data) {
    return (
      <div className="grid gap-3 p-6" aria-busy>
        <Skeleton className="h-24" />
        <div className="grid grid-cols-3 gap-3">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }
  const palette: Palette = paletteChoice ?? initialPalette(config);
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-auto" data-testid="board-scroll">
        <div
          data-testid="board-toolbar"
          className="sticky top-0 left-0 z-20 flex h-11 items-center gap-2 border-b border-line bg-panel px-3"
        >
          <InlineName board={board.data} readOnly={!canEdit} />
          <ViewTabs
            board={board.data}
            active={view}
            onSelect={(next) => {
              setView(next);
              setFilters(filtersFromView(next));
            }}
            onSave={() => setSaveView(true)}
          />
          <div className="ml-auto flex items-center gap-1">
            {config.theme?.mode === "both" && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("board.switchPalette")}
                aria-pressed={palette === "alt"}
                onClick={() => setPaletteChoice(palette === "alt" ? "primary" : "alt")}
              >
                <PaletteIcon className="size-4" aria-hidden />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("board.favorite")}
              aria-pressed={board.data.is_favorite}
              onClick={() => toggleFavorite.mutate()}
            >
              <Star
                className={cx("size-4", board.data.is_favorite && "fill-current text-warning")}
                aria-hidden
              />
            </Button>
            {canEdit && (
              <Button size="sm" onClick={() => setConstructorOpen((value) => !value)}>
                <Settings2 className="size-3.5" aria-hidden />
                {t("board.constructor")}
              </Button>
            )}
            <Menu
              trigger={
                <Button variant="ghost" size="icon" aria-label={t("board.export")}>
                  <MoreHorizontal className="size-4" aria-hidden />
                </Button>
              }
            >
              <MenuItem
                onSelect={() => {
                  setTemplateName(board.data?.name ?? "");
                  setSaveTemplate(true);
                }}
              >
                {t("board.saveAsTemplate")}
              </MenuItem>
              <MenuItem onSelect={() => void exportTemplate()}>
                <Download className="size-3.5" aria-hidden />
                {t("board.downloadTemplate")}
              </MenuItem>
              <MenuItem
                onSelect={() =>
                  void downloadFrom("/export/backup", {
                    query: { scope: `board:${boardId}` },
                  }).catch(toast.error)
                }
              >
                <Download className="size-3.5" aria-hidden />
                {t("board.downloadBackup")}
              </MenuItem>
              <MenuItem
                onSelect={() =>
                  void downloadFrom(`/boards/${boardId}/export.csv`).catch(toast.error)
                }
              >
                <Download className="size-3.5" aria-hidden />
                {t("board.downloadCsv")}
              </MenuItem>
              {canEdit && (
                <MenuItem danger onSelect={() => remove.mutate()}>
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("board.delete")}
                </MenuItem>
              )}
            </Menu>
          </div>
        </div>
        <ProjectTagsContext.Provider value={tagIndex}>
          <BoardCanvas
            name={board.data.name}
            config={config}
            cards={cards.data}
            filters={filters}
            onFilters={setFilters}
            view={view}
            palette={palette}
            interactive={canEdit && !constructorOpen}
            onOpen={(card) => !isPending(card) && setOpened({ id: card.id })}
            onMove={handleMove}
            onQuickAdd={(column, title) => createCard.mutate({ column, title })}
            actions={{
              onAddCard: () => setOpened({ id: null }),
              onExport: () => void exportTemplate(),
              onImport: (file) => void importFile(file),
              onReset: () => reset.mutate(),
            }}
          />
        </ProjectTagsContext.Provider>
      </div>
      {constructorOpen && (
        <ConstructorPanel board={board.data} onClose={() => setConstructorOpen(false)} />
      )}
      {opened && (opened.id === null || openCard) && (
        <CardEditor
          boardId={boardId}
          projectId={board.data.project_id}
          config={board.data.config}
          card={openCard}
          column={opened.column}
          readOnly={!canEdit}
          onClose={() => setOpened(null)}
        />
      )}
      <Modal open={saveView} onOpenChange={setSaveView} title={t("board.saveView")} width={420}>
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            createView.mutate();
          }}
        >
          <TextField
            label={t("board.viewName")}
            required
            autoFocus
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
          />
          <Button type="submit" variant="primary" loading={createView.isPending}>
            {t("common.save")}
          </Button>
        </form>
      </Modal>
      <Modal
        open={saveTemplate}
        onOpenChange={setSaveTemplate}
        title={t("board.saveAsTemplate")}
        width={420}
      >
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            createTemplate.mutate();
          }}
        >
          <TextField
            label={t("ctor.templateName")}
            required
            autoFocus
            value={templateName}
            onChange={(event) => setTemplateName(event.target.value)}
          />
          <Button type="submit" variant="primary" loading={createTemplate.isPending}>
            {t("common.save")}
          </Button>
        </form>
      </Modal>
      {importing && (
        <TemplateImportDialog
          file={importing}
          onClose={() => setImporting(null)}
          confirmLabel={t("common.continue")}
          onConfirm={async (document) => {
            const saved = await api.post<BoardOut>(`/boards/${boardId}/template/apply`, {
              template: document,
              parts: ["theme", "typography", "layout", "structure"],
            });
            queryClient.setQueryData(keys.board(boardId), saved);
            void queryClient.invalidateQueries({ queryKey: keys.cards(boardId) });
            setImporting(null);
          }}
        />
      )}
    </div>
  );
}
