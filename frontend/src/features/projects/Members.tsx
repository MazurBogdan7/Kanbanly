/** Участники проекта и приглашения. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Copy, RotateCcw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  Button,
  EmptyState,
  ErrorNote,
  Section,
  Select,
  SelectField,
  Skeleton,
  TextField,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type { InviteOut, InvitePreview, MemberOut, ProjectOut } from "@/lib/api/types";

import { keys } from "../boards/api";
import { Avatar, membersKey } from "./people";

type Role = "editor" | "viewer";

export function ProjectMembers({ project }: { project: ProjectOut }) {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isOwner = project.role === "owner";
  const listKey = membersKey(project.id);
  const invitesKey = [...keys.project(project.id), "invites"];
  const members = useQuery({
    queryKey: listKey,
    queryFn: () => api.get<MemberOut[]>(`/projects/${project.id}/members`),
  });
  const invites = useQuery({
    queryKey: invitesKey,
    queryFn: () => api.get<InviteOut[]>(`/projects/${project.id}/invites`),
    enabled: isOwner,
  });
  const [target, setTarget] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [link, setLink] = useState<string | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: listKey });
    void queryClient.invalidateQueries({ queryKey: invitesKey });
  };

  const invite = useMutation({
    mutationFn: (body: { target: string; role: Role }) =>
      api.post<InviteOut>(`/projects/${project.id}/invites`, body),
    onSuccess: (created) => {
      // Зарегистрированному приглашение пришло во входящие; ссылка нужна только новичку.
      if (created.invitee_name !== null && created.invitee_name !== undefined) {
        setLink(null);
        toast.info(t("members.sentInApp", { name: created.invitee_name || created.email }));
      } else {
        setLink(created.link ?? null);
      }
      setTarget("");
      refresh();
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ userId, next }: { userId: string; next: Role }) =>
      api.patch(`/projects/${project.id}/members/${userId}`, { role: next }),
    onSuccess: refresh,
    onError: toast.error,
  });
  const removeMember = useMutation({
    mutationFn: (member: MemberOut) =>
      api.delete(`/projects/${project.id}/members/${member.user_id}`),
    onSuccess: (_, member) => {
      if (member.is_you) {
        void queryClient.invalidateQueries({ queryKey: keys.projects });
        void navigate({ to: "/" });
        return;
      }
      refresh();
    },
    onError: toast.error,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${project.id}/invites/${id}`),
    onSuccess: refresh,
    onError: toast.error,
  });

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.info(t("members.copied"));
    } catch {
      toast.info(value);
    }
  };

  return (
    <Section title={t("members.title")}>
      {members.isPending ? (
        <Skeleton className="h-20" />
      ) : (
        <ul className="grid gap-2">
          {members.data?.map((member) => (
            <li
              key={member.user_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-panel p-2"
            >
              <Avatar member={member} className="size-8 text-xs" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {member.display_name}
                  {member.is_you && ` (${t("members.you")})`}
                </span>
                <span className="block truncate text-xs text-ink-soft">
                  {member.username ? `@${member.username} · ` : ""}
                  {member.email}
                </span>
              </span>
              <span className="flex items-center gap-1">
                {member.role === "owner" || !isOwner ? (
                  <span className="text-xs text-ink-soft">
                    {t(`members.role.${member.role as "owner"}`)}
                  </span>
                ) : (
                  <Select
                    aria-label={`${t("members.roleLabel")}: ${member.display_name}`}
                    className="h-8 w-40"
                    value={member.role}
                    onChange={(event) =>
                      changeRole.mutate({
                        userId: member.user_id,
                        next: event.target.value as Role,
                      })
                    }
                  >
                    <option value="editor">{t("members.role.editor")}</option>
                    <option value="viewer">{t("members.role.viewer")}</option>
                  </Select>
                )}
                {member.role !== "owner" && (isOwner || member.is_you) && (
                  <Button
                    size="sm"
                    variant={member.is_you ? "secondary" : "ghost"}
                    aria-label={
                      member.is_you
                        ? t("members.leave")
                        : `${t("members.remove")}: ${member.display_name}`
                    }
                    onClick={() => removeMember.mutate(member)}
                  >
                    {member.is_you ? (
                      t("members.leave")
                    ) : (
                      <Trash2 className="size-3.5" aria-hidden />
                    )}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {isOwner && (
        <>
          <form
            className="grid gap-2 sm:grid-cols-[1fr_10rem_auto] sm:items-end"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              setLink(null);
              invite.mutate({ target, role });
            }}
          >
            <TextField
              label={t("members.inviteTarget")}
              placeholder={t("members.inviteTargetPlaceholder")}
              autoComplete="off"
              required
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
            <SelectField
              label={t("members.roleLabel")}
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
            >
              <option value="editor">{t("members.role.editor")}</option>
              <option value="viewer">{t("members.role.viewer")}</option>
            </SelectField>
            <Button type="submit" variant="primary" loading={invite.isPending}>
              {t("members.invite")}
            </Button>
          </form>
          {invite.error instanceof ApiError && <ErrorNote message={invite.error.message} />}
          {link && (
            <div className="grid gap-1 rounded-md bg-raised p-3 text-sm" data-testid="invite-link">
              <p>{t("members.linkHint")}</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
                <Button size="sm" onClick={() => void copy(link)}>
                  <Copy className="size-3.5" aria-hidden />
                  {t("members.copy")}
                </Button>
              </div>
            </div>
          )}
          {(invites.data?.length ?? 0) > 0 && (
            <div className="grid gap-1">
              <p className="text-xs font-medium text-ink-soft">{t("members.pending")}</p>
              {invites.data?.map((item) => (
                <div
                  key={item.id}
                  data-testid="project-invite"
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span className="min-w-0 truncate">
                    {item.invitee_name ? `${item.invitee_name} · ` : ""}
                    {item.invitee_username ? `@${item.invitee_username} · ` : ""}
                    {item.email} · {t(`members.role.${item.role as "editor"}`)}
                    {item.status === "declined" && (
                      <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-xs text-danger">
                        {t("members.declined")}
                      </span>
                    )}
                  </span>
                  <span className="flex gap-1">
                    {item.status === "declined" && (
                      <Button
                        size="sm"
                        onClick={() =>
                          invite.mutate({ target: item.email, role: item.role as Role })
                        }
                      >
                        <RotateCcw className="size-3.5" aria-hidden />
                        {t("members.inviteAgain")}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(item.id)}>
                      {t("members.revoke")}
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

export function InvitePage() {
  const { t } = useT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { token } = useParams({ strict: false }) as { token: string };
  const preview = useQuery({
    queryKey: ["invites", token],
    queryFn: () => api.get<InvitePreview>(`/invites/${token}`),
    retry: false,
  });
  const accept = useMutation({
    mutationFn: () => api.post<ProjectOut>(`/invites/${token}/accept`),
    onSuccess: (project) => {
      void queryClient.invalidateQueries({ queryKey: keys.projects });
      void navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
    },
    onError: toast.error,
  });
  return (
    <div className="mx-auto grid max-w-md gap-4 p-4 md:p-8">
      <h1 className="text-xl font-semibold">{t("members.inviteTitle")}</h1>
      {preview.isPending && <Skeleton className="h-24" />}
      {preview.isError && (
        <EmptyState title={t("members.inviteInvalid")} hint={t("members.inviteInvalidHint")} />
      )}
      {preview.data && (
        <div className="grid gap-3 rounded-lg border border-line bg-panel p-4">
          <p className="text-sm">
            {t("members.inviteText", {
              inviter: preview.data.inviter || "—",
              project: preview.data.project_name,
              role: t(`members.role.${preview.data.role as "editor"}`).toLowerCase(),
            })}
          </p>
          <Button variant="primary" loading={accept.isPending} onClick={() => accept.mutate()}>
            {t("members.accept")}
          </Button>
        </div>
      )}
    </div>
  );
}
