import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { toast } from "@/components/ui/toast";
import { t } from "@/i18n";
import { ApiError } from "@/lib/api/client";

import { keys } from "../features/boards/api";

/** Сессия истекла посреди работы: сбрасываем пользователя, оболочка отправит на вход. */
function handleExpiredSession(client: QueryClient, error: unknown): void {
  if (!(error instanceof ApiError) || error.status !== 401) return;
  if (!client.getQueryData(keys.me)) return;
  client.setQueryData(keys.me, null);
  toast.info(t("auth.expired"));
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (error) => handleExpiredSession(client, error) }),
    mutationCache: new MutationCache({ onError: (error) => handleExpiredSession(client, error) }),
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      },
    },
  });
  return client;
}

/** Куда вернуться после входа. Только локальный путь: ссылка не уводит на чужой сайт. */
export function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}
