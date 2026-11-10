/** Статус пользователя: выбор в профиле и в меню у аватара в шапке. */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, UserRound } from "lucide-react";

import { Menu, MenuItem, cx } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT, type MessageKey } from "@/i18n";
import { api } from "@/lib/api/client";
import type { UserOut } from "@/lib/api/types";

import { keys } from "../boards/api";
import { Avatar, STATUS_COLOR, STATUS_LABEL, type Status } from "../projects/people";

type Presence = "auto" | "busy" | "invisible";

const CHOICES: { value: Presence; label: MessageKey; hint: MessageKey; status: Status }[] = [
  { value: "auto", label: "status.auto", hint: "status.autoHint", status: "online" },
  { value: "busy", label: "status.busy", hint: "status.busyHint", status: "busy" },
  {
    value: "invisible",
    label: "status.invisible",
    hint: "status.invisibleHint",
    status: "offline",
  },
];

/** Себя пользователь видит так же, как его видят другие, пока он в приложении. */
export function ownStatus(user: UserOut): Status {
  return CHOICES.find((choice) => choice.value === user.presence)?.status ?? "online";
}

function usePresence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (presence: Presence) => api.patch<UserOut>("/auth/me", { presence }),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.me, saved);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: toast.error,
  });
}

function Dot({ status }: { status: Status }) {
  return (
    <span
      aria-hidden
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ background: STATUS_COLOR[status] }}
    />
  );
}

export function PresencePicker({ user }: { user: UserOut }) {
  const { t } = useT();
  const save = usePresence();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{t("status.title")}</legend>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("status.title")}>
        {CHOICES.map((choice) => {
          const selected = (user.presence ?? "auto") === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={save.isPending}
              onClick={() => save.mutate(choice.value)}
              className={cx(
                "grid gap-0.5 rounded-md border p-2 text-left text-sm transition-colors",
                selected ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong",
              )}
            >
              <span className="flex items-center gap-2 font-medium">
                <Dot status={choice.status} />
                {t(choice.label)}
              </span>
              <span className="text-xs text-ink-soft">{t(choice.hint)}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Аватар в шапке: быстрый выбор статуса и переход в профиль. */
export function UserMenu({ user, onLogout }: { user: UserOut; onLogout: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const save = usePresence();
  const status = ownStatus(user);
  return (
    <Menu
      trigger={
        <button
          type="button"
          aria-label={t("status.menu", { status: t(STATUS_LABEL[status]) })}
          data-testid="user-menu"
          className="grid size-8 place-items-center rounded-full hover:bg-raised"
        >
          <Avatar
            member={{ ...user, user_id: user.id, status }}
            showStatus
            className="size-7 text-xs"
          />
        </button>
      }
    >
      <div className="px-2 py-1.5 text-xs text-ink-soft">
        <div className="truncate font-medium text-ink">{user.display_name || user.email}</div>
        <div className="truncate">{user.email}</div>
      </div>
      {CHOICES.map((choice) => (
        <MenuItem key={choice.value} onSelect={() => save.mutate(choice.value)}>
          <Dot status={choice.status} />
          <span className="flex-1">{t(choice.label)}</span>
          {(user.presence ?? "auto") === choice.value && <Check className="size-3.5" aria-hidden />}
        </MenuItem>
      ))}
      <MenuItem onSelect={() => void navigate({ to: "/profile" })}>
        <UserRound className="size-3.5" aria-hidden />
        {t("app.profile")}
      </MenuItem>
      <MenuItem onSelect={onLogout}>{t("app.logout")}</MenuItem>
    </Menu>
  );
}
