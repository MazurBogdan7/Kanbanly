import { create } from "zustand";

import { en } from "./en";
import { ru } from "./ru";

export type Locale = "ru" | "en";
export type MessageKey = keyof typeof ru;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { ru, en };

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

function initialLocale(): Locale {
  try {
    return localStorage.getItem("kanbanly-locale") === "en" ? "en" : "ru";
  } catch {
    return "ru";
  }
}

export const useLocale = create<LocaleState>((set) => ({
  locale: initialLocale(),
  setLocale: (locale) => {
    try {
      localStorage.setItem("kanbanly-locale", locale);
    } catch {
      // Приватный режим: язык живёт до перезагрузки.
    }
    document.documentElement.lang = locale;
    set({ locale });
  },
}));

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = dictionaries[locale][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
}

/** Склонение: «1 карточка / 3 карточки / 5 карточек». Формы лежат через | в словаре. */
export function pluralize(locale: Locale, key: MessageKey, count: number): string {
  const forms = dictionaries[locale][key].split("|");
  const category = new Intl.PluralRules(locale).select(count);
  const order = locale === "ru" ? ["one", "few", "many"] : ["one", "other"];
  const index = Math.max(order.indexOf(category), 0);
  const form = forms[index] ?? forms[forms.length - 1] ?? "";
  return `${count} ${form}`;
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  return translate(useLocale.getState().locale, key, params);
}

export function useT() {
  const locale = useLocale((state) => state.locale);
  return {
    locale,
    t: (key: MessageKey, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    plural: (key: MessageKey, count: number) => pluralize(locale, key, count),
  };
}
