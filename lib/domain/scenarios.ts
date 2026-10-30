/**
 * The four scenarios of agent-first-proposal.md 2.2, each with a landing
 * page at /for/{scenario}. Life holds the most private data and is promoted
 * after the others (2.2, last line): it has a page and a home-page block,
 * but no place in primary navigation and the lowest sitemap priority.
 */
export const SCENARIOS = ['life', 'work', 'business', 'creators'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && (SCENARIOS as readonly string[]).includes(value);
}

export function isPromoted(scenario: Scenario): boolean {
  return scenario !== 'life';
}

export function scenarioPath(scenario: Scenario): string {
  return `/for/${scenario}`;
}
