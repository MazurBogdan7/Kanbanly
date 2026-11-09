/**
 * Панель администратора: пользователи, блокировки, регистрация, журнал безопасности.
 * Содержимое чужих проектов администратору не показывается — только учётные записи и счётчики.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Lock, LogOut, Search, ShieldCheck, Trash2, Unlock, UserX } from "lucide-react";
import { useDeferredValue, useState } from "react";

import {
  Button,
  EmptyState,
  ErrorNote,
  Input,
  Modal,
  Section,
  Skeleton,
  TextField,
  Toggle,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useLocale, useT, type MessageKey } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type { AdminEvent, AdminSettings, AdminStats, AdminUser, Page } from "@/lib/api/types";

import { formatSize } from "../workspace/api";

const adminKeys = {
  stats: ["admin", "stats"] as const,
  users: (q: string) => ["admin", "users", q] as const,
  audit: ["admin", "audit"] as const,
  settings: ["admin", "settings"] as const,
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-line bg-panel p-3">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function StatusBadge({ user }: { user: AdminUser }) {
  const { t } = useT();
  if (!user.is_active) {
    return (
      <span className="rounded-full bg-danger-soft px-2 py-0.5 text-xs text-danger">
        {t("admin.disabled")}
      </span>
    );
  }
  if (user.locked) {
    return (
      <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs">{t("admin.locked")}</span>
    );
  }
  return (
    <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-ink-soft">
      {t("admin.active")}
    </span>
  );
}

function DeleteUser({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/users/${user.id}`, { confirm_email: email }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      toast.info(t("admin.deleted", { email: user.email }));
      onClose();
    },
  });
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("admin.deleteTitle")}
      width={440}
    >
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          remove.mutate();
        }}
      >
        <p className="text-sm">{t("admin.deleteWarning", { email: user.email })}</p>
        <TextField
          label={t("admin.confirmEmail")}
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {remove.error instanceof ApiError && <ErrorNote message={remove.error.message} />}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            type="submit"
            variant="danger"
            loading={remove.isPending}
            disabled={email.trim().toLowerCase() !== user.email.toLowerCase()}
          >
            {t("common.delete")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function UserRow({ user, onDelete }: { user: AdminUser; onDelete: () => void }) {
  const { t } = useT();
  const locale = useLocale((state) => state.locale);
  const queryClient = useQueryClient();
  const done = (message: string) => () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    toast.info(message);
  };
  const unlock = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/unlock`),
    onSuccess: done(t("admin.unlocked", { email: user.email })),
    onError: toast.error,
  });
  const patch = useMutation({
    mutationFn: (body: { is_active?: boolean; is_admin?: boolean }) =>
      api.patch(`/admin/users/${user.id}`, body),
    onSuccess: done(t("common.saved")),
    onError: toast.error,
  });
  const logout = useMutation({
    mutationFn: () => api.post(`/admin/users/${user.id}/logout-all`),
    onSuccess: done(t("admin.loggedOut", { email: user.email })),
    onError: toast.error,
  });
  return (
    <tr className="border-t border-line align-top" data-testid="admin-user">
      <td className="py-2 pr-3">
        <div className="font-medium">
          {user.display_name}
          {user.is_you && <span className="ml-1 text-xs text-ink-soft">({t("admin.you")})</span>}
        </div>
        <div className="text-xs break-all text-ink-soft">{user.email}</div>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge user={user} />
          {user.is_admin && (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs">
              <ShieldCheck className="size-3" aria-hidden />
              {t("admin.admin")}
            </span>
          )}
        </div>
        {user.failed_logins > 0 && (
          <div className="mt-1 text-xs text-ink-soft">
            {t("admin.failed", { count: user.failed_logins })}
          </div>
        )}
      </td>
      <td className="hidden py-2 pr-3 text-xs text-ink-soft md:table-cell">
        <div>
          {t("admin.registered")}: {new Date(user.created_at).toLocaleDateString(locale)}
        </div>
        <div>
          {t("admin.lastLogin")}:{" "}
          {user.last_login_at
            ? new Date(user.last_login_at).toLocaleString(locale)
            : t("common.none")}
        </div>
        <div>
          {t("admin.projects")}: {user.projects}
        </div>
      </td>
      <td className="py-2">
        <div className="flex flex-wrap justify-end gap-1">
          {user.locked && (
            <Button
              size="sm"
              variant="primary"
              loading={unlock.isPending}
              onClick={() => unlock.mutate()}
            >
              <Unlock className="size-3.5" aria-hidden />
              {t("admin.unlock")}
            </Button>
          )}
          {!user.is_you && (
            <>
              <Button
                size="sm"
                loading={patch.isPending}
                onClick={() => patch.mutate({ is_active: !user.is_active })}
              >
                {user.is_active ? (
                  <UserX className="size-3.5" aria-hidden />
                ) : (
                  <Lock className="size-3.5" aria-hidden />
                )}
                {user.is_active ? t("admin.disable") : t("admin.enable")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => patch.mutate({ is_admin: !user.is_admin })}
              >
                <ShieldCheck className="size-3.5" aria-hidden />
                {user.is_admin ? t("admin.revokeAdmin") : t("admin.makeAdmin")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("admin.logoutAll")}
                title={t("admin.logoutAll")}
                loading={logout.isPending}
                onClick={() => logout.mutate()}
              >
                <LogOut className="size-3.5" aria-hidden />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("admin.delete")}
                title={t("admin.delete")}
                onClick={onDelete}
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function Users() {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim());
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const users = useQuery({
    queryKey: adminKeys.users(q),
    queryFn: () => api.get<Page<AdminUser>>("/admin/users", { q: q || undefined }),
  });
  return (
    <Section title={t("admin.users")}>
      <label className="relative block max-w-sm">
        <Search className="absolute top-2.5 left-2.5 size-4 text-ink-soft" aria-hidden />
        <Input
          aria-label={t("admin.search")}
          placeholder={t("admin.search")}
          className="pl-8"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {users.isPending ? (
        <Skeleton className="h-40" />
      ) : users.isError ? (
        <ErrorNote message={t("common.error")} onRetry={() => void users.refetch()} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-soft">
              <tr>
                <th className="pb-2 font-medium">{t("admin.user")}</th>
                <th className="pb-2 font-medium">{t("admin.status")}</th>
                <th className="hidden pb-2 font-medium md:table-cell">{t("admin.activity")}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((user) => (
                <UserRow key={user.id} user={user} onDelete={() => setDeleting(user)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deleting && <DeleteUser user={deleting} onClose={() => setDeleting(null)} />}
    </Section>
  );
}

function Registration() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: adminKeys.settings,
    queryFn: () => api.get<AdminSettings>("/admin/settings"),
  });
  const save = useMutation({
    mutationFn: (registration_open: boolean) =>
      api.put<AdminSettings>("/admin/settings", { registration_open }),
    onSuccess: (data) => queryClient.setQueryData(adminKeys.settings, data),
    onError: toast.error,
  });
  return (
    <Section title={t("admin.settings")}>
      {settings.data && (
        <div className="grid gap-1">
          <Toggle
            label={t("admin.registrationOpen")}
            checked={settings.data.registration_open}
            onChange={(value) => save.mutate(value)}
          />
          <p className="text-xs text-ink-soft">{t("admin.registrationHint")}</p>
        </div>
      )}
    </Section>
  );
}

const ACTION_KEYS: Record<string, MessageKey> = {
  "auth.locked": "admin.event.locked",
  "auth.login": "admin.event.login",
  "auth.register": "admin.event.register",
  "auth.password_reset": "admin.event.passwordReset",
  "auth.password_changed": "admin.event.passwordChanged",
  "auth.logout_all": "admin.event.logoutAll",
  "auth.account_deleted": "admin.event.accountDeleted",
  "admin.user_unlocked": "admin.event.unlocked",
  "admin.user_updated": "admin.event.updated",
  "admin.user_deleted": "admin.event.deleted",
  "admin.user_logged_out": "admin.event.sessionsRevoked",
  "admin.settings_changed": "admin.event.settings",
};

function Audit() {
  const { t } = useT();
  const locale = useLocale((state) => state.locale);
  const audit = useQuery({
    queryKey: adminKeys.audit,
    queryFn: () => api.get<AdminEvent[]>("/admin/audit"),
  });
  return (
    <Section title={t("admin.audit")}>
      <ol className="grid max-h-96 gap-1 overflow-y-auto text-xs">
        {(audit.data ?? []).map((event) => {
          const key = ACTION_KEYS[event.action];
          return (
            <li key={event.id} className="flex flex-wrap gap-x-2 border-b border-line py-1">
              <span className="text-ink-soft tabular-nums">
                {new Date(event.created_at).toLocaleString(locale)}
              </span>
              <span className="font-medium">{key ? t(key) : event.action}</span>
              {event.email && <span className="break-all">{event.email}</span>}
              {event.ip && <span className="text-ink-soft">{event.ip}</span>}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

export function AdminPage() {
  const { t } = useT();
  const stats = useQuery({
    queryKey: adminKeys.stats,
    queryFn: () => api.get<AdminStats>("/admin/stats"),
    retry: false,
  });
  if (stats.isPending) {
    return (
      <div className="mx-auto max-w-6xl p-8">
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (stats.isError) {
    return (
      <EmptyState
        title={t("admin.noAccess")}
        action={
          <Link to="/" className="text-sm underline">
            {t("app.home")}
          </Link>
        }
      />
    );
  }
  const s = stats.data;
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-8 p-4 md:p-8">
      <div>
        <h1 className="text-xl font-semibold">{t("admin.title")}</h1>
        <p className="text-sm text-ink-soft">{t("admin.subtitle")}</p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={t("admin.statUsers")} value={`${s.active_users} / ${s.users}`} />
        <Stat label={t("admin.statLocked")} value={s.locked_users} />
        <Stat label={t("admin.statProjects")} value={s.projects} />
        <Stat label={t("admin.statCards")} value={s.cards} />
        <Stat
          label={t("admin.statFiles")}
          value={`${s.documents} · ${formatSize(s.storage_bytes)}`}
        />
      </div>
      <Users />
      <div className="grid gap-8 lg:grid-cols-2">
        <Registration />
        <Audit />
      </div>
    </div>
  );
}
