/**
 * The terms state the public posts' fees and limits as placeholders the
 * page fills from the code constants (lib/services/public-copy.ts), so the
 * terms never disagree with what is charged. The privacy policy states no
 * number and is not filled.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { messages } from '@/i18n';

const filled = readFileSync('lib/services/public-copy.ts', 'utf8');
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!);

describe('legal pages and public posts (2026-11-19)', () => {
  for (const locale of ['zh', 'en'] as const) {
    const legal = messages(locale).legal;
    it(`fills every placeholder of the terms in ${locale}`, () => {
      for (const section of Object.values(legal.terms)) {
        if (typeof section !== 'object') continue;
        for (const name of placeholders(section.body)) expect(filled, name).toMatch(new RegExp(`\\b${name}:`));
      }
      expect(placeholders(legal.terms.s6.body)).toEqual(expect.arrayContaining(['postFreePerDay', 'postFee', 'postDailyLimit', 'postSummaryFee', 'postSummaryFreeRewrites']));
      expect(placeholders(legal.terms.posts.body)).toEqual(expect.arrayContaining(['postReportThreshold', 'answerReportThreshold']));
      /* The paid requests' refund wait is the constant, not a number written in (#164 review). */
      expect(placeholders(legal.terms.reeAnswers.body)).toContain('postPaidRequestDays');
      expect(legal.terms.reeAnswers.body).not.toMatch(/[0-9] ?(天|days)/);
    });

    it(`leaves no placeholder in the privacy policy in ${locale}`, () => {
      for (const section of Object.values(legal.privacy)) if (typeof section === 'object') expect(placeholders(section.body)).toEqual([]);
    });
  }
});
