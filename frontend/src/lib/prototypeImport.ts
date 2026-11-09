/**
 * Импорт задач из экспорта исходного HTML-прототипа (массив {status, title, desc, …}).
 *
 * Сопоставление ничего не знает о конкретном пресете: каждое поле задачи привязывается к тому
 * измерению доски, чьи значения (ключ, название или короткое имя) совпали с наибольшим числом
 * задач. Так «type: Код» уходит в «Тип работ», а «epic: core» — в «Эпик».
 */
import type { BoardConfig, DimensionTemplate, SampleCard } from "@/lib/api/types";

export interface PrototypeTask {
  status: string;
  title: string;
  desc?: string;
  [attribute: string]: unknown;
}

const RESERVED = new Set(["id", "status", "title", "desc", "description"]);

export function isPrototypeExport(document: unknown): document is PrototypeTask[] {
  return (
    Array.isArray(document) &&
    document.length > 0 &&
    document.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PrototypeTask).title === "string" &&
        typeof (item as PrototypeTask).status === "string",
    )
  );
}

function normalize(value: unknown): string {
  return String(value).trim().toLowerCase();
}

function digits(value: string): string {
  return value.replace(/\D/g, "");
}

/** Значение измерения для сырого значения задачи: сначала точное совпадение, затем по номеру. */
function matchValue(dimension: DimensionTemplate, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const wanted = normalize(raw);
  const values = dimension.values ?? [];
  const exact = values.find((value) =>
    [value.key, value.name, value.short].some((label) => label && normalize(label) === wanted),
  );
  if (exact) return exact.key;
  // «ms: 1» → значение с ключом m1 или коротким именем M1, если такое единственное.
  if (/^\d+$/.test(wanted)) {
    const numbered = values.filter((value) =>
      [value.key, value.short].some((label) => label && digits(label) === wanted),
    );
    if (numbered.length === 1) return numbered[0]!.key;
  }
  return null;
}

export interface PrototypeResult {
  samples: SampleCard[];
  mapping: Record<string, string>;
  skipped: number;
}

export function prototypeToSamples(tasks: PrototypeTask[], config: BoardConfig): PrototypeResult {
  const dimensions = config.dimensions ?? [];
  const attributes = [...new Set(tasks.flatMap((task) => Object.keys(task)))].filter(
    (name) => !RESERVED.has(name),
  );
  const scored = attributes.flatMap((attribute) =>
    dimensions.map((dimension) => ({
      attribute,
      dimension,
      hits: tasks.filter((task) => matchValue(dimension, task[attribute]) !== null).length,
    })),
  );
  scored.sort((a, b) => b.hits - a.hits);
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const { attribute, dimension, hits } of scored) {
    if (hits === 0 || attribute in mapping || used.has(dimension.key)) continue;
    mapping[attribute] = dimension.key;
    used.add(dimension.key);
  }

  const columnFor = (status: string) =>
    config.columns.find(
      (column) =>
        normalize(column.key) === normalize(status) || normalize(column.name) === normalize(status),
    )?.key;

  let skipped = 0;
  const samples: SampleCard[] = [];
  tasks.forEach((task, index) => {
    const column = columnFor(task.status);
    if (!column) {
      skipped += 1;
      return;
    }
    const values: Record<string, string> = {};
    for (const [attribute, key] of Object.entries(mapping)) {
      const dimension = dimensions.find((item) => item.key === key)!;
      const value = matchValue(dimension, task[attribute]);
      if (value) values[key] = value;
    }
    samples.push({
      key: `p${index + 1}`,
      column,
      title: task.title.slice(0, 500),
      description: String(task.desc ?? task.description ?? "").slice(0, 20000),
      values,
    });
  });
  return { samples, mapping, skipped };
}
