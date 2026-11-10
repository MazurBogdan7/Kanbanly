/**
 * Страница документа: просмотр без редактирования, новые версии, описание, теги и комментарии.
 * Содержимое файла не меняется на месте — только загрузкой новой версии, старые остаются в истории.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, Download, History, Pencil, Trash2 } from "lucide-react";
import { lazy, Suspense, useLayoutEffect, useRef, useState, type FormEvent } from "react";

import { Button, cx, ErrorNote, Input, Section, Select, Skeleton, Textarea } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useLocale, useT } from "@/i18n";
import { api, downloadFrom } from "@/lib/api/client";
import type { DocumentCommentOut, DocumentDetail } from "@/lib/api/types";
import { SafeMarkdown, SafeOfficeHtml } from "@/lib/markdown";

import { useMe } from "../auth/session";
import { keys } from "../boards/api";
import {
  contentPath,
  imageUrl,
  formatSize,
  uploadFile,
  useDocument,
  usePreview,
  useTags,
  workspaceKeys,
} from "./api";
import { DropZone, KindIcon } from "./Documents";
import { headingsOf, OutlineBar, OutlineSidebar, type OutlineItem } from "./Outline";
import { TagChip, TagPicker } from "./tags";

const PdfViewer = lazy(() => import("./PdfViewer"));

/** Документ, отрисованный из HTML: после вставки разметки собираем его заголовки. */
function Rendered({
  source,
  onOutline,
  children,
  className,
}: {
  source: string;
  onOutline: (items: OutlineItem[]) => void;
  children: React.ReactNode;
  className: string;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (ref.current) onOutline(headingsOf(ref.current));
  }, [source, onOutline]);
  return (
    <article ref={ref} className={className}>
      {children}
    </article>
  );
}

function Viewer({
  document,
  number,
  onOutline,
}: {
  document: DocumentDetail;
  number: number;
  onOutline: (items: OutlineItem[]) => void;
}) {
  const { t } = useT();
  const preview = usePreview(document.id, number);
  const version = document.versions.find((item) => item.number === number) ?? document.current;
  if (preview.isPending) return <Skeleton className="h-96" />;
  if (preview.isError)
    return <ErrorNote message={t("docs.previewFailed")} onRetry={() => void preview.refetch()} />;
  const data = preview.data;
  switch (data.kind) {
    case "pdf":
      return (
        <Suspense fallback={<Skeleton className="h-96" />}>
          <PdfViewer path={contentPath(document.id, number)} onOutline={onOutline} />
        </Suspense>
      );
    case "image":
      return (
        <img
          src={imageUrl(document.id, number)}
          alt={version.filename}
          className="mx-auto max-h-[80vh] max-w-full rounded-md border border-line"
        />
      );
    case "html":
      return (
        <Rendered
          source={data.html ?? ""}
          onOutline={onOutline}
          className="doc-preview overflow-x-auto rounded-md border border-line bg-white p-6 text-[#111]"
        >
          <SafeOfficeHtml html={data.html ?? ""} />
        </Rendered>
      );
    case "markdown":
      return (
        <Rendered
          source={data.text ?? ""}
          onOutline={onOutline}
          className="rounded-md border border-line bg-panel p-6"
        >
          <SafeMarkdown source={data.text ?? ""} className="prose-card" />
        </Rendered>
      );
    case "text":
      return (
        <pre className="max-h-[80vh] overflow-auto rounded-md border border-line bg-panel p-4 text-sm whitespace-pre-wrap">
          {data.text}
        </pre>
      );
    default:
      return (
        <div className="grid justify-items-center gap-3 rounded-md border border-dashed border-line p-10 text-center">
          <KindIcon kind={version.kind} className="size-10 text-ink-soft" />
          <p className="text-sm text-ink-soft">
            {data.reason === "unsafe_archive" || data.reason === "too_large"
              ? t("docs.noPreviewLarge")
              : t("docs.noPreview")}
          </p>
          <Button
            onClick={() => void downloadFrom(contentPath(document.id, number)).catch(toast.error)}
          >
            <Download className="size-4" aria-hidden />
            {t("docs.download")}
          </Button>
        </div>
      );
  }
}

function MetaEditor({ document, onDone }: { document: DocumentDetail; onDone: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(document.name);
  const [description, setDescription] = useState(document.description);
  const [tags, setTags] = useState<string[]>(document.tags);
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/documents/${document.id}`, {
        name: name.trim() || document.name,
        description,
        tags,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.document(document.id) });
      void queryClient.invalidateQueries({
        queryKey: workspaceKeys.documents(document.project_id),
      });
      onDone();
    },
    onError: toast.error,
  });
  return (
    <form
      className="grid gap-3"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{t("common.name")}</span>
        <Input value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-medium">{t("common.description")}</span>
        <Textarea
          value={description}
          maxLength={20000}
          placeholder={t("docs.descriptionHint")}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <div className="grid gap-1 text-sm">
        <span className="font-medium">{t("tags.title")}</span>
        <TagPicker projectId={document.project_id} value={tags} onChange={setTags} />
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{t("common.cancel")}</Button>
        <Button type="submit" variant="primary" loading={save.isPending}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  );
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

function Comment({
  comment,
  canEdit,
  canDelete,
  onChanged,
}: {
  comment: DocumentCommentOut;
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const { t } = useT();
  const locale = useLocale((state) => state.locale);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const update = useMutation({
    mutationFn: () => api.patch(`/document-comments/${comment.id}`, { body }),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/document-comments/${comment.id}`),
    onSuccess: onChanged,
    onError: toast.error,
  });
  const edited = comment.updated_at !== comment.created_at;
  return (
    <li className="flex gap-2" data-testid="document-comment">
      <span
        className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-soft text-xs font-semibold text-ink"
        aria-hidden
      >
        {initials(comment.author_name)}
      </span>
      <div className="grid min-w-0 flex-1 gap-1 rounded-md bg-raised p-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-2">
          <p className="text-xs">
            <span className="font-semibold">{comment.author_name || t("docs.formerMember")}</span>
            <span className="text-ink-soft">
              {" · "}
              {new Date(comment.created_at).toLocaleString(locale)}
              {edited && ` · ${t("docs.edited")}`}
            </span>
          </p>
          {!editing && (canEdit || canDelete) && (
            <div className="flex gap-1">
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("docs.editComment")}
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="size-3" aria-hidden />
                </Button>
              )}
              {canDelete && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("docs.deleteComment")}
                  loading={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  <Trash2 className="size-3" aria-hidden />
                </Button>
              )}
            </div>
          )}
        </div>
        {editing ? (
          <div className="grid gap-2">
            <Textarea
              aria-label={t("docs.editComment")}
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" onClick={() => setEditing(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={update.isPending}
                onClick={() => update.mutate()}
              >
                {t("common.save")}
              </Button>
            </div>
          </div>
        ) : (
          <SafeMarkdown source={comment.body} className="prose-card text-sm" />
        )}
      </div>
    </li>
  );
}

function Comments({ document }: { document: DocumentDetail }) {
  const { t } = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.document(document.id) });
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.documents(document.project_id) });
  };
  const add = useMutation({
    mutationFn: () => api.post(`/documents/${document.id}/comments`, { body }),
    onSuccess: () => {
      setBody("");
      refresh();
    },
    onError: toast.error,
  });
  const canWrite = document.role !== "viewer";
  return (
    <Section title={`${t("card.comments")} · ${document.comments.length}`}>
      <ul className="grid gap-2">
        {document.comments.map((comment) => {
          const mine = !!me.data && comment.author_id === me.data.id;
          return (
            <Comment
              key={comment.id}
              comment={comment}
              canEdit={mine}
              canDelete={mine || document.role === "owner"}
              onChanged={refresh}
            />
          );
        })}
      </ul>
      {canWrite && (
        <form
          className="grid gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (body.trim()) add.mutate();
          }}
        >
          <Textarea
            aria-label={t("card.addComment")}
            placeholder={t("card.addComment")}
            value={body}
            maxLength={20000}
            onChange={(event) => setBody(event.target.value)}
          />
          <Button
            type="submit"
            className="justify-self-end"
            loading={add.isPending}
            disabled={!body.trim()}
          >
            {t("card.send")}
          </Button>
        </form>
      )}
    </Section>
  );
}

export function DocumentPage() {
  const { t } = useT();
  const locale = useLocale((state) => state.locale);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const document = useDocument(documentId);
  const tags = useTags(document.data?.project_id);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  // Содержание показывается, когда в документе нашлось хотя бы два раздела.
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const hasOutline = outline.length >= 2;
  const newVersion = useMutation({
    mutationFn: (file: File) =>
      uploadFile<DocumentDetail>(`/documents/${documentId}/versions`, file),
    // Загрузка документа, начатая раньше (например, после правки описания), иначе вернёт
    // прежнюю версию поверх только что загруженной.
    onMutate: () =>
      queryClient.cancelQueries({ queryKey: workspaceKeys.document(documentId), exact: true }),
    onSuccess: async (detail) => {
      await queryClient.cancelQueries({
        queryKey: workspaceKeys.document(documentId),
        exact: true,
      });
      queryClient.setQueryData(workspaceKeys.document(documentId), detail);
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.documents(detail.project_id) });
      setSelected(null);
      toast.info(t("docs.versionUploaded", { number: detail.current.number }));
    },
    onError: toast.error,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/documents/${documentId}`),
    onSuccess: () => {
      const projectId = document.data?.project_id ?? "";
      void queryClient.invalidateQueries({ queryKey: workspaceKeys.documents(projectId) });
      void queryClient.invalidateQueries({ queryKey: keys.trash });
      toast.info(t("docs.deleted"), {
        label: t("common.undo"),
        run: () => {
          void api.post(`/documents/${documentId}/restore`).then(() => {
            void queryClient.invalidateQueries({ queryKey: workspaceKeys.documents(projectId) });
          });
        },
      });
      void navigate({ to: "/projects/$projectId", params: { projectId } });
    },
    onError: toast.error,
  });

  if (document.isPending) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (document.isError || !document.data) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <ErrorNote message={t("docs.notFound")} onRetry={() => void document.refetch()} />
      </div>
    );
  }
  const data = document.data;
  const number = selected ?? data.current.number;
  const version = data.versions.find((item) => item.number === number) ?? data.current;
  const canEdit = data.role !== "viewer";
  const tagIndex = new Map((tags.data ?? []).map((tag) => [tag.id, tag]));
  const download = (n: number) => void downloadFrom(contentPath(data.id, n)).catch(toast.error);

  return (
    <div
      className={cx(
        "mx-auto grid w-full gap-6 p-4 md:p-8",
        hasOutline ? "max-w-[1680px]" : "max-w-7xl",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/projects/$projectId"
            params={{ projectId: data.project_id }}
            className="grid size-8 place-items-center rounded-sm hover:bg-raised"
            aria-label={t("docs.backToProject")}
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
          <KindIcon kind={version.kind} className="text-ink-soft" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold">{data.name}</h1>
            <p className="truncate text-xs text-ink-soft">
              {version.filename} · {formatSize(version.size)} · {t("docs.readOnly")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.versions.length > 1 && (
            <Select
              aria-label={t("docs.versions")}
              value={number}
              onChange={(event) => {
                setOutline([]);
                setSelected(Number(event.target.value));
              }}
              className="h-9 w-auto"
            >
              {data.versions.map((item) => (
                <option key={item.number} value={item.number}>
                  {t("docs.versionShort", { number: item.number })}
                  {item.number === data.current.number ? ` · ${t("docs.current")}` : ""}
                </option>
              ))}
            </Select>
          )}
          <Button onClick={() => download(number)}>
            <Download className="size-4" aria-hidden />
            {t("docs.download")}
          </Button>
          {canEdit && (
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
              <Trash2 className="size-4" aria-hidden />
              <span className="sr-only sm:not-sr-only">{t("common.delete")}</span>
            </Button>
          )}
        </div>
      </div>

      <div
        className={cx(
          "grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]",
          hasOutline && "xl:grid-cols-[260px_minmax(0,1fr)_320px]",
        )}
      >
        {hasOutline && (
          <aside className="hidden xl:block">
            <OutlineSidebar items={outline} />
          </aside>
        )}
        <div className="min-w-0" data-testid="document-viewer">
          {hasOutline && (
            <div className="xl:hidden">
              <OutlineBar items={outline} />
            </div>
          )}
          {number !== data.current.number && (
            <p className="mb-3 rounded-md bg-warning/15 px-3 py-2 text-sm">
              {t("docs.oldVersion", { number, current: data.current.number })}
            </p>
          )}
          <Viewer key={number} document={data} number={number} onOutline={setOutline} />
        </div>

        <aside className="grid content-start gap-6">
          <Section
            title={t("docs.about")}
            action={
              canEdit && !editing ? (
                <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" aria-hidden />
                  {t("docs.editInfo")}
                </Button>
              ) : null
            }
          >
            {editing ? (
              <MetaEditor document={data} onDone={() => setEditing(false)} />
            ) : (
              <div className="grid gap-2">
                {data.description ? (
                  <SafeMarkdown source={data.description} className="prose-card text-sm" />
                ) : (
                  <p className="text-sm text-ink-soft">{t("docs.noDescription")}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {data.tags.map((id) => {
                    const tag = tagIndex.get(id);
                    return tag ? <TagChip key={id} tag={tag} /> : null;
                  })}
                </div>
              </div>
            )}
          </Section>

          {canEdit && (
            <Section title={t("docs.newVersion")} description={t("docs.newVersionHint")}>
              <DropZone
                multiple={false}
                busy={newVersion.isPending}
                label={t("docs.uploadVersion")}
                onFiles={([file]) => file && newVersion.mutate(file)}
              />
            </Section>
          )}

          <Section title={t("docs.versions")}>
            <ol className="grid gap-1.5" data-testid="document-versions">
              {data.versions.map((item) => (
                <li key={item.number} className="flex items-center gap-2 text-sm">
                  <History className="size-3.5 shrink-0 text-ink-soft" aria-hidden />
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left hover:underline ${item.number === number ? "font-semibold" : ""}`}
                    onClick={() => setSelected(item.number)}
                  >
                    {t("docs.versionShort", { number: item.number })} · {item.filename}
                  </button>
                  <span
                    className="shrink-0 text-xs text-ink-soft"
                    title={new Date(item.created_at).toLocaleString(locale)}
                  >
                    {item.uploader_name} · {new Date(item.created_at).toLocaleDateString(locale)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`${t("docs.download")}: ${item.filename}`}
                    onClick={() => download(item.number)}
                  >
                    <Download className="size-3.5" aria-hidden />
                  </Button>
                </li>
              ))}
            </ol>
          </Section>

          <Comments document={data} />
        </aside>
      </div>
    </div>
  );
}
