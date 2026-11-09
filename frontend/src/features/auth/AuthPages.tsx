import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Button, cx, ErrorNote, TextField } from "@/components/ui";
import { t, useT } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type { UserOut } from "@/lib/api/types";

import { safeNext } from "../../app/queryClient";

import { passwordStrength, useSetSession } from "./session";

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof ApiError
    ? (error.problems[0]?.message ?? error.message)
    : t("common.error");
}

function AuthLayout({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useT();
  return (
    <main className="grid min-h-full place-items-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <p className="mb-1 text-lg font-bold text-brand">{t("app.name")}</p>
        <p className="mb-5 text-sm text-ink-soft">{t("auth.tagline")}</p>
        <div className="rounded-lg border border-line bg-panel p-5 shadow-panel">
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </main>
  );
}

export function PasswordMeter({ password }: { password: string }) {
  const { t } = useT();
  const [breached, setBreached] = useState(false);
  const { score, label } = passwordStrength(password);
  useEffect(() => {
    if (password.length < 10) {
      setBreached(false);
      return;
    }
    const timer = setTimeout(() => {
      api
        .post<{ breached: boolean }>("/auth/password-strength", { password })
        .then((result) => setBreached(result.breached))
        .catch(() => setBreached(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [password]);
  if (!password) return null;
  return (
    <div aria-live="polite" className="grid gap-1">
      <div className="flex gap-1" aria-hidden>
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className={cx(
              "h-1 flex-1 rounded-full",
              !breached && score >= step ? "bg-success" : "bg-line",
            )}
          />
        ))}
      </div>
      <p className={cx("text-xs", breached ? "text-danger" : "text-ink-soft")}>
        {breached
          ? t("strength.breached")
          : `${t("strength.label")}: ${t(`strength.${label}`).toLowerCase()}`}
      </p>
    </div>
  );
}

function useNext(): string {
  const search = useSearch({ strict: false }) as { next?: unknown };
  return safeNext(search.next);
}

export function LoginPage() {
  const { t } = useT();
  const next = useNext();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [secondFactor, setSecondFactor] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const login = useMutation({
    mutationFn: () =>
      api.post<UserOut>("/auth/login", {
        email,
        password,
        totp_code: secondFactor && !useRecovery ? code : undefined,
        recovery_code: secondFactor && useRecovery ? code : undefined,
      }),
    onSuccess: (user) => {
      setSession(user);
      void navigate({ to: next });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === "totp_required") setSecondFactor(true);
    },
  });
  const needCode = login.error instanceof ApiError && login.error.code === "totp_required";
  return (
    <AuthLayout title={t("auth.login")}>
      <form
        className="grid gap-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          login.mutate();
        }}
      >
        <TextField
          label={t("auth.email")}
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label={t("auth.password")}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {secondFactor && (
          <>
            <TextField
              label={useRecovery ? t("auth.recovery") : t("auth.totp")}
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
            <Button variant="ghost" size="sm" onClick={() => setUseRecovery((value) => !value)}>
              {useRecovery ? t("auth.useTotp") : t("auth.useRecovery")}
            </Button>
          </>
        )}
        {login.error && !needCode ? <ErrorNote message={errorText(login.error) ?? ""} /> : null}
        {login.error instanceof ApiError && login.error.code === "account_locked" && (
          <Link to="/forgot-password" className="text-sm font-medium text-brand underline">
            {t("auth.lockedReset")}
          </Link>
        )}
        <Button type="submit" variant="primary" loading={login.isPending}>
          {t("auth.submitLogin")}
        </Button>
      </form>
      <div className="mt-4 grid gap-1 text-sm">
        <Link to="/register" search={{ next }} className="text-brand underline">
          {t("auth.noAccount")}
        </Link>
        <Link to="/forgot-password" className="text-brand underline">
          {t("auth.forgot")}
        </Link>
      </div>
    </AuthLayout>
  );
}

export function RegisterPage() {
  const { t } = useT();
  const next = useNext();
  const setSession = useSetSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "", display_name: "" });
  const status = useQuery({
    queryKey: ["registration"],
    queryFn: () => api.get<{ open: boolean }>("/auth/registration"),
    staleTime: 60_000,
  });
  const register = useMutation({
    mutationFn: () => api.post<UserOut>("/auth/register", form),
    onSuccess: (user) => {
      setSession(user);
      void navigate({ to: next });
    },
  });
  return (
    <AuthLayout title={t("auth.register")}>
      {status.data?.open === false && (
        <p role="status" className="mb-3 rounded-md bg-warning/15 px-3 py-2 text-sm">
          {t("auth.registrationClosed")}
        </p>
      )}
      <form
        className="grid gap-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          register.mutate();
        }}
      >
        <TextField
          label={t("auth.displayName")}
          autoComplete="name"
          value={form.display_name}
          onChange={(event) => setForm({ ...form, display_name: event.target.value })}
        />
        <TextField
          label={t("auth.email")}
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={(event) => setForm({ ...form, email: event.target.value })}
        />
        <TextField
          label={t("auth.password")}
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={form.password}
          onChange={(event) => setForm({ ...form, password: event.target.value })}
        />
        <PasswordMeter password={form.password} />
        {register.error ? <ErrorNote message={errorText(register.error) ?? ""} /> : null}
        <Button type="submit" variant="primary" loading={register.isPending}>
          {t("auth.submitRegister")}
        </Button>
      </form>
      <Link to="/login" search={{ next }} className="mt-4 block text-sm text-brand underline">
        {t("auth.haveAccount")}
      </Link>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const { t } = useT();
  const [email, setEmail] = useState("");
  const request = useMutation({
    mutationFn: () => api.post("/auth/password-reset/request", { email }),
  });
  return (
    <AuthLayout title={t("auth.resetTitle")}>
      {request.isSuccess ? (
        <p role="status" className="text-sm">
          {t("auth.resetSent")}
        </p>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            request.mutate();
          }}
        >
          <TextField
            label={t("auth.email")}
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {request.error ? <ErrorNote message={errorText(request.error) ?? ""} /> : null}
          <Button type="submit" variant="primary" loading={request.isPending}>
            {t("auth.resetSend")}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-sm text-brand underline">
        {t("auth.toLogin")}
      </Link>
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const { t } = useT();
  const { token } = useSearch({ strict: false }) as { token?: string };
  const [password, setPassword] = useState("");
  const confirm = useMutation({
    mutationFn: () =>
      api.post("/auth/password-reset/confirm", { token: token ?? "", new_password: password }),
  });
  return (
    <AuthLayout title={t("auth.resetTitle")}>
      {confirm.isSuccess ? (
        <p role="status" className="text-sm">
          {t("auth.resetDone")}
        </p>
      ) : (
        <form
          className="grid gap-3"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            confirm.mutate();
          }}
        >
          <TextField
            label={t("auth.newPassword")}
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <PasswordMeter password={password} />
          {confirm.error ? <ErrorNote message={errorText(confirm.error) ?? ""} /> : null}
          <Button type="submit" variant="primary" loading={confirm.isPending}>
            {t("common.save")}
          </Button>
        </form>
      )}
      <Link to="/login" className="mt-4 block text-sm text-brand underline">
        {t("auth.toLogin")}
      </Link>
    </AuthLayout>
  );
}
