import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, Star } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  Button,
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
import type { BoardSummary, ProjectOut } from "@/lib/api/types";

import { keys, useProjects } from "../boards/api";

export function BoardTile({ board }: { board: BoardSummary }) {
  const { plural } = useT();
  const colors = board.colors;
  return (
    <Link
      to="/boards/$boardId"
      params={{ boardId: board.id }}
      className="group grid gap-2 rounded-md border border-line bg-panel p-2 transition-shadow duration-[var(--dur-base)] hover:shadow-panel"
    >
      <div
        aria-hidden
        className="flex h-16 gap-1 overflow-hidden rounded-sm p-1.5"
        style={{ background: colors.bg }}
      >
        {[0.9, 0.6, 0.4].map((height) => (
          <span
            key={height}
            className="flex-1 rounded-sm"
            style={{
              background: colors.surface,
              border: `1px solid ${colors.border}`,
              height: `${height * 100}%`,
            }}
          >
            <span className="m-1 block h-1 rounded-sm" style={{ background: colors.accent }} />
          </span>
        ))}
      </div>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="truncate text-sm font-medium">{board.name}</span>
        {board.is_favorite && <Star className="size-3.5 shrink-0 text-warning" aria-hidden />}
      </div>
      <span className="px-1 text-xs text-ink-soft">{plural("plural.cards", board.card_count)}</span>
    </Link>
  );
}

function ProjectCard({ project }: { project: ProjectOut }) {
  const { plural } = useT();
  return (
    <article className="grid gap-3 rounded-lg border border-line bg-panel p-4">
      <div className="flex items-start justify-between gap-2">
        <Link
          to="/projects/$projectId"
          params={{ projectId: project.id }}
          className="truncate text-base font-semibold hover:text-brand"
        >
          {project.name}
        </Link>
        <span className="shrink-0 text-xs text-ink-soft">
          {plural("plural.boards", project.boards?.length ?? 0)}
        </span>
      </div>
      {(project.boards?.length ?? 0) > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {project.boards?.slice(0, 4).map((board) => (
            <BoardTile key={board.id} board={board} />
          ))}
        </div>
      )}
    </article>
  );
}

export function HomePage() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: () => api.post<ProjectOut>("/projects", { name }),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      setCreating(false);
      setName("");
      void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
    onError: toast.error,
  });
  const boards = (projects.data ?? []).flatMap((project) => project.boards ?? []);
  const favorites = boards.filter((board) => board.is_favorite);
  const recent = boards
    .filter((board) => board.last_opened_at)
    .sort((a, b) => ((a.last_opened_at ?? "") < (b.last_opened_at ?? "") ? 1 : -1))
    .slice(0, 4);
  return (
    <div className="mx-auto grid max-w-6xl gap-8 p-4 md:p-8">
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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {favorites.map((board) => (
              <BoardTile key={board.id} board={board} />
            ))}
          </div>
        </Section>
      )}
      {recent.length > 0 && (
        <Section title={t("home.recent")}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
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
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {projects.data?.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
      <Modal open={creating} onOpenChange={setCreating} title={t("home.newProject")} width={420}>
        <form
          className="grid gap-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <TextField
            label={t("home.projectName")}
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="primary" loading={create.isPending}>
            {t("common.create")}
          </Button>
        </form>
      </Modal>
    </div>
  );
}
