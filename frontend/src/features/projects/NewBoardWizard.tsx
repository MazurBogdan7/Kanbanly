/** Мастер «Новая доска»: основа → тема → структура → готово. */
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

import { Button, cx, ErrorNote, Modal, TextField, Toggle } from "@/components/ui";
import { toast } from "@/components/ui/toast";
import { useT } from "@/i18n";
import { api } from "@/lib/api/client";
import type {
  BoardOut,
  BoardTemplate,
  ColumnTemplate,
  DimensionTemplate,
  FieldTemplate,
} from "@/lib/api/types";
import { parseTemplateText, type FileProblem } from "@/lib/templateFile";

import { PALETTES } from "../settings/config-ops";
import { TemplateThumbnail } from "../templates/TemplateThumbnail";
import { usePresets, useTemplates } from "../templates/TemplatesPage";

type Source = "preset" | "mine" | "blank" | "file";

const BLANK: BoardTemplate = {
  format: "kanbanly.board-template",
  version: 1,
  meta: { name: "" },
  columns: [
    { key: "todo", name: "К работе", kind: "todo" },
    { key: "doing", name: "В работе", kind: "in_progress" },
    { key: "done", name: "Готово", kind: "done" },
  ],
};

interface Suggestion {
  label: "wizard.setEpics" | "wizard.setPriority" | "wizard.setClient";
  dimensions: DimensionTemplate[];
  fields?: FieldTemplate[];
}

const SUGGESTIONS: Suggestion[] = [
  {
    label: "wizard.setEpics",
    dimensions: [
      {
        key: "epic",
        name: "Эпик",
        values: [
          { key: "core", name: "Основное", color: "#3B5BDB" },
          { key: "extra", name: "Дополнительное", color: "#0CA678" },
        ],
      },
      {
        key: "milestone",
        name: "Веха",
        type: "ordered_select",
        values: [
          { key: "m1", name: "M1", short: "M1" },
          { key: "m2", name: "M2", short: "M2" },
        ],
      },
    ],
  },
  {
    label: "wizard.setPriority",
    dimensions: [
      {
        key: "priority",
        name: "Приоритет",
        type: "ordered_select",
        values: [
          { key: "high", name: "Высокий", color: "#C92A2A" },
          { key: "normal", name: "Обычный", color: "#E67700" },
          { key: "low", name: "Низкий", color: "#2F9E44" },
        ],
      },
      {
        key: "type",
        name: "Тип",
        values: [
          { key: "feature", name: "Фича" },
          { key: "bug", name: "Баг" },
        ],
      },
    ],
  },
  {
    label: "wizard.setClient",
    dimensions: [
      {
        key: "client",
        name: "Клиент",
        values: [{ key: "default", name: "Клиент", color: "#3B5BDB" }],
      },
    ],
    fields: [{ key: "deadline", name: "Дедлайн", type: "date", show_on_face: true }],
  },
];

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        "grid gap-1 rounded-md border p-2 text-left text-sm transition-colors",
        selected ? "border-brand bg-brand-soft" : "border-line hover:border-line-strong",
      )}
    >
      {children}
    </button>
  );
}

export function NewBoardWizard({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const presets = usePresets();
  const templates = useTemplates();
  const [step, setStep] = useState(1);
  const [source, setSource] = useState<Source>("preset");
  const [base, setBase] = useState<BoardTemplate | null>(null);
  const [name, setName] = useState("");
  const [samples, setSamples] = useState(true);
  const [palette, setPalette] = useState<string>("");
  const [suggestion, setSuggestion] = useState<number | null>(null);
  const [columns, setColumns] = useState<string>("");
  const [problems, setProblems] = useState<FileProblem[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const pick = (template: BoardTemplate) => {
    setBase(template);
    setName(template.meta.name);
    setProblems([]);
  };

  const readFile = async (file: File) => {
    const parsed = parseTemplateText(await file.text());
    if (parsed.ok) pick(parsed.document as unknown as BoardTemplate);
    else setProblems(parsed.problems);
  };

  const template = useMemo<BoardTemplate>(() => {
    const source_template = base ?? BLANK;
    const result: BoardTemplate = structuredClone(source_template);
    result.meta = { ...result.meta, name: name || t("wizard.title") };
    const chosen = PALETTES.find((item) => item.name === palette);
    if (chosen) result.theme = { ...result.theme, tokens: chosen.tokens, mode: chosen.mode };
    const set = suggestion === null ? null : SUGGESTIONS[suggestion];
    if (set) {
      const existing = new Set(result.dimensions?.map((item) => item.key));
      result.dimensions = [
        ...(result.dimensions ?? []),
        ...set.dimensions.filter((item) => !existing.has(item.key)),
      ];
      const fieldKeys = new Set(result.fields?.map((item) => item.key));
      result.fields = [
        ...(result.fields ?? []),
        ...(set.fields ?? []).filter((item) => !fieldKeys.has(item.key)),
      ];
    }
    const names = columns
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    if (names.length && !base) {
      result.columns = names.map<ColumnTemplate>((item, index) => ({
        key: `col-${index + 1}`,
        name: item,
        kind: index === names.length - 1 ? "done" : index === 0 ? "todo" : "in_progress",
      }));
    }
    return result;
  }, [base, columns, name, palette, suggestion, t]);

  const create = useMutation({
    mutationFn: () =>
      api.post<BoardOut>(`/projects/${projectId}/boards`, {
        name,
        template,
        include_samples: samples,
      }),
    onSuccess: (board) =>
      void navigate({
        to: "/boards/$boardId",
        params: { boardId: board.id },
        search: { builder: 1 },
      }),
    onError: toast.error,
  });

  const sources: [Source, Parameters<typeof t>[0]][] = [
    ["preset", "wizard.sourcePreset"],
    ["mine", "wizard.sourceMine"],
    ["blank", "wizard.sourceBlank"],
    ["file", "wizard.sourceFile"],
  ];
  const canContinue = source === "blank" ? !!name : !!base && !!name;

  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={t("wizard.title")} width={720}>
      <ol className="mb-4 flex gap-2 text-xs" aria-label={t("wizard.title")}>
        {(["wizard.step1", "wizard.step2", "wizard.step3", "wizard.step4"] as const).map(
          (label, index) => (
            <li
              key={label}
              aria-current={step === index + 1 ? "step" : undefined}
              className={cx(
                "flex-1 rounded-sm px-2 py-1 text-center",
                step === index + 1 ? "bg-brand-soft font-medium" : "bg-raised text-ink-soft",
              )}
            >
              {index + 1}. {t(label)}
            </li>
          ),
        )}
      </ol>

      {step === 1 && (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-1" role="group" aria-label={t("wizard.step1")}>
            {sources.map(([value, label]) => (
              <Button
                key={value}
                size="sm"
                variant={source === value ? "primary" : "secondary"}
                aria-pressed={source === value}
                onClick={() => {
                  setSource(value);
                  setBase(null);
                }}
              >
                {t(label)}
              </Button>
            ))}
          </div>
          {source === "preset" && (
            <div className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
              {presets.data?.map((preset) => (
                <Choice
                  key={preset.key}
                  selected={base?.meta.name === preset.data.meta.name}
                  onClick={() => pick(preset.data)}
                >
                  <TemplateThumbnail template={preset.data} width={300} />
                  <span className="font-medium">{preset.data.meta.name}</span>
                </Choice>
              ))}
            </div>
          )}
          {source === "mine" &&
            (templates.data?.length ? (
              <div className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                {templates.data.map((item) => (
                  <Choice
                    key={item.id}
                    selected={base?.meta.name === item.data.meta.name}
                    onClick={() => pick(item.data)}
                  >
                    <TemplateThumbnail template={item.data} width={300} />
                    <span className="font-medium">{item.name}</span>
                  </Choice>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-soft">{t("wizard.noTemplates")}</p>
            ))}
          {source === "file" && (
            <div
              className="grid place-items-center rounded-md border border-dashed border-line-strong p-6 text-sm"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];
                if (file) void readFile(file);
              }}
            >
              <Button onClick={() => fileInput.current?.click()}>{t("wizard.dropFile")}</Button>
              <input
                ref={fileInput}
                type="file"
                accept=".json"
                hidden
                aria-label={t("wizard.sourceFile")}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                }}
              />
              {base && <p className="mt-2 font-medium">{base.meta.name}</p>}
            </div>
          )}
          {problems.length > 0 && (
            <ErrorNote
              message={problems.map((item) => `${item.path}: ${item.message}`).join("; ")}
            />
          )}
          <TextField
            label={t("wizard.boardName")}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {(base?.sample_cards?.length ?? 0) > 0 && (
            <Toggle label={t("wizard.keepCards")} checked={samples} onChange={setSamples} />
          )}
        </div>
      )}

      {step === 2 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Choice selected={palette === ""} onClick={() => setPalette("")}>
            {t("wizard.keepTheme")}
          </Choice>
          {PALETTES.map((item) => (
            <Choice
              key={item.name}
              selected={palette === item.name}
              onClick={() => setPalette(item.name)}
            >
              <span className="flex h-6 overflow-hidden rounded-sm" aria-hidden>
                {["bg", "surface-2", "accent", "text"].map((token) => (
                  <i key={token} className="flex-1" style={{ background: item.tokens[token] }} />
                ))}
              </span>
              {item.name}
            </Choice>
          ))}
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-3">
          {!base && (
            <TextField
              label={t("wizard.columns")}
              placeholder="К работе, В работе, Готово"
              value={columns}
              onChange={(event) => setColumns(event.target.value)}
            />
          )}
          <p className="text-xs font-medium text-ink-soft">{t("wizard.suggestions")}</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {SUGGESTIONS.map((item, index) => (
              <Choice
                key={item.label}
                selected={suggestion === index}
                onClick={() => setSuggestion(suggestion === index ? null : index)}
              >
                {t(item.label)}
              </Choice>
            ))}
          </div>
        </div>
      )}

      {step === 4 && <p className="text-sm">{t("wizard.ready")}</p>}

      <div className="mt-4 flex justify-between gap-2">
        <Button onClick={() => (step === 1 ? onClose() : setStep(step - 1))}>
          {step === 1 ? t("common.cancel") : t("common.back")}
        </Button>
        {step < 4 ? (
          <Button variant="primary" disabled={!canContinue} onClick={() => setStep(step + 1)}>
            {t("common.continue")}
          </Button>
        ) : (
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
            {t("wizard.create")}
          </Button>
        )}
      </div>
    </Modal>
  );
}
