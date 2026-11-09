/** Входящие приглашения в проекты: принять или отклонить прямо в приложении. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Inbox as InboxIcon, X } from "lucide-react";

import { Button, EmptyState, ErrorNote, Skeleton } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useLocale, useT } from "@/i18n";
import { api } from "@/lib/api/client";
import type { IncomingInvite, ProjectOut } from "@/lib/api/types";

import { keys } from "../boards/api";

export const inboxKey = ["me", "invites"] as const;

/** Раз в минуту проверяет новые приглашения: число показывается в меню. */
export function useIncomingInvites(enabled = true) {
  return useQuery({
    queryKey: inboxKey,
    queryFn: () => api.get<IncomingInvite[]>("/me/invites"),
    enabled,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

function InviteRow({ invite }: { invite: IncomingInvite }) {
  const { t } = useT();
  const locale = useLocale((state) => state.locale);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accept = useMutation({
    mutationFn: () => api.post<ProjectOut>(`/me/invites/${invite.id}/accept`),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: inboxKey });
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      toast.info(t("inbox.joined", { project: project.name }));
      void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
    onError: toast.error,
  });
  const decline = useMutation({
    mutationFn: () => api.post(`/me/invites/${invite.id}/decline`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inboxKey });
      toast.info(t("inbox.declined", { project: invite.project_name }));
    },
    onError: toast.error,
  });
  return (
    <li
      data-testid="incoming-invite"
      className="grid gap-3 rounded-lg border border-line bg-panel p-4 sm:flex sm:items-center sm:justify-between"
    >
      <div className="min-w-0">
        <p className="font-medium [overflow-wrap:anywhere]">{invite.project_name}</p>
        <p className="text-sm text-ink-soft">
          {t("inbox.from", {
            inviter: invite.inviter || "—",
            role: t(`members.role.${invite.role as "editor"}`).toLowerCase(),
          })}
        </p>
        <p className="text-xs text-ink-soft">
          {new Date(invite.created_at).toLocaleDateString(locale)}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          variant="primary"
          loading={accept.isPending}
          disabled={decline.isPending}
          onClick={() => accept.mutate()}
        >
          <Check className="size-4" aria-hidden />
          {t("inbox.accept")}
        </Button>
        <Button
          loading={decline.isPending}
          disabled={accept.isPending}
          onClick={() => decline.mutate()}
        >
          <X className="size-4" aria-hidden />
          {t("inbox.decline")}
        </Button>
      </div>
    </li>
  );
}

export function IncomingInvites() {
  const { t } = useT();
  const invites = useIncomingInvites();
  if (invites.isPending) return <Skeleton className="h-24" />;
  if (invites.isError) {
    return <ErrorNote message={t("common.error")} onRetry={() => void invites.refetch()} />;
  }
  if (invites.data.length === 0) {
    return (
      <div className="grid justify-items-center text-ink-soft">
        <InboxIcon className="mt-8 size-6" aria-hidden />
        <EmptyState title={t("inbox.empty")} hint={t("inbox.emptyHint")} />
      </div>
    );
  }
  return (
    <ul className="grid gap-3" aria-label={t("inbox.title")}>
      {invites.data.map((invite) => (
        <InviteRow key={invite.id} invite={invite} />
      ))}
    </ul>
  );
}
