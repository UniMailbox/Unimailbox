import { z } from 'zod';
import { useSyncExternalStore } from 'react';
import { zhCN } from './zh-CN';
export type Language = 'en' | 'zh-CN';
let language: Language = readLanguage();
const listeners = new Set<() => void>();
function readLanguage(): Language {
  try {
    return localStorage.getItem('unimailbox-language') === 'zh-CN' ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}
export function getLanguage(): Language {
  return language;
}
export function setLanguage(value: Language): void {
  language = value;
  document.documentElement.lang = value;
  try {
    localStorage.setItem('unimailbox-language', value);
  } catch {
    /* Restricted storage: server preference still persists. */
  }
  listeners.forEach((listener) => listener());
}
export function translate(text: string, locale: Language = language): string {
  if (locale === 'en') return text;
  const key = text.trim().replace(/\s+/g, ' ');
  const translated = zhCN[key];
  return translated === undefined ? text : text.replace(text.trim(), translated);
}
export function useLanguage(): Language {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getLanguage,
    getLanguage,
  );
}
export function useT(): (text: string, params?: Record<string, string | number>) => string {
  const locale = useLanguage();
  return (text, params) => {
    let result = translate(text, locale);
    for (const [key, value] of Object.entries(params ?? {}))
      result = result.replaceAll(`{${key}}`, String(value));
    return result;
  };
}

// Validation errors carry codes, so already-mounted forms follow language changes.
z.setErrorMap((issue) => ({
  message:
    issue.code === 'invalid_string' && issue.validation === 'email'
      ? 'INVALID_EMAIL'
      : issue.code === 'too_small'
        ? 'FIELD_REQUIRED'
        : 'VALIDATION_ERROR',
}));
