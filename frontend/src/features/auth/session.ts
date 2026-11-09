import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useLocale, type Locale } from "@/i18n";
import { api, ApiError } from "@/lib/api/client";
import type { UserOut } from "@/lib/api/types";

import { keys } from "../boards/api";

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => {
      try {
        const user = await api.get<UserOut>("/auth/me");
        useLocale.getState().setLocale(user.locale as Locale);
        return user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSetSession() {
  const queryClient = useQueryClient();
  return (user: UserOut | null) => {
    queryClient.clear();
    queryClient.setQueryData(keys.me, user);
  };
}

/**
 * Осознанный выход: сначала уходим на страницу входа, потом сбрасываем данные.
 * В обратном порядке оболочка приняла бы выход за истёкшую сессию и предложила бы вернуться назад.
 */
export function useSignOut() {
  const navigate = useNavigate();
  const setSession = useSetSession();
  return async () => {
    await navigate({ to: "/login" });
    setSession(null);
  };
}

export type StrengthLabel = "tooShort" | "weak" | "fair" | "good" | "strong";

export function passwordStrength(password: string): { score: number; label: StrengthLabel } {
  if (password.length < 10) return { score: 0, label: "tooShort" };
  let score = 1;
  if (password.length >= 14) score += 1;
  if (/[a-zа-я]/.test(password) && /[A-ZА-Я]/.test(password)) score += 1;
  if (/\d/.test(password) && /[^\p{L}\d]/u.test(password)) score += 1;
  if (new Set(password).size < 6) score = 1;
  const labels: StrengthLabel[] = ["tooShort", "weak", "fair", "good", "strong"];
  return { score, label: labels[score] ?? "strong" };
}
