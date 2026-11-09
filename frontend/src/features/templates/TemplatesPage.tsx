import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Copy, Download, FileJson, MoreHorizontal, Pencil, Trash2, Upload } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";

import {
  Button,
  EmptyState,
  Menu,
  MenuItem,
  Modal,
  Section,
  SelectField,
  Skeleton,
  TextField,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, downloadFrom, saveJson } from "@/lib/api/client";
import type { BoardOut, BoardTemplate, Page, PresetOut, TemplateOut } from "@/lib/api/types";

import { keys, useProjects } from "../boards/api";
import { deleteTemplate, TemplateImportDialog, uploadTemplate } from "./TemplateImportDialog";
import { TemplateThumbnail } from "./TemplateThumbnail";

export function usePresets() {
  return useQuery({
    queryKey: keys.presets,
    queryFn: () => api.get<PresetOut[]>("/presets"),
    staleTime: Infinity,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: keys.templates,
    queryFn: () => api.get<Page<TemplateOut>>("/templates", { limit: 200 }),
    select: (page) => page.items,
  });
}

function UseTemplateDialog({
  template,
  onClose,
}: {
  template: BoardTemplate;
  onClose: () => void;
}) {
  const { t } = useT();
  const navigate = useNavigate();
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const [name, setName] = useState(template.meta.name);
  const selected = projectId || projects.data?.[0]?.id || "";
  const create = useMutation({
    mutationFn: () => api.post<BoardOut>(`/projects/${selected}/boards`, { name, template }),
    onSuccess: (board) => void navigate({ to: "/boards/$boardId", params: { boardId: board.id } }),
    onError: toast.error,
  });
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("templates.useTemplate")}
      width={420}
    >
      <form
        className="grid gap-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <SelectField
          label={t("templates.pickProject")}
          required
          value={selected}
          onChange={(event) => setProjectId(event.target.value)}
        >
          {projects.data?.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t("wizard.boardName")}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" variant="primary" disabled={!selected} loading={create.isPending}>
          {t("common.create")}
        </Button>
      </form>
    </Modal>
  );
}

function TemplateCard({
  template,
  onUse,
  menu,
}: {
  template: BoardTemplate;
  onUse: () => void;
  menu?: React.ReactNode;
}) {
  const { t } = useT();
  return (
    <article
      className="grid min-w-0 content-start gap-2 rounded-lg border border-line bg-panel p-3"
      data-template={template.meta.name}
    >
      <TemplateThumbnail template={template} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{template.meta.name}</h3>
          {template.meta.description && (
            <p className="line-clamp-2 text-xs text-ink-soft">{template.meta.description}</p>
          )}
        </div>
        {menu}
      </div>
      <Button size="sm" onClick={onUse}>
        {t("templates.useTemplate")}
      </Button>
    </article>
  );
}

function Gallery({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr))]">
      {children}
    </div>
  );
}

export function TemplatesPage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const presets = usePresets();
  const templates = useTemplates();
  const [using, setUsing] = useState<BoardTemplate | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [renaming, setRenaming] = useState<TemplateOut | null>(null);
  const [newName, setNewName] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: keys.templates });

  const duplicate = useMutation({
    mutationFn: (id: string) => api.post(`/templates/${id}/duplicate`),
    onSuccess: refresh,
    onError: toast.error,
  });
  const rename = useMutation({
    mutationFn: () => api.patch(`/templates/${renaming?.id}`, { name: newName }),
    onSuccess: () => {
      refresh();
      setRenaming(null);
    },
    onError: toast.error,
  });
  const remove = (template: TemplateOut) => {
    deleteTemplate(template.id)
      .then(() => {
        refresh();
        toast.info(t("templates.deleted"), {
          label: t("common.undo"),
          run: () => void api.post(`/templates/${template.id}/restore`).then(refresh),
        });
      })
      .catch(toast.error);
  };

  return (
    <div
      className="mx-auto grid w-full max-w-7xl gap-8 p-4 md:p-8"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const dropped = event.dataTransfer.files[0];
        if (dropped) setFile(dropped);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("templates.title")}</h1>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void downloadFrom("/templates/example").catch(toast.error)}>
            <FileJson className="size-4" aria-hidden />
            {t("templates.example")}
          </Button>
          <Button variant="primary" onClick={() => input.current?.click()}>
            <Upload className="size-4" aria-hidden />
            {t("templates.upload")}
          </Button>
          <input
            ref={input}
            type="file"
            accept=".json"
            hidden
            aria-label={t("templates.upload")}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) setFile(selected);
              event.target.value = "";
            }}
          />
        </div>
      </div>
      <Section title={t("templates.presets")}>
        {presets.isPending ? (
          <Skeleton className="h-64" />
        ) : (
          <Gallery>
            {presets.data?.map((preset) => (
              <TemplateCard
                key={preset.key}
                template={preset.data}
                onUse={() => setUsing(preset.data)}
              />
            ))}
          </Gallery>
        )}
      </Section>
      <Section title={t("templates.mine")}>
        {templates.data?.length === 0 ? (
          <EmptyState title={t("templates.empty")} />
        ) : (
          <Gallery>
            {templates.data?.map((template) => (
              <TemplateCard
                key={template.id}
                template={template.data}
                onUse={() => setUsing(template.data)}
                menu={
                  <Menu
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("templates.menu", { name: template.name })}
                      >
                        <MoreHorizontal className="size-4" aria-hidden />
                      </Button>
                    }
                  >
                    <MenuItem
                      onSelect={() => {
                        setNewName(template.name);
                        setRenaming(template);
                      }}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                      {t("common.rename")}
                    </MenuItem>
                    <MenuItem onSelect={() => duplicate.mutate(template.id)}>
                      <Copy className="size-3.5" aria-hidden />
                      {t("common.duplicate")}
                    </MenuItem>
                    <MenuItem
                      onSelect={() => saveJson(template.data, `${template.name}.template.json`)}
                    >
                      <Download className="size-3.5" aria-hidden />
                      {t("common.download")}
                    </MenuItem>
                    <MenuItem danger onSelect={() => remove(template)}>
                      <Trash2 className="size-3.5" aria-hidden />
                      {t("common.delete")}
                    </MenuItem>
                  </Menu>
                }
              />
            ))}
          </Gallery>
        )}
      </Section>
      {using && <UseTemplateDialog template={using} onClose={() => setUsing(null)} />}
      {file && (
        <TemplateImportDialog
          file={file}
          onClose={() => setFile(null)}
          confirmLabel={t("templates.upload")}
          onConfirm={async (_document, raw) => {
            await uploadTemplate(raw);
            refresh();
            toast.info(t("templates.imported"));
            setFile(null);
          }}
        />
      )}
      <Modal
        open={!!renaming}
        onOpenChange={() => setRenaming(null)}
        title={t("common.rename")}
        width={420}
      >
        <form
          className="grid gap-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <TextField
            label={t("common.name")}
            required
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button type="submit" variant="primary" loading={rename.isPending}>
            {t("common.save")}
          </Button>
        </form>
      </Modal>
    </div>
  );
}
