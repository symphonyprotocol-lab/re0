import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { I18nProvider } from '@/i18n/client';
import { serverMessages } from '@/i18n/server';
import { ToastProvider } from '@/components/ui/toast';
import { NavigationProvider } from '@/components/shell/navigation-provider';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'RE0', template: '%s · RE0' },
  description: 'Create a Ree, give it some knowledge, and it answers only from that knowledge.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f5f3ff' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { locale, t } = await serverMessages();
  return (
    <html lang={locale === 'zh' ? 'zh-CN' : 'en'} className={`${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh font-sans">
        <I18nProvider locale={locale} t={t}>
          <ToastProvider><NavigationProvider>{children}</NavigationProvider></ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
