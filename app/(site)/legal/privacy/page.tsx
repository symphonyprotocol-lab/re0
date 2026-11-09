import type { Metadata } from 'next';
import { serverMessages } from '@/i18n/server';
import { LegalDocument } from '@/components/site/legal-document';

const IDS = ['collect', 'use', 'providers', 'identity', 'tax', 'retention', 'cookies', 'rights', 'security'] as const;
const KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.legal.privacy.title };
}

/** `/legal/privacy`, including identity documents (KYC) and tax information (2.3) ahead of payouts. */
export default async function PrivacyPage() {
  const { t } = await serverMessages();
  const d = t.legal.privacy;
  return (
    <LegalDocument
      eyebrow="RE0 / PRIVACY"
      title={d.title}
      lede={d.lede}
      updated={t.legal.updated}
      contentsLabel={t.legal.contents}
      sections={KEYS.map((key, index) => ({ id: IDS[index]!, ...d[key] }))}
      footnote={t.legal.footnote}
      other={{ href: '/legal/terms', label: t.legal.terms.title }}
    />
  );
}
