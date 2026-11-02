/**
 * The two domain checks that leave the building (from the old
 * `challenge.ts`): a DNS TXT lookup and a well-known file fetch. Both answer
 * only whether the challenge was there -- never what was -- so a claim cannot
 * be turned into a probe that reads other people's DNS or pages back.
 *
 * The well-known fetch goes through the knowledge fetcher on purpose: it
 * refuses private addresses and checks every redirect, and the check gets no
 * exemption from those rules.
 */
import { Resolver } from 'node:dns/promises';
import { dnsRecordName, txtMatches, wellKnownMatches, wellKnownUrl } from '@/lib/domain/sources';
import { fetchDocument } from '@/lib/infra/connectors/http';

const DNS_TIMEOUT_MS = 5_000;
const WELL_KNOWN_MAX_BYTES = 4_096;

export type ChallengeOutcome = 'matched' | 'not_found' | 'unreachable';

/** The resolver we control (never one the claimant names); `CLAIM_DNS_RESOLVERS` pins public ones. */
function resolver(): Resolver {
  const instance = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  const configured = process.env.CLAIM_DNS_RESOLVERS?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured && configured.length > 0) instance.setServers(configured);
  return instance;
}

export async function checkDnsChallenge(domain: string, challenge: string): Promise<ChallengeOutcome> {
  try {
    return txtMatches(await resolver().resolveTxt(dnsRecordName(domain)), challenge) ? 'matched' : 'not_found';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN' ? 'not_found' : 'unreachable';
  }
}

export async function checkWellKnownChallenge(domain: string, challenge: string): Promise<ChallengeOutcome> {
  try {
    const resource = await fetchDocument(wellKnownUrl(domain), { accept: 'text/plain, */*;q=0.5', maxBytes: WELL_KNOWN_MAX_BYTES, timeoutMs: 10_000 });
    return wellKnownMatches(resource.body, challenge) ? 'matched' : 'not_found';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'source_missing' || code === 'source_too_large' ? 'not_found' : 'unreachable';
  }
}

export interface ChallengeChecks {
  dns(domain: string, challenge: string): Promise<ChallengeOutcome>;
  wellKnown(domain: string, challenge: string): Promise<ChallengeOutcome>;
}

export const challengeChecks: ChallengeChecks = { dns: checkDnsChallenge, wellKnown: checkWellKnownChallenge };
