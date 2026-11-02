/** Запросы к API: CSRF, ETag, единый разбор ошибок. */

const BASE = "/api/v1";
const CSRF_COOKIE = "kanbanly_csrf";
const SAFE_METHODS = new Set(["GET", "HEAD"]);

export interface ProblemItem {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get problems(): ProblemItem[] {
    return Array.isArray(this.details) ? (this.details as ProblemItem[]) : [];
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1] ?? "") : null;
}

let csrfRequest: Promise<void> | null = null;

async function ensureCsrf(): Promise<string> {
  const existing = readCookie(CSRF_COOKIE);
  if (existing) return existing;
  csrfRequest ??= fetch(`${BASE}/auth/csrf`, { credentials: "same-origin" }).then(() => {
    csrfRequest = null;
  });
  await csrfRequest;
  return readCookie(CSRF_COOKIE) ?? "";
}

export interface RequestOptions {
  json?: unknown;
  body?: BodyInit;
  query?: Record<string, string | number | boolean | undefined>;
  ifMatch?: number;
  headers?: Record<string, string>;
  raw?: boolean;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const suffix = params.size ? `?${params}` : "";
  return `${BASE}${path}${suffix}`;
}

async function toError(response: Response): Promise<ApiError> {
  try {
    const { error } = (await response.json()) as {
      error: { code: string; message: string; details: unknown };
    };
    return new ApiError(response.status, error.code, error.message, error.details);
  } catch {
    return new ApiError(response.status, "unknown", "Сервер недоступен. Повторите попытку.");
  }
}

export async function send(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (!SAFE_METHODS.has(method)) headers["X-CSRF-Token"] = await ensureCsrf();
  if (options.ifMatch !== undefined) headers["If-Match"] = `"${options.ifMatch}"`;
  let body = options.body;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.json);
  }
  const response = await fetch(buildUrl(path, options.query), {
    method,
    headers,
    body,
    credentials: "same-origin",
  });
  if (!response.ok) throw await toError(response);
  return response;
}

export async function request<T>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(method, path, options);
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions["query"]) => request<T>("GET", path, { query }),
  post: <T>(path: string, json?: unknown, options: RequestOptions = {}) =>
    request<T>("POST", path, { ...options, json: json ?? {} }),
  put: <T>(path: string, json: unknown, options: RequestOptions = {}) =>
    request<T>("PUT", path, { ...options, json }),
  patch: <T>(path: string, json: unknown, options: RequestOptions = {}) =>
    request<T>("PATCH", path, { ...options, json }),
  delete: <T>(path: string, json?: unknown) => request<T>("DELETE", path, { json }),
};

/** Скачивание через fetch: имя файла берётся из Content-Disposition. */
export async function downloadFrom(
  path: string,
  options: RequestOptions & { method?: string } = {},
): Promise<void> {
  const response = await send(options.method ?? "GET", path, options);
  const header = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(header)?.[1] ?? "download.json";
  saveBlob(await response.blob(), filename);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function saveJson(value: unknown, filename: string): void {
  saveBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), filename);
}
