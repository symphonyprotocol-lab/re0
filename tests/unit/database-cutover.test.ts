/** What a production build may do with each database state (scripts/database-cutover.mts). */
import { describe, expect, it } from 'vitest';
import { LEGACY_LAST_WHEN, planDeploy, type DatabaseState } from '../../scripts/database-cutover.mjs';

const base: DatabaseState = {
  public: 'legacy',
  journalLast: LEGACY_LAST_WHEN,
  hasJournalSchema: true,
  legacyArchived: false,
  legacyJournalArchived: false,
  rebuildParked: false,
  parkedJournal: false,
  vectorSchema: 'public',
};

describe('production deploy plan', () => {
  it('archives the old app exactly once, from its own journal', () => {
    expect(planDeploy(base)).toMatchObject({ archive: true });
    expect(planDeploy({ ...base, journalLast: null, hasJournalSchema: false })).toMatchObject({ archive: true });
  });

  it('only migrates a rebuild or an empty database', () => {
    expect(planDeploy({ ...base, public: 'rebuild', journalLast: 1794149110765 })).toMatchObject({ archive: false });
    /* Archived by a build whose migrations then failed would have rolled back too; empty is a fresh install. */
    expect(planDeploy({ ...base, public: 'empty', journalLast: null, hasJournalSchema: false, legacyArchived: true })).toMatchObject({ archive: false });
  });

  it('refuses while the rebuild is parked by a rollback', () => {
    const plan = planDeploy({ ...base, rebuildParked: true, parkedJournal: true });
    expect(plan).toHaveProperty('refuse');
    expect('refuse' in plan && plan.refuse).toContain('db:cutover -- resume');
  });

  it('refuses anything it cannot explain', () => {
    expect(planDeploy({ ...base, legacyArchived: true })).toHaveProperty('refuse');
    expect(planDeploy({ ...base, legacyJournalArchived: true })).toHaveProperty('refuse');
    expect(planDeploy({ ...base, journalLast: LEGACY_LAST_WHEN + 1 })).toHaveProperty('refuse');
    expect(planDeploy({ ...base, public: 'both' })).toHaveProperty('refuse');
    expect(planDeploy({ ...base, public: 'unknown' })).toHaveProperty('refuse');
  });
});
