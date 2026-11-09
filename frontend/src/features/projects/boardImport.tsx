/** Импорт доски из файла: CSV (Excel, Trello, выгрузка Kanbanly) или JSON (шаблон, бэкап, задачи). */
import { FileUp, X } from "lucide-react";
import { useRef, useState } from "react";

import { Button, cx } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import type { BoardImportResult } from "@/lib/api/types";

import { formatSize, uploadFile } from "../workspace/api";

export const BOARD_FILE_ACCEPT = ".csv,.json,.gz,text/csv,application/json";

type Translate = ReturnType<typeof useT>["t"];

export function fileStem(name: string): string {
  return name.replace(/\.(csv|json|gz|txt|tsv)$/i, "").trim() || name;
}

export function importBoardFile(
  projectId: string,
  file: File,
  name?: string,
): Promise<BoardImportResult> {
  return uploadFile<BoardImportResult>(`/projects/${projectId}/boards/import`, file, {
    name: name?.trim() || undefined,
  });
}

/** Итог импорта: сколько досок создано и что пришлось поправить. */
export function reportImport(t: Translate, result: BoardImportResult) {
  const notes = (result.warnings ?? []).slice(0, 3).join(" · ");
  toast.info(
    result.boards.length === 1
      ? t("import.doneOne", { name: result.boards[0]?.name ?? "" })
      : t("import.doneMany", { count: result.boards.length }),
  );
  if (notes) toast.info(notes);
}

export function BoardFilePicker({
  file,
  onFile,
  optional,
}: {
  file: File | null;
  onFile: (file: File | null) => void;
  optional?: boolean;
}) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">
        {t("import.fileLabel")}
        {optional && <span className="font-normal text-ink-soft"> · {t("import.optional")}</span>}
      </span>
      <div
        data-testid="board-file-drop"
        className={cx(
          "grid gap-2 rounded-md border border-dashed p-3 text-sm transition-colors",
          over ? "border-brand bg-brand-soft" : "border-line-strong",
        )}
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          const dropped = event.dataTransfer.files[0];
          if (dropped) onFile(dropped);
        }}
      >
        {file ? (
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <FileUp className="size-4 shrink-0 text-brand" aria-hidden />
              <span className="truncate font-medium">{file.name}</span>
              <span className="shrink-0 text-xs text-ink-soft">{formatSize(file.size)}</span>
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("import.removeFile")}
              onClick={() => onFile(null)}
            >
              <X className="size-4" aria-hidden />
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => input.current?.click()}>
              <FileUp className="size-4" aria-hidden />
              {t("import.choose")}
            </Button>
            <span className="text-xs text-ink-soft">{t("import.drop")}</span>
          </div>
        )}
        <p className="text-xs text-ink-soft">{t("import.hint")}</p>
        <input
          ref={input}
          type="file"
          accept={BOARD_FILE_ACCEPT}
          hidden
          data-testid="board-file-input"
          aria-label={t("import.fileLabel")}
          onChange={(event) => {
            const selected = event.target.files?.[0];
            if (selected) onFile(selected);
            event.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
