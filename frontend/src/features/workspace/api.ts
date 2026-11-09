/** Теги проекта и документы: запросы и кэш. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/toast";
import { api, send } from "@/lib/api/client";
import type { DocumentDetail, DocumentOut, DocumentPreview, TagOut } from "@/lib/api/types";

export const workspaceKeys = {
  tags: (projectId: string) => ["projects", projectId, "tags"] as const,
  documents: (projectId: string) => ["projects", projectId, "documents"] as const,
  document: (id: string) => ["documents", id] as const,
  preview: (id: string, number: number) => ["documents", id, "preview", number] as const,
};

export function useTags(projectId: string | undefined) {
  return useQuery({
    queryKey: workspaceKeys.tags(projectId ?? ""),
    queryFn: () => api.get<TagOut[]>(`/projects/${projectId}/tags`),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useTagMutations(projectId: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.tags(projectId) });
    // Удалённый тег пропадает с карточек и документов: перечитываем их.
    void queryClient.invalidateQueries({ queryKey: ["boards"] });
    void queryClient.invalidateQueries({ queryKey: ["documents"] });
    void queryClient.invalidateQueries({ queryKey: workspaceKeys.documents(projectId) });
  };
  const options = { onSuccess: refresh, onError: toast.error };
  return {
    create: useMutation({
      mutationFn: (tag: { name: string; color: string }) =>
        api.post<TagOut>(`/projects/${projectId}/tags`, tag),
      ...options,
    }),
    update: useMutation({
      mutationFn: ({ id, ...patch }: { id: string; name?: string; color?: string }) =>
        api.patch<TagOut>(`/tags/${id}`, patch),
      ...options,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.delete(`/tags/${id}`),
      ...options,
    }),
  };
}

export function useDocuments(projectId: string) {
  return useQuery({
    queryKey: workspaceKeys.documents(projectId),
    queryFn: () => api.get<DocumentOut[]>(`/projects/${projectId}/documents`),
  });
}

export function useDocument(id: string) {
  return useQuery({
    queryKey: workspaceKeys.document(id),
    queryFn: () => api.get<DocumentDetail>(`/documents/${id}`),
  });
}

export function usePreview(id: string, number: number) {
  return useQuery({
    queryKey: workspaceKeys.preview(id, number),
    queryFn: () => api.get<DocumentPreview>(`/documents/${id}/versions/${number}/preview`),
    staleTime: Infinity,
  });
}

/** Путь для запросов через клиент API. */
export function contentPath(id: string, number: number): string {
  return `/documents/${id}/versions/${number}/content`;
}

/** Полный адрес для <img>: встроенно сервер отдаёт только картинки. */
export function imageUrl(id: string, number: number): string {
  return `/api/v1${contentPath(id, number)}?inline=true`;
}

/** Файл уходит телом запроса как есть; имя — в заголовке, закодированное для не-ASCII. */
export async function uploadFile<T>(
  path: string,
  file: File,
  query?: Record<string, string | undefined>,
): Promise<T> {
  const response = await send("POST", path, {
    body: file,
    query,
    headers: {
      "X-File-Name": encodeURIComponent(file.name),
      "Content-Type": "application/octet-stream",
    },
  });
  return (await response.json()) as T;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
