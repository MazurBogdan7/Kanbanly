import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Download, MoreHorizontal, Plus } from "lucide-react";
import { useState } from "react";

import { Button, EmptyState, ErrorNote, Menu, MenuItem, Skeleton } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, downloadFrom } from "@/lib/api/client";

import { keys, useProject } from "../boards/api";
import { ProjectDocuments } from "../workspace/Documents";
import { ProjectTags } from "../workspace/tags";
import { BoardTile } from "./HomePage";
import { ProjectMembers } from "./Members";
import { NewBoardWizard } from "./NewBoardWizard";

export function ProjectPage() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const project = useProject(projectId);
  const [wizard, setWizard] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.delete(`/projects/${projectId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void queryClient.invalidateQueries({ queryKey: keys.trash });
      toast.info(t("project.deleted"), {
        label: t("common.undo"),
        run: () => {
          void api.post(`/projects/${projectId}/restore`).then(() => {
            void queryClient.invalidateQueries({ queryKey: keys.projects });
          });
        },
      });
      void navigate({ to: "/" });
    },
    onError: toast.error,
  });
  if (project.isPending) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (project.isError || !project.data) {
    return (
      <div className="mx-auto max-w-5xl p-8">
        <ErrorNote message={t("common.error")} onRetry={() => void project.refetch()} />
      </div>
    );
  }
  const boards = project.data.boards ?? [];
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 p-4 md:p-8">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{project.data.name}</h1>
          <p className="text-sm text-ink-soft">{t("project.boards")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => setWizard(true)}>
            <Plus className="size-4" aria-hidden />
            {t("project.newBoard")}
          </Button>
          <Menu
            trigger={
              <Button variant="ghost" size="icon" aria-label={t("project.actions")}>
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            }
          >
            <MenuItem
              onSelect={() =>
                void downloadFrom("/export/backup", {
                  query: { scope: `project:${projectId}` },
                }).catch(toast.error)
              }
            >
              <Download className="size-3.5" aria-hidden />
              {t("project.download")}
            </MenuItem>
            <MenuItem
              onSelect={() =>
                void downloadFrom("/export/csv", {
                  query: { scope: `project:${projectId}` },
                }).catch(toast.error)
              }
            >
              <Download className="size-3.5" aria-hidden />
              {t("project.downloadTables")}
            </MenuItem>
            {project.data.role === "owner" && (
              <MenuItem danger onSelect={() => remove.mutate()}>
                {t("project.delete")}
              </MenuItem>
            )}
          </Menu>
        </div>
      </div>
      {boards.length === 0 ? (
        <EmptyState
          title={t("project.empty")}
          action={
            <Button variant="primary" onClick={() => setWizard(true)}>
              {t("project.emptyCta")}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          {boards.map((board) => (
            <BoardTile key={board.id} board={board} />
          ))}
        </div>
      )}
      <ProjectDocuments projectId={projectId} canEdit={project.data.role !== "viewer"} />
      <ProjectTags projectId={projectId} canEdit={project.data.role !== "viewer"} />
      <ProjectMembers project={project.data} />
      {wizard && <NewBoardWizard projectId={projectId} onClose={() => setWizard(false)} />}
    </div>
  );
}
