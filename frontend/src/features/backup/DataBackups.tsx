/** Раздел профиля «Данные и бэкапы». */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useRef, useState } from "react";

import { Button, ErrorNote, Section, SelectField, TextField, Toggle } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, ApiError, downloadFrom, request } from "@/lib/api/client";
import type { BackupHistory, BackupImportResult, BackupPreview } from "@/lib/api/types";

import { keys, useProjects } from "../boards/api";

export function DataBackups() {
  const { t, locale } = useT();
  const queryClient = useQueryClient();
  const projects = useProjects();
  const history = useQuery({
    queryKey: keys.backups,
    queryFn: () => api.get<BackupHistory>("/backups"),
  });
  const [scope, setScope] = useState("account");
  const [compress, setCompress] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [exportPassword, setExportPassword] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [mode, setMode] = useState<"copy" | "replace">("copy");
  const [confirm, setConfirm] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const headers = password ? { "X-Backup-Password": password } : undefined;

  const download = useMutation({
    mutationFn: () =>
      encrypt
        ? downloadFrom("/export/backup", {
            method: "POST",
            json: { scope, password: exportPassword, gzip: compress },
          })
        : downloadFrom("/export/backup", { query: { scope, compress: compress || undefined } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.backups });
      setExportPassword("");
    },
    onError: toast.error,
  });

  const check = useMutation({
    mutationFn: (target: File) =>
      request<BackupPreview>("POST", "/import/backup/preview", {
        body: target,
        headers: { "Content-Type": "application/octet-stream", ...headers },
      }),
    onSuccess: setPreview,
    onError: toast.error,
  });

  const restore = useMutation({
    mutationFn: () =>
      request<BackupImportResult>("POST", "/import/backup", {
        body: file ?? undefined,
        query: { mode, confirm: mode === "replace" ? confirm : undefined },
        headers: { "Content-Type": "application/octet-stream", ...headers },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      toast.info(t("backup.restored"));
      setFile(null);
      setPreview(null);
      setConfirm("");
      setPassword("");
    },
    onError: toast.error,
  });

  const counts = preview?.counts ?? {};
  return (
    <div className="grid gap-6">
      <Section title={t("backup.export")}>
        <SelectField
          label={t("backup.scope")}
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="account">{t("backup.scopeAccount")}</option>
          {projects.data?.map((project) => (
            <optgroup key={project.id} label={project.name}>
              <option value={`project:${project.id}`}>{project.name}</option>
              {project.boards?.map((board) => (
                <option key={board.id} value={`board:${board.id}`}>
                  — {board.name}
                </option>
              ))}
            </optgroup>
          ))}
        </SelectField>
        <Toggle label={t("backup.gzip")} checked={compress} onChange={setCompress} />
        <Toggle label={t("backup.encrypt")} checked={encrypt} onChange={setEncrypt} />
        {encrypt && (
          <TextField
            label={t("backup.password")}
            type="password"
            autoComplete="new-password"
            minLength={8}
            value={exportPassword}
            onChange={(event) => setExportPassword(event.target.value)}
          />
        )}
        <Button
          variant="primary"
          loading={download.isPending}
          disabled={encrypt && exportPassword.length < 8}
          onClick={() => download.mutate()}
        >
          <Download className="size-4" aria-hidden />
          {t("backup.download")}
        </Button>
      </Section>

      <Section title={t("backup.import")}>
        <Button
          onClick={() => {
            setPreview(null);
            input.current?.click();
          }}
        >
          {file?.name ?? t("backup.pickFile")}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,.gz"
          hidden
          aria-label={t("backup.pickFile")}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) {
              setFile(selected);
              check.mutate(selected);
            }
            event.target.value = "";
          }}
        />
        {preview?.password_required && file && (
          <div className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label={t("backup.password")}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            <Button onClick={() => check.mutate(file)}>{t("common.continue")}</Button>
          </div>
        )}
        {preview && !preview.valid && (preview.errors?.length ?? 0) > 0 && (
          <ErrorNote message={(preview.errors ?? []).map((item) => item.message).join("; ")} />
        )}
        {preview?.valid && (
          <div className="grid gap-3 rounded-md border border-line p-3">
            <p className="text-sm" data-testid="backup-preview">
              {t("backup.preview", {
                projects: counts.projects ?? 0,
                boards: counts.boards ?? 0,
                cards: counts.cards ?? 0,
                templates: counts.templates ?? 0,
              })}
            </p>
            {(preview.conflicts?.length ?? 0) > 0 && (
              <p className="text-xs text-warning">
                {t("backup.conflicts")}: {preview.conflicts?.map((item) => item.name).join(", ")}
              </p>
            )}
            <div className="grid gap-1" role="radiogroup" aria-label={t("backup.import")}>
              {(["copy", "replace"] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="restore-mode"
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {t(value === "copy" ? "backup.modeCopy" : "backup.modeReplace")}
                </label>
              ))}
            </div>
            {mode === "replace" && (
              <TextField
                label={t("backup.confirmWord")}
                hint={t("backup.replaceHint")}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            )}
            <Button
              variant={mode === "replace" ? "danger" : "primary"}
              loading={restore.isPending}
              disabled={mode === "replace" && confirm !== "ЗАМЕНИТЬ"}
              onClick={() => restore.mutate()}
            >
              {t("backup.restore")}
            </Button>
            {restore.error instanceof ApiError && <ErrorNote message={restore.error.message} />}
          </div>
        )}
      </Section>

      <Section title={t("backup.history")}>
        <ul className="grid gap-1 text-sm">
          {history.data?.snapshots.map((snapshot) => (
            <li key={snapshot.id} className="flex items-center justify-between gap-2">
              <span className="truncate">
                {t("backup.snapshot")} · {new Date(snapshot.created_at).toLocaleString(locale)}
              </span>
              <Button
                size="sm"
                onClick={() =>
                  void downloadFrom(`/backups/snapshots/${snapshot.id}`).catch(toast.error)
                }
              >
                {t("common.download")}
              </Button>
            </li>
          ))}
          {history.data?.events.map((event, index) => (
            <li key={index} className="text-ink-soft">
              {t(
                event.action === "backup.imported"
                  ? "backup.event.backup.imported"
                  : "backup.event.backup.exported",
              )}{" "}
              · {new Date(event.created_at).toLocaleString(locale)}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
