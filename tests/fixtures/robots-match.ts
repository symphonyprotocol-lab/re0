import robots from '@/app/robots';

/** One robots.txt rule as a matcher: `*` is any run of characters, a final `$` ends the URL. */
function pattern(rule: string): RegExp {
  const anchored = rule.endsWith('$');
  const body = (anchored ? rule.slice(0, -1) : rule).split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * Whether the site's robots.txt lets a crawler fetch `url` (path and query),
 * the way Google reads it (RFC 9309): the longest matching rule wins, and
 * `Allow` wins a tie.
 */
export function crawlable(url: string): boolean {
  const { rules } = robots();
  const group = (Array.isArray(rules) ? rules[0] : rules) ?? {};
  const list = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
  let best: { length: number; allow: boolean } = { length: -1, allow: true };
  for (const [rulesOf, allow] of [[list(group.allow), true], [list(group.disallow), false]] as const) {
    for (const rule of rulesOf) {
      if (!pattern(rule).test(url)) continue;
      if (rule.length > best.length || (rule.length === best.length && allow)) best = { length: rule.length, allow };
    }
  }
  return best.allow;
}
