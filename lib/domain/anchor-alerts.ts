/**
 * What about anchoring is worth telling someone about, as a pure function.
 *
 * Deliberately short, and every condition here answers from state the chain and
 * the batch tables already hold -- nothing is compared against a configured
 * expectation. Anchoring is a side system that has to stay removable (proposal
 * 4.1); a rule that needs its own setting is a rule that can fall out of step
 * with the setting, and then the alert is about the configuration rather than
 * about the platform.
 *
 * What is not here is on the console as a number instead: how many times the
 * code object has been published to, how many transactions the signer has
 * sent. An operator who knows what to expect can see those at a glance, which
 * is the honest division of labour between software and judgement.
 *
 * Two disciplines, both from architecture.md 17.2:
 *
 * - the payload carries ids, counts and stable codes only. No leaf preimage, no
 *   key material, no asset title -- an alert travels further than a console
 *   session and lands in more inboxes than a database does;
 * - severity is about what the condition means, not how loud it feels. An empty
 *   account is critical because anchoring has stopped; a low one is a warning
 *   because it has months of runway.
 */

export type AnchorAlertSeverity = 'critical' | 'warning';

export type AnchorAlertCode =
  | 'monitor_unreachable'
  | 'signer_balance_empty'
  | 'signer_balance_low'
  | 'batches_failed'
  | 'backlog_stalled';

export interface AnchorAlert {
  code: AnchorAlertCode;
  severity: AnchorAlertSeverity;
  /** Ids, counts and codes. Never a preimage, a title or key material. */
  detail: Record<string, string | number>;
}

export interface AnchorAlertInput {
  configured: boolean;
  balanceOctas: number | null;
  minBalanceOctas: number;
  monitorReachable: boolean;
  monitorError: string | null;
  failedBatches: number;
  /** Age of the oldest batch still waiting to confirm, in milliseconds. */
  oldestOpenBatchAgeMs: number | null;
  sloWindowMs: number;
}

const SEVERITY_ORDER: Record<AnchorAlertSeverity, number> = { critical: 0, warning: 1 };

export function evaluateAnchorAlerts(input: AnchorAlertInput): AnchorAlert[] {
  /* Nothing configured is not an incident; it is a deployment without the
     side path enabled at all (proposal 4.1). */
  if (!input.configured) return [];

  const alerts: AnchorAlert[] = [];

  /*
   * A check that cannot answer says so, rather than reading as a clean bill of
   * health: while it is down, "nothing to report" carries no information.
   */
  if (!input.monitorReachable) {
    alerts.push({
      code: 'monitor_unreachable',
      severity: 'critical',
      detail: { reason: input.monitorError ?? 'unknown' },
    });
  }

  if (input.balanceOctas !== null) {
    if (input.balanceOctas === 0) {
      /* Empty is not "low": anchoring has stopped, not slowed. */
      alerts.push({ code: 'signer_balance_empty', severity: 'critical', detail: { octas: 0 } });
    } else if (input.balanceOctas < input.minBalanceOctas) {
      alerts.push({
        code: 'signer_balance_low',
        severity: 'warning',
        detail: { octas: input.balanceOctas, floor: input.minBalanceOctas },
      });
    }
  }

  if (input.failedBatches > 0) {
    alerts.push({
      code: 'batches_failed',
      severity: 'warning',
      detail: { count: input.failedBatches },
    });
  }

  /*
   * Measured against the SLO window rather than a fixed number of ticks: a
   * batch that has been open longer than the window it promised is late by
   * definition, whatever the schedule happens to be (proposal 4.8).
   */
  if (input.oldestOpenBatchAgeMs !== null && input.oldestOpenBatchAgeMs > input.sloWindowMs) {
    alerts.push({
      code: 'backlog_stalled',
      severity: 'warning',
      detail: {
        oldestOpenMinutes: Math.round(input.oldestOpenBatchAgeMs / 60_000),
        sloMinutes: Math.round(input.sloWindowMs / 60_000),
      },
    });
  }

  return alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** One alert as a log line: stable, greppable, and safe to forward. */
export function formatAnchorAlert(alert: AnchorAlert): string {
  const detail = Object.entries(alert.detail)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  return `anchor-alert ${alert.severity} ${alert.code}${detail ? ` ${detail}` : ''}`;
}
