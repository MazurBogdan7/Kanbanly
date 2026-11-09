/** Клиентская предпроверка файлов: быстрый отказ до запроса. Полная проверка — на сервере. */
import { z } from "zod";

import { t } from "@/i18n";

export const TEMPLATE_MAX_BYTES = 1_048_576;
export const BACKUP_MAX_BYTES = 52_428_800;

const hexOrToken = () =>
  z.string().regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|\{[a-z][a-z0-9-]*\})$/, {
    message: t("file.badColor"),
  });

const envelope = () =>
  z.looseObject({
    format: z.literal("kanbanly.board-template", { message: t("file.badFormat") }),
    version: z
      .number({ message: t("file.badVersion") })
      .int()
      .min(1),
    meta: z.looseObject({
      name: z
        .string({ message: t("file.required") })
        .min(1, t("file.required"))
        .max(200),
    }),
    columns: z
      .array(
        z.looseObject({
          key: z.string({ message: t("file.required") }).min(1),
          name: z
            .string({ message: t("file.required") })
            .min(1)
            .max(120),
          color: hexOrToken().nullish(),
        }),
      )
      .min(1, t("file.noColumns")),
  });

export interface FileProblem {
  path: string;
  message: string;
}

export type ParseResult =
  | { ok: true; document: Record<string, unknown>; raw: string }
  | { ok: false; problems: FileProblem[] };

function formatPath(path: PropertyKey[]): string {
  return path.reduce<string>(
    (result, part) =>
      typeof part === "number"
        ? `${result}[${part}]`
        : result
          ? `${result}.${String(part)}`
          : String(part),
    "",
  );
}

export function parseTemplateText(raw: string): ParseResult {
  if (new Blob([raw]).size > TEMPLATE_MAX_BYTES) {
    return { ok: false, problems: [{ path: "", message: t("file.tooBig") }] };
  }
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return { ok: false, problems: [{ path: "", message: t("file.badJson") }] };
  }
  const result = envelope().safeParse(document);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }
  return { ok: true, document: document as Record<string, unknown>, raw };
}

const SAFE_IMAGE_URL = /^https:\/\/[^\s"'()<>\\]+$/;

export function isSafeImageUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && SAFE_IMAGE_URL.test(url);
}
