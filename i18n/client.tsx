'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { Messages } from './index';
import type { Locale } from './locale';

const I18nContext = createContext<{ locale: Locale; t: Messages } | null>(null);

export function I18nProvider({ locale, t, children }: { locale: Locale; t: Messages; children: ReactNode }) {
  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): { locale: Locale; t: Messages } {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}
