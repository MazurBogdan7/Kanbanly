import { useEffect, useState } from "react";

import { Button, ErrorNote, Modal, Toggle } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api, request } from "@/lib/api/client";
import type { TemplatePreview } from "@/lib/api/types";
import { parseTemplateText, type FileProblem } from "@/lib/templateFile";

/** Что взять из файла при импорте на существующую доску. */
export interface ImportChoices {
  look: boolean;
  cards: boolean;
}

interface Loaded {
  raw: string;
  document: Record<string, unknown>;
  preview: TemplatePreview;
}

function Problems({ items }: { items: FileProblem[] }) {
  return (
    <ul className="grid max-h-48 gap-1 overflow-y-auto rounded-md bg-danger-soft p-2 text-xs text-danger">
      {items.map((item, index) => (
        <li key={index}>
          {item.path && <code className="font-mono">{item.path}: </code>}
          {item.message}
        </li>
      ))}
    </ul>
  );
}

/** Превью перед импортом: предпроверка zod на клиенте, затем строгая проверка на сервере. */
export function TemplateImportDialog({
  file,
  onClose,
  onConfirm,
  confirmLabel,
  withChoices,
}: {
  file: File;
  onClose: () => void;
  onConfirm: (
    document: Record<string, unknown>,
    raw: string,
    choices: ImportChoices,
  ) => Promise<unknown>;
  confirmLabel: string;
  /** Импорт на доску: можно взять оформление со структурой, карточки или и то и другое. */
  withChoices?: boolean;
}) {
  const { t } = useT();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [choices, setChoices] = useState<ImportChoices>({ look: true, cards: true });
  const [problems, setProblems] = useState<FileProblem[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const parsed = parseTemplateText(await file.text());
      if (!parsed.ok) {
        if (alive) setProblems(parsed.problems);
        return;
      }
      const preview = await request<TemplatePreview>("POST", "/templates/import/preview", {
        body: parsed.raw,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!alive) return;
      if (preview.valid) setLoaded({ raw: parsed.raw, document: parsed.document, preview });
      else setProblems((preview.errors ?? []) as FileProblem[]);
    })().catch((error: unknown) => {
      if (alive) {
        toast.error(error);
        onClose();
      }
    });
    return () => {
      alive = false;
    };
  }, [file, onClose]);

  const counts = loaded?.preview.counts ?? {};
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={t("templates.previewTitle")}>
      <div className="grid gap-3">
        <p className="text-sm text-ink-soft">{file.name}</p>
        {!loaded && problems.length === 0 && <p className="text-sm">{t("common.loading")}</p>}
        {problems.length > 0 && (
          <>
            <ErrorNote message={t("templates.invalid")} />
            <Problems items={problems} />
          </>
        )}
        {loaded && (
          <>
            <p className="text-sm font-medium">{loaded.preview.name}</p>
            <p className="text-sm" data-testid="import-counts">
              {t("templates.willCreate", {
                columns: counts.columns ?? 0,
                dimensions: counts.dimensions ?? 0,
                fields: counts.fields ?? 0,
                cards: counts.cards ?? 0,
              })}
            </p>
            {(loaded.preview.warnings?.length ?? 0) > 0 && (
              <details className="text-xs text-warning">
                <summary>
                  {t("templates.warnings")}: {loaded.preview.warnings?.length}
                </summary>
                <ul>
                  {loaded.preview.warnings?.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </details>
            )}
            {withChoices && (
              <div className="grid gap-2 rounded-md border border-line p-3">
                <Toggle
                  label={t("templates.applyLook")}
                  checked={choices.look}
                  onChange={(look) => setChoices({ ...choices, look })}
                />
                <Toggle
                  label={t("templates.applyCards", { count: counts.cards ?? 0 })}
                  checked={choices.cards && (counts.cards ?? 0) > 0}
                  disabled={(counts.cards ?? 0) === 0}
                  onChange={(cards) => setChoices({ ...choices, cards })}
                />
              </div>
            )}
            <Button
              variant="primary"
              loading={busy}
              disabled={withChoices && !choices.look && !(choices.cards && (counts.cards ?? 0) > 0)}
              onClick={() => {
                setBusy(true);
                onConfirm(loaded.document, loaded.raw, {
                  look: choices.look,
                  cards: choices.cards && (counts.cards ?? 0) > 0,
                })
                  .catch(toast.error)
                  .finally(() => setBusy(false));
              }}
            >
              {confirmLabel}
            </Button>
          </>
        )}
      </div>
    </Modal>
  );
}

export const uploadTemplate = (raw: string) =>
  request("POST", "/templates/import", {
    body: raw,
    headers: { "Content-Type": "application/octet-stream" },
  });

export const deleteTemplate = (id: string) => api.delete(`/templates/${id}`);
