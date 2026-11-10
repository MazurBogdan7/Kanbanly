/** Участники проекта: аватар со статусом, выбор исполнителя, команда на доске. */
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo, useState } from "react";

import { cx } from "@/components/ui";
import { useT, type MessageKey } from "@/i18n";
import { api } from "@/lib/api/client";
import type { MemberOut } from "@/lib/api/types";

import { keys } from "../boards/api";

export const membersKey = (projectId: string) => [...keys.project(projectId), "members"];

export function useProjectMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: membersKey(projectId ?? ""),
    queryFn: () => api.get<MemberOut[]>(`/projects/${projectId}/members`),
    enabled: !!projectId,
    staleTime: 30_000,
    // Статусы (онлайн, занят, офлайн) обновляются раз в минуту.
    refetchInterval: 60_000,
  });
}

/** Участники проекта по id: лицо карточки показывает исполнителя без отдельных запросов. */
export const ProjectMembersContext = createContext<Map<string, MemberOut>>(new Map());

export function useMemberIndex(projectId: string | undefined): Map<string, MemberOut> {
  const members = useProjectMembers(projectId);
  return useMemo(
    () => new Map((members.data ?? []).map((member) => [member.user_id, member])),
    [members.data],
  );
}

export function useMember(id: string | null | undefined): MemberOut | undefined {
  const index = useContext(ProjectMembersContext);
  return id ? index.get(id) : undefined;
}

export function memberLabel(member: { display_name: string; email: string }): string {
  return member.display_name || member.email;
}

export function initials(name: string): string {
  return (
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/** Цвет аватара стабилен для человека: выбирается по его id. */
// Тёмные оттенки: белые инициалы на них читаются (контраст не ниже WCAG AA).
export const AVATAR_COLORS = [
  "#1864AB",
  "#237032",
  "#A61E4D",
  "#5F3DC4",
  "#B03A00",
  "#0B7285",
  "#495057",
];

export function avatarColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#495057";
}

/** Адрес картинки: версия в адресе сбрасывает кэш, когда человек меняет аватар. */
export function avatarUrl(userId: string, version: number | null | undefined): string | null {
  return version ? `/api/v1/users/${userId}/avatar?v=${version}` : null;
}

export type Status = "online" | "busy" | "offline";

export const STATUS_LABEL: Record<Status, MessageKey> = {
  online: "status.online",
  busy: "status.busy",
  offline: "status.offline",
};

export const STATUS_COLOR: Record<Status, string> = {
  online: "#2F9E44",
  busy: "#E8590C",
  offline: "#868E96",
};

export interface Person {
  user_id: string;
  display_name: string;
  email: string;
  avatar_version?: number | null;
  status?: Status | null;
}

/** Круглый аватар: фото, если загружено, иначе инициалы на цветном фоне; точка — статус. */
export function Avatar({
  member,
  className,
  showStatus,
}: {
  member: Person;
  className?: string;
  showStatus?: boolean;
}) {
  const { t } = useT();
  const label = memberLabel(member);
  const url = avatarUrl(member.user_id, member.avatar_version);
  const [broken, setBroken] = useState<string | null>(null);
  const status = member.status ?? "offline";
  return (
    <span
      className={cx("relative inline-grid size-6 shrink-0", className)}
      title={showStatus ? `${label} · ${t(STATUS_LABEL[status])}` : label}
      data-status={showStatus ? status : undefined}
    >
      {url && broken !== url ? (
        <img
          src={url}
          alt=""
          className="size-full rounded-full object-cover"
          onError={() => setBroken(url)}
        />
      ) : (
        <span
          aria-hidden
          className="grid size-full place-items-center rounded-full text-[0.62em] font-semibold text-white"
          style={{ background: avatarColor(member.user_id) }}
        >
          {initials(label)}
        </span>
      )}
      {showStatus && (
        <span
          className="absolute -right-0.5 -bottom-0.5 size-[38%] min-h-2 min-w-2 rounded-full ring-2 ring-panel"
          style={{ background: STATUS_COLOR[status] }}
          aria-label={t(STATUS_LABEL[status])}
          role="img"
        />
      )}
    </span>
  );
}

/** Команда на доске: аватары со статусами, сначала те, кто онлайн. */
export function TeamAvatars({ projectId, max = 5 }: { projectId: string; max?: number }) {
  const { t } = useT();
  const members = useProjectMembers(projectId);
  const order: Record<Status, number> = { online: 0, busy: 1, offline: 2 };
  const list = [...(members.data ?? [])].sort(
    (a, b) => order[a.status ?? "offline"] - order[b.status ?? "offline"],
  );
  if (list.length < 2) return null;
  const online = list.filter((member) => member.status !== "offline").length;
  return (
    <div
      className="flex items-center"
      data-testid="team-avatars"
      aria-label={t("status.team", { online, total: list.length })}
      role="group"
    >
      {list.slice(0, max).map((member) => (
        <Avatar
          key={member.user_id}
          member={member}
          showStatus
          className="-ml-1.5 size-7 rounded-full text-xs ring-2 ring-panel first:ml-0"
        />
      ))}
      {list.length > max && (
        <span className="-ml-1.5 grid size-7 place-items-center rounded-full bg-raised text-[10px] font-semibold ring-2 ring-panel">
          +{list.length - max}
        </span>
      )}
    </div>
  );
}
