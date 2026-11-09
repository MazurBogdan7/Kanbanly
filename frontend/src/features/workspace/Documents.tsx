/** Документы проекта: ТЗ, диздок, пояснительная записка и любые файлы с общим контекстом. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  File as FileIcon,
  MessageSquare,
  Upload,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button, cx, Section, Skeleton } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useLocale, useT } from "@/i18n";
import type { DocumentDetail, DocumentOut } from "@/lib/api/types";

import { formatSize, uploadFile, useDocuments, useTags, workspaceKeys } from "./api";
import { TagChip } from "./tags";

export const ACCEPT =
  ".pdf,.docx,.xlsx,.txt,.md,.markdown,.csv,.json,.yaml,.yml,.xml,.log,.png,.jpg,.jpeg,.gif,.webp,*/*";

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const props = { className: cx("size-5 shrink-0", className), "aria-hidden": true } as const;
  if (kind === "pdf") return <FileType2 {...props} />;
  if (kind === "xlsx") return <FileSpreadsheet {...props} />;
  if (["png", "jpeg", "gif", "webp"].includes(kind)) return <FileImage {...props} />;
  if (["docx", "text", "markdown"].includes(kind)) return <FileText {...props} />;
  return <FileIcon {...props} />;
}

/** Зона загрузки: кнопка выбора файла и перетаскивание. */
export function DropZone({
  onFiles,
  busy,
  label,
  multiple = true,
}: {
  onFiles: (files: File[]) => void;
  busy: boolean;
  label: string;
  multiple?: boolean;
}) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
  };
  return (
    <div
      className={cx(
        "flex flex-wrap items-center justify-center gap-3 rounded-md border-2 border-dashed px-4 py-5 text-center text-sm text-ink-soft transition-colors",
        over ? "border-brand bg-brand-soft" : "border-line",
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      <span>{t("docs.dropHint")}</span>
      <Button loading={busy} onClick={() => input.current?.click()}>
        <Upload className="size-4" aria-hidden />
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        multiple={multiple}
        accept={ACCEPT}
        data-testid="file-input"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
    </div>
  );
}

function DocumentRow({
  document,
  tagIndex,
}: {
  document: DocumentOut;
  tagIndex: Map<string, { name: string; color: string }>;
}) {
  const { t } = useT();
  const locale = useLocale((state) => state.locale);
  return (
    <li>
      <Link
        to="/documents/$documentId"
        params={{ documentId: document.id }}
        className="flex items-start gap-3 rounded-md border border-line bg-panel p-3 transition-colors hover:border-ink-soft"
      >
        <KindIcon kind={document.current.kind} className="mt-0.5 text-ink-soft" />
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="truncate font-medium">{document.name}</span>
            <span className="text-xs text-ink-soft">
              {t("docs.versionShort", { number: document.versions_count })} ·{" "}
              {formatSize(document.current.size)} ·{" "}
              {new Date(document.updated_at).toLocaleDateString(locale)}
            </span>
          </div>
          {document.description && (
            <p className="line-clamp-2 text-sm text-ink-soft">{document.description}</p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            {document.tags.map((id) => {
              const tag = tagIndex.get(id);
              return tag ? <TagChip key={id} tag={tag} /> : null;
            })}
            {document.comments_count > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-ink-soft">
                <MessageSquare className="size-3.5" aria-hidden />
                {document.comments_count}
              </span>
            )}
          </div>
        </div>
      </Link>
    </li>
  );
}

export function ProjectDocuments({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const documents = useDocuments(projectId);
  const tags = useTags(projectId);
  const [filter, setFilter] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        await uploadFile<DocumentDetail>(`/projects/${projectId}/documents`, file);
      }
      return files.length;
    },
    onSuccess: (count) => toast.info(t("docs.uploaded", { count })),
    onError: toast.error,
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.documents(projectId) }),
  });
  const tagIndex = new Map((tags.data ?? []).map((tag) => [tag.id, tag]));
  const items = (documents.data ?? []).filter((item) => !filter || item.tags.includes(filter));
  const usedTags = (tags.data ?? []).filter((tag) =>
    (documents.data ?? []).some((item) => item.tags.includes(tag.id)),
  );
  return (
    <Section title={t("docs.title")} description={t("docs.hint")}>
      <div className="grid gap-3" data-testid="project-documents">
        {canEdit && (
          <DropZone
            onFiles={(files) => upload.mutate(files)}
            busy={upload.isPending}
            label={t("docs.upload")}
          />
        )}
        {usedTags.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label={t("docs.filter")}
          >
            <Button
              size="sm"
              variant={filter ? "ghost" : "secondary"}
              aria-pressed={!filter}
              onClick={() => setFilter(null)}
            >
              {t("docs.all")}
            </Button>
            {usedTags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                aria-pressed={filter === tag.id}
                className={cx(
                  "rounded-full",
                  filter === tag.id && "ring-2 ring-brand ring-offset-1 ring-offset-panel",
                )}
                onClick={() => setFilter(filter === tag.id ? null : tag.id)}
              >
                <TagChip tag={tag} />
              </button>
            ))}
          </div>
        )}
        {documents.isPending ? (
          <Skeleton className="h-20" />
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-soft">{t("docs.empty")}</p>
        ) : (
          <ul className="grid gap-2">
            {items.map((document) => (
              <DocumentRow key={document.id} document={document} tagIndex={tagIndex} />
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
