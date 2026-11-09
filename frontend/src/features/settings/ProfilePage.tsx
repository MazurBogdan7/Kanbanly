import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import {
  Button,
  ErrorNote,
  Section,
  SelectField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextField,
} from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useLocale, useT, type Locale } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type { RecoveryCodesOut, SessionOut, TotpSetupOut, UserOut } from "@/lib/api/types";

import { PasswordMeter } from "../auth/AuthPages";
import { useMe, useSignOut } from "../auth/session";
import { DataBackups } from "../backup/DataBackups";
import { keys } from "../boards/api";
import { IncomingInvites, useIncomingInvites } from "../projects/Inbox";

function Account({ user }: { user: UserOut }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const setLocale = useLocale((state) => state.setLocale);
  const [name, setName] = useState(user.display_name);
  const [nick, setNick] = useState(user.username ?? "");
  const save = useMutation({
    mutationFn: (payload: { display_name?: string; locale?: string; username?: string }) =>
      api.patch<UserOut>("/auth/me", payload),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.me, saved);
      toast.info(t("common.saved"));
    },
    onError: toast.error,
  });
  return (
    <div className="grid gap-4">
      <TextField label={t("auth.email")} value={user.email} readOnly />
      <TextField
        label={t("auth.displayName")}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <TextField
        label={t("profile.username")}
        hint={t("profile.usernameHint")}
        autoComplete="off"
        maxLength={33}
        placeholder="nickname"
        value={nick}
        onChange={(event) => setNick(event.target.value)}
      />
      <SelectField
        label={t("profile.language")}
        value={user.locale}
        onChange={(event) => {
          setLocale(event.target.value as Locale);
          save.mutate({ locale: event.target.value });
        }}
      >
        <option value="ru">Русский</option>
        <option value="en">English</option>
      </SelectField>
      <Button
        variant="primary"
        loading={save.isPending}
        onClick={() => save.mutate({ display_name: name, username: nick })}
      >
        {t("common.save")}
      </Button>
    </div>
  );
}

function Security({ user }: { user: UserOut }) {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ current_password: "", new_password: "" });
  const [setup, setSetup] = useState<TotpSetupOut | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [disablePassword, setDisablePassword] = useState("");
  const refreshMe = () => void queryClient.invalidateQueries({ queryKey: keys.me });
  const change = useMutation({
    mutationFn: () => api.post("/auth/password", form),
    onSuccess: () => {
      toast.info(t("profile.passwordChanged"));
      setForm({ current_password: "", new_password: "" });
    },
  });
  const begin = useMutation({
    mutationFn: () => api.post<TotpSetupOut>("/auth/2fa/setup"),
    onSuccess: setSetup,
    onError: toast.error,
  });
  const enable = useMutation({
    mutationFn: () => api.post<RecoveryCodesOut>("/auth/2fa/enable", { code }),
    onSuccess: (result) => {
      setCodes(result.recovery_codes);
      setSetup(null);
      setCode("");
      refreshMe();
    },
    onError: toast.error,
  });
  const disable = useMutation({
    mutationFn: () => api.post("/auth/2fa/disable", { password: disablePassword }),
    onSuccess: () => {
      setDisablePassword("");
      setCodes([]);
      refreshMe();
    },
    onError: toast.error,
  });
  return (
    <div className="grid gap-8">
      <Section title={t("profile.changePassword")}>
        <form
          className="grid gap-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            change.mutate();
          }}
        >
          <TextField
            label={t("profile.currentPassword")}
            type="password"
            autoComplete="current-password"
            required
            value={form.current_password}
            onChange={(event) => setForm({ ...form, current_password: event.target.value })}
          />
          <TextField
            label={t("auth.newPassword")}
            type="password"
            autoComplete="new-password"
            required
            value={form.new_password}
            onChange={(event) => setForm({ ...form, new_password: event.target.value })}
          />
          <PasswordMeter password={form.new_password} />
          {change.error instanceof ApiError && <ErrorNote message={change.error.message} />}
          <Button type="submit" loading={change.isPending}>
            {t("profile.changePassword")}
          </Button>
        </form>
      </Section>
      <Section title={t("profile.twoFactor")}>
        {user.totp_enabled ? (
          <div className="grid gap-2">
            <p className="text-sm text-success">{t("profile.twoFactorOn")}</p>
            <TextField
              label={t("auth.password")}
              type="password"
              value={disablePassword}
              onChange={(event) => setDisablePassword(event.target.value)}
            />
            <Button variant="danger" loading={disable.isPending} onClick={() => disable.mutate()}>
              {t("profile.twoFactorDisable")}
            </Button>
          </div>
        ) : setup ? (
          <div className="grid gap-2">
            <p className="text-sm">{t("profile.twoFactorSecret")}</p>
            <code
              data-testid="totp-secret"
              className="rounded-sm bg-raised p-2 font-mono text-sm break-all"
            >
              {setup.secret}
            </code>
            <TextField
              label={t("profile.twoFactorCode")}
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button variant="primary" loading={enable.isPending} onClick={() => enable.mutate()}>
              {t("profile.twoFactorEnable")}
            </Button>
          </div>
        ) : (
          <Button onClick={() => begin.mutate()} loading={begin.isPending}>
            {t("profile.twoFactorEnable")}
          </Button>
        )}
        {codes.length > 0 && (
          <div className="grid gap-1">
            <p className="text-sm font-medium">{t("profile.recoveryCodes")}</p>
            <pre className="rounded-sm bg-raised p-2 font-mono text-xs">{codes.join("\n")}</pre>
          </div>
        )}
      </Section>
    </div>
  );
}

function Sessions() {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const signOut = useSignOut();
  const sessions = useQuery({
    queryKey: keys.sessions,
    queryFn: () => api.get<SessionOut[]>("/auth/sessions"),
  });
  return (
    <div className="grid gap-3">
      <ul className="grid gap-2">
        {sessions.data?.map((session) => (
          <li
            key={session.id}
            className="flex items-center justify-between gap-3 rounded-md border border-line p-2 text-sm"
          >
            <span className="min-w-0">
              <span className="block truncate">{session.user_agent || session.ip}</span>
              <span className="text-xs text-ink-soft">
                {new Date(session.last_seen_at).toLocaleString(locale)}
              </span>
            </span>
            {session.current ? (
              <span className="text-xs font-medium text-success">
                {t("profile.currentSession")}
              </span>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  void api
                    .delete(`/auth/sessions/${session.id}`)
                    .then(() => queryClient.invalidateQueries({ queryKey: keys.sessions }))
                    .catch(toast.error)
                }
              >
                {t("profile.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <Button
        variant="danger"
        onClick={() =>
          void api
            .post("/auth/logout-all")
            .then(() => signOut())
            .catch(toast.error)
        }
      >
        {t("profile.logoutAll")}
      </Button>
    </div>
  );
}

function Danger() {
  const { t } = useT();
  const signOut = useSignOut();
  const [password, setPassword] = useState("");
  const remove = useMutation({
    mutationFn: () => api.delete("/auth/me", { password }),
    onSuccess: () => void signOut(),
    onError: toast.error,
  });
  return (
    <div className="grid gap-3">
      <p className="text-sm text-ink-soft">{t("profile.deleteHint")}</p>
      <TextField
        label={t("auth.password")}
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Button
        variant="danger"
        disabled={!password}
        loading={remove.isPending}
        onClick={() => remove.mutate()}
      >
        {t("profile.deleteAccount")}
      </Button>
    </div>
  );
}

const TABS = ["account", "invites", "security", "sessions", "data", "danger"] as const;
type ProfileTab = (typeof TABS)[number];

export function ProfilePage() {
  const { t } = useT();
  const me = useMe();
  const navigate = useNavigate();
  const search: { tab?: string } = useSearch({ strict: false });
  const tab: ProfileTab = TABS.includes(search.tab as ProfileTab)
    ? (search.tab as ProfileTab)
    : "account";
  const invites = useIncomingInvites(!!me.data);
  const pending = invites.data?.length ?? 0;
  if (!me.data) return null;
  return (
    <div className="mx-auto grid max-w-2xl gap-4 p-4 md:p-8">
      <h1 className="text-xl font-semibold">{t("profile.title")}</h1>
      <Tabs
        value={tab}
        onValueChange={(next) =>
          void navigate({ to: "/profile", search: next === "account" ? {} : { tab: next } })
        }
        className="grid gap-4"
      >
        <TabsList label={t("profile.title")}>
          <TabsTrigger value="account">{t("profile.account")}</TabsTrigger>
          <TabsTrigger value="invites">
            {t("profile.invites")}
            {pending > 0 && (
              <span className="ml-1.5 rounded-full bg-brand px-1.5 text-xs text-white">
                {pending}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="security">{t("profile.security")}</TabsTrigger>
          <TabsTrigger value="sessions">{t("profile.sessions")}</TabsTrigger>
          <TabsTrigger value="data">{t("profile.data")}</TabsTrigger>
          <TabsTrigger value="danger">{t("profile.danger")}</TabsTrigger>
        </TabsList>
        <TabsContent value="account">
          <Account user={me.data} />
        </TabsContent>
        <TabsContent value="invites">
          <IncomingInvites />
        </TabsContent>
        <TabsContent value="security">
          <Security user={me.data} />
        </TabsContent>
        <TabsContent value="sessions">
          <Sessions />
        </TabsContent>
        <TabsContent value="data">
          <DataBackups />
        </TabsContent>
        <TabsContent value="danger">
          <Danger />
        </TabsContent>
      </Tabs>
    </div>
  );
}
