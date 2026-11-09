import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ChevronDown, FolderKanban, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  Button,
  cx,
  EmptyState,
  ErrorNote,
  Modal,
  Section,
  Skeleton,
  TextField,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api } from "@/lib/api/client";
import type { ProjectOut } from "@/lib/api/types";

import { keys, useProjects } from "../boards/api";
import { BoardTile, TILE_GRID } from "./BoardTile";
import { BoardFilePicker, fileStem, importBoardFile, reportImport } from "./boardImport";

export { BoardTile } from "./BoardTile";

const EXPANDED_KEY = "kanbanly-home-expanded";

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeExpanded(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...ids]));
  } catch {
    // Без хранилища раскрытие просто не запоминается.
  }
}

function ProjectCard({
  project,
  expanded,
  onToggle,
}: {
  project: ProjectOut;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, plural } = useT();
  const boards = project.boards ?? [];
  const cards = boards.reduce((sum, board) => sum + board.card_count, 0);
  const listId = `project-boards-${project.id}`;
  return (
    <article
      data-testid="project-card"
      className={cx(
        "flex flex-col gap-3 rounded-lg border border-line bg-panel p-4",
        expanded && "col-span-full",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="grid size-10 shrink-0 place-items-center rounded-md bg-brand-soft text-brand"
        >
          <FolderKanban className="size-5" />
        </span>
        {/* Длинное название переносится на вторую строку, а не наезжает на кнопки. */}
        <h2
          className="line-clamp-2 min-w-0 flex-1 self-center text-base font-semibold leading-snug [overflow-wrap:anywhere]"
          title={project.name}
        >
          <Link
            to="/projects/$projectId"
            params={{ projectId: project.id }}
            className="hover:text-brand"
          >
            {project.name}
          </Link>
        </h2>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-label={t(expanded ? "home.hideBoards" : "home.showBoards", { name: project.name })}
          title={t(expanded ? "home.hideBoards" : "home.showBoards", { name: project.name })}
          onClick={onToggle}
          className="grid size-8 shrink-0 place-items-center rounded-md border border-line hover:border-line-strong hover:bg-raised"
        >
          <ChevronDown
            className={cx(
              "size-4 transition-transform duration-[var(--dur-base)]",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-ink-soft">
          {plural("plural.boards", boards.length)} · {plural("plural.cards", cards)}
        </p>
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          aria-label={t("home.openProjectNamed", { name: project.name })}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-line px-2.5 text-sm font-medium hover:border-line-strong hover:bg-raised"
        >
          {t("home.openProject")}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
      {expanded && (
        <div id={listId}>
          {boards.length === 0 ? (
            <p className="text-sm text-ink-soft">{t("project.empty")}</p>
          ) : (
            <div className={TILE_GRID}>
              {boards.map((board) => (
                <BoardTile key={board.id} board={board} />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const create = useMutation({
    mutationFn: async () => {
      const project = await api.post<ProjectOut>("/projects", {
        name: name.trim() || (file ? fileStem(file.name) : ""),
      });
      if (!file) return { project, result: null };
      try {
        return { project, result: await importBoardFile(project.id, file) };
      } catch (error) {
        // Проект уже создан: открываем его, чтобы можно было попробовать другой файл.
        toast.error(error);
        return { project, result: null };
      }
    },
    onSuccess: ({ project, result }) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      onClose();
      const [first] = result?.boards ?? [];
      if (result) reportImport(t, result);
      if (result?.boards.length === 1 && first) {
        void navigate({ to: "/boards/$boardId", params: { boardId: first.id } });
      } else {
        void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
      }
    },
    onError: toast.error,
  });
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("home.newProject")}
      width={480}
    >
      <form
        className="grid gap-4"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <TextField
          label={t("home.projectName")}
          autoFocus
          required={!file}
          maxLength={200}
          placeholder={file ? fileStem(file.name) : undefined}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <BoardFilePicker file={file} onFile={setFile} optional />
        <Button type="submit" variant="primary" loading={create.isPending}>
          {file ? t("home.createAndImport") : t("common.create")}
        </Button>
      </form>
    </Modal>
  );
}

export function HomePage() {
  const { t } = useT();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeExpanded(next);
      return next;
    });
  const boards = (projects.data ?? []).flatMap((project) => project.boards ?? []);
  const favorites = boards.filter((board) => board.is_favorite);
  const recent = boards
    .filter((board) => board.last_opened_at)
    .sort((a, b) => ((a.last_opened_at ?? "") < (b.last_opened_at ?? "") ? 1 : -1))
    .slice(0, 4);
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-8 p-4 md:p-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("home.title")}</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" aria-hidden />
          {t("home.newProject")}
        </Button>
      </div>
      {projects.isPending && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-44" />
          ))}
        </div>
      )}
      {projects.isError && (
        <ErrorNote message={t("common.error")} onRetry={() => void projects.refetch()} />
      )}
      {favorites.length > 0 && (
        <Section title={t("home.favorites")}>
          <div className={TILE_GRID}>
            {favorites.map((board) => (
              <BoardTile key={board.id} board={board} />
            ))}
          </div>
        </Section>
      )}
      {recent.length > 0 && (
        <Section title={t("home.recent")}>
          <div className={TILE_GRID}>
            {recent.map((board) => (
              <BoardTile key={board.id} board={board} />
            ))}
          </div>
        </Section>
      )}
      {projects.data?.length === 0 && (
        <EmptyState
          title={t("home.empty")}
          hint={t("home.emptyHint")}
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t("home.newProject")}
            </Button>
          }
        />
      )}
      {(projects.data?.length ?? 0) > 0 && (
        <Section title={t("home.projects")}>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr))]">
            {projects.data?.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                expanded={expanded.has(project.id)}
                onToggle={() => toggle(project.id)}
              />
            ))}
          </div>
        </Section>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
