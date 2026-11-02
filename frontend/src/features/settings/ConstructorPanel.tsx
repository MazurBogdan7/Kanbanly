/** Режим «Конструктор»: панель справа, доска слева показывает черновик вживую. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Redo2, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Button,
  ErrorNote,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextField,
  Toggle,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, ApiError, saveJson } from "@/lib/api/client";
import type { BoardConfig, BoardOut, BoardTemplate } from "@/lib/api/types";
import { useHotkeys } from "@/lib/hotkeys";
import { parseTemplateText } from "@/lib/templateFile";

import { keys, useSaveConfig } from "../boards/api";
import { isDirty, useDraft } from "./draft";
import { CardTab, HeaderTab, ThemeTab, TypographyTab } from "./tabs-look";
import { ColumnsTab, DimensionsTab, FieldsTab, RulesTab } from "./tabs-structure";

const PARTS = [
  ["theme", "ctor.partTheme"],
  ["typography", "ctor.partTypography"],
  ["layout", "ctor.partLayout"],
  ["structure", "ctor.partStructure"],
  ["columns", "ctor.partColumns"],
  ["dimensions", "ctor.partDimensions"],
] as const;

function TemplateTab({ board, config }: { board: BoardOut; config: BoardConfig }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const replace = useDraft((state) => state.replace);
  const [name, setName] = useState(board.name);
  const [withCards, setWithCards] = useState(false);
  const [part, setPart] = useState<(typeof PARTS)[number][0]>("theme");
  const fileInput = useRef<HTMLInputElement>(null);

  const save = useMutation({
    mutationFn: () =>
      api.post("/templates/from-board", {
        board_id: board.id,
        name,
        include_cards: withCards,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.templates });
      toast.info(t("board.templateSaved"));
    },
    onError: toast.error,
  });

  const resetToTemplate = useMutation({
    mutationFn: async () => {
      const saved = await api.post<BoardOut>(`/boards/${board.id}/reset`, { cards: false });
      queryClient.setQueryData(keys.board(board.id), saved);
      return saved;
    },
    onSuccess: (saved) => replace(saved.config),
    onError: toast.error,
  });

  const importPart = async (file: File) => {
    const parsed = parseTemplateText(await file.text());
    if (!parsed.ok) {
      toast.info(parsed.problems[0]?.message ?? t("templates.invalid"));
      return;
    }
    try {
      const saved = await api.post<BoardOut>(`/boards/${board.id}/template/apply`, {
        template: parsed.document,
        parts: [part],
      });
      queryClient.setQueryData(keys.board(board.id), saved);
      replace(saved.config);
      useDraft.getState().markSaved(saved.config);
      toast.info(t("ctor.partialDone"));
    } catch (error) {
      toast.error(error);
    }
  };

  const download = () => {
    const document: Partial<BoardTemplate> & BoardConfig = {
      $schema: "https://kanbanly.local/schemas/board-template.v1.json",
      format: "kanbanly.board-template",
      version: 1,
      meta: { name },
      ...config,
    };
    saveJson(document, `${name}.template.json`);
  };

  return (
    <div className="grid gap-4">
      <TextField
        label={t("ctor.templateName")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Toggle label={t("ctor.withCards")} checked={withCards} onChange={setWithCards} />
      <Button onClick={() => save.mutate()} loading={save.isPending}>
        {t("ctor.saveAsTemplate")}
      </Button>
      <Button onClick={download}>{t("ctor.downloadJson")}</Button>
      {board.has_source_template && (
        <Button
          variant="danger"
          onClick={() => resetToTemplate.mutate()}
          loading={resetToTemplate.isPending}
        >
          {t("ctor.resetToTemplate")}
        </Button>
      )}
      <fieldset className="grid gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-xs font-medium text-ink-soft">
          {t("ctor.partialImport")}
        </legend>
        <div className="grid gap-1">
          {PARTS.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="template-part"
                checked={part === value}
                onChange={() => setPart(value)}
              />
              {t(label)}
            </label>
          ))}
        </div>
        <Button onClick={() => fileInput.current?.click()}>{t("templates.upload")}</Button>
        <input
          ref={fileInput}
          type="file"
          accept=".json"
          hidden
          aria-label={t("templates.upload")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importPart(file);
            event.target.value = "";
          }}
        />
      </fieldset>
    </div>
  );
}

export function ConstructorPanel({ board, onClose }: { board: BoardOut; onClose: () => void }) {
  const { t } = useT();
  const { draft, open, close, undo, redo, past, future, markSaved } = useDraft();
  const dirty = useDraft(isDirty);
  const saveConfig = useSaveConfig(board.id);
  const [problems, setProblems] = useState<string[]>([]);

  useEffect(() => {
    open(board.config);
    return close;
    // Черновик открывается один раз: дальше конфигурация меняется только здесь.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useHotkeys({
    "mod+y": redo,
    "mod+shift+z": redo,
  });

  if (!draft) return null;

  const apply = () => {
    setProblems([]);
    saveConfig.mutate(
      { config: draft, version: board.version },
      {
        onSuccess: (saved) => {
          markSaved(saved.config);
          useDraft.setState({ draft: saved.config, saved: JSON.stringify(saved.config) });
          toast.info(t("ctor.applied"));
        },
        onError: (error) => {
          if (error instanceof ApiError && error.problems.length) {
            setProblems(error.problems.map((item) => `${item.path}: ${item.message}`));
          } else {
            toast.error(error);
          }
        },
      },
    );
  };

  return (
    <aside
      aria-label={t("ctor.title")}
      data-testid="constructor"
      className="anim-drawer flex w-full max-w-[420px] shrink-0 flex-col border-l border-line bg-panel max-md:fixed max-md:inset-0 max-md:z-30 max-md:max-w-none"
    >
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("ctor.title")}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("ctor.undo")}
          disabled={!past.length}
          onClick={undo}
        >
          <Undo2 className="size-4" aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("ctor.redo")}
          disabled={!future.length}
          onClick={redo}
        >
          <Redo2 className="size-4" aria-hidden />
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={apply}
          loading={saveConfig.isPending}
          disabled={!dirty}
        >
          {t("ctor.apply")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("ctor.exit")}
          onClick={() => (!dirty || window.confirm(t("ctor.discard"))) && onClose()}
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>
      {problems.length > 0 && (
        <div className="p-3">
          <ErrorNote message={problems.slice(0, 3).join("; ")} />
        </div>
      )}
      <Tabs defaultValue="columns" className="flex min-h-0 flex-1 flex-col">
        <div className="px-3 pt-2">
          <TabsList label={t("ctor.title")}>
            <TabsTrigger value="columns">{t("ctor.tabColumns")}</TabsTrigger>
            <TabsTrigger value="dimensions">{t("ctor.tabDimensions")}</TabsTrigger>
            <TabsTrigger value="fields">{t("ctor.tabFields")}</TabsTrigger>
            <TabsTrigger value="card">{t("ctor.tabCard")}</TabsTrigger>
            <TabsTrigger value="header">{t("ctor.tabHeader")}</TabsTrigger>
            <TabsTrigger value="theme">{t("ctor.tabTheme")}</TabsTrigger>
            <TabsTrigger value="typography">{t("ctor.tabTypography")}</TabsTrigger>
            <TabsTrigger value="rules">{t("ctor.tabRules")}</TabsTrigger>
            <TabsTrigger value="template">{t("ctor.tabTemplate")}</TabsTrigger>
          </TabsList>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <TabsContent value="columns">
            <ColumnsTab config={draft} />
          </TabsContent>
          <TabsContent value="dimensions">
            <DimensionsTab config={draft} />
          </TabsContent>
          <TabsContent value="fields">
            <FieldsTab config={draft} />
          </TabsContent>
          <TabsContent value="card">
            <CardTab config={draft} />
          </TabsContent>
          <TabsContent value="header">
            <HeaderTab config={draft} />
          </TabsContent>
          <TabsContent value="theme">
            <ThemeTab config={draft} />
          </TabsContent>
          <TabsContent value="typography">
            <TypographyTab config={draft} />
          </TabsContent>
          <TabsContent value="rules">
            <RulesTab config={draft} />
          </TabsContent>
          <TabsContent value="template">
            <TemplateTab board={board} config={draft} />
          </TabsContent>
        </div>
      </Tabs>
      {dirty && (
        <p className="border-t border-line px-3 py-1.5 text-xs text-warning">{t("ctor.dirty")}</p>
      )}
    </aside>
  );
}
