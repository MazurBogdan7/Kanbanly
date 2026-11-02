import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button, EmptyState, Skeleton } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api } from "@/lib/api/client";
import type { TrashItem } from "@/lib/api/types";

import { keys } from "../boards/api";

const RESTORE_PATH: Record<TrashItem["type"], string> = {
  project: "projects",
  board: "boards",
  card: "cards",
  template: "templates",
};

export function TrashPage() {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const trash = useQuery({
    queryKey: keys.trash,
    queryFn: () => api.get<TrashItem[]>("/trash"),
  });
  const restore = useMutation({
    mutationFn: (item: TrashItem) => api.post(`/${RESTORE_PATH[item.type]}/${item.id}/restore`),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.info(t("trash.restored"));
    },
    onError: toast.error,
  });
  return (
    <div className="mx-auto grid max-w-3xl gap-4 p-4 md:p-8">
      <div>
        <h1 className="text-xl font-semibold">{t("trash.title")}</h1>
        <p className="text-sm text-ink-soft">{t("trash.hint")}</p>
      </div>
      {trash.isPending && <Skeleton className="h-40" />}
      {trash.data?.length === 0 && <EmptyState title={t("trash.empty")} />}
      <ul className="grid gap-2">
        {trash.data?.map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-3 rounded-md border border-line bg-panel p-3"
          >
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{item.name}</span>
              <span className="text-xs text-ink-soft">
                {t(`trash.type.${item.type}`)} ·{" "}
                {t("trash.purgeAt", { date: new Date(item.purge_at).toLocaleDateString(locale) })}
              </span>
            </span>
            <Button size="sm" onClick={() => restore.mutate(item)}>
              {t("trash.restore")}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
