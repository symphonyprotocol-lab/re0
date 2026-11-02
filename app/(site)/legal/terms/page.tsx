import type { Metadata } from 'next';
import { serverMessages } from '@/i18n/server';
import { LegalDocument } from '@/components/site/legal-document';

const IDS = ['account', 'credits', 'plan-pack', 'payment', 'refunds', 'usage', 'payouts', 'content', 'acceptable-use', 'liability'] as const;
const KEYS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'] as const;

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.legal.terms.title };
}

/** `/legal/terms`. */
export default async function TermsPage() {
  const { t } = await serverMessages();
  const d = t.legal.terms;
  return (
    <LegalDocument
      eyebrow="RE0 / TERMS"
      title={d.title}
      lede={d.lede}
      updated={t.legal.updated}
      contentsLabel={t.legal.contents}
      sections={KEYS.map((key, index) => ({ id: IDS[index]!, ...d[key] }))}
      footnote={t.legal.footnote}
      other={{ href: '/legal/privacy', label: t.legal.privacy.title }}
    />
  );
}
