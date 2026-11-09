/** Участники проекта для карточек: выбор исполнителя и аватар на лице карточки. */
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useMemo } from "react";

import { cx } from "@/components/ui";
import { api } from "@/lib/api/client";
import type { MemberOut } from "@/lib/api/types";

import { keys } from "../boards/api";

export const membersKey = (projectId: string) => [...keys.project(projectId), "members"];

export function useProjectMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: membersKey(projectId ?? ""),
    queryFn: () => api.get<MemberOut[]>(`/projects/${projectId}/members`),
    enabled: !!projectId,
    staleTime: 60_000,
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

export function memberLabel(member: Pick<MemberOut, "display_name" | "email">): string {
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

export function Avatar({
  member,
  className,
}: {
  member: Pick<MemberOut, "user_id" | "display_name" | "email">;
  className?: string;
}) {
  const label = memberLabel(member);
  return (
    <span
      className={cx(
        "inline-grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-white",
        className,
      )}
      style={{ background: avatarColor(member.user_id) }}
      title={label}
      aria-hidden
    >
      {initials(label)}
    </span>
  );
}
