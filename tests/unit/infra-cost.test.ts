/** Infrastructure rates (docs/audit/credit-import-audit.md P4): validated above zero, and priced exactly, rounding up. */
import { describe, expect, it } from 'vitest';
import { defaultInfraCostRates, parseInfraCostRates, storageCostPico, transferCostUsd } from '@/lib/domain/infra-cost';

const valid = { transferPerGb: '0.15', blobStoragePerGbMonth: '0.028', databaseStoragePerGbMonth: '0.55', databaseIndexFactor: '2', chunkRowBytes: 200 };

describe('infrastructure rates', () => {
  it('accepts positive rates and normalises their text', () => {
    expect(parseInfraCostRates({ ...valid, transferPerGb: '0.1500', databaseIndexFactor: 2.5 })).toEqual({ ...valid, transferPerGb: '0.15', databaseIndexFactor: '2.5' });
    expect(parseInfraCostRates({ ...valid, blobStoragePerGbMonth: '0.000000000001' })?.blobStoragePerGbMonth).toBe('0.000000000001');
  });

  it.each([
    ['a zero rate', { transferPerGb: '0' }],
    ['a zero with decimals', { databaseStoragePerGbMonth: '0.000' }],
    ['a negative rate', { blobStoragePerGbMonth: '-1' }],
    ['scientific notation', { transferPerGb: '1e-3' }],
    ['more than 12 decimals', { transferPerGb: '0.0000000000001' }],
    ['a missing rate', { transferPerGb: undefined }],
    ['an index factor below 1', { databaseIndexFactor: '0.99' }],
    ['an index factor above 100', { databaseIndexFactor: '101' }],
    ['no passage overhead', { chunkRowBytes: 0 }],
    ['a fractional passage overhead', { chunkRowBytes: 1.5 }],
  ])('refuses %s', (_case, change) => {
    expect(parseInfraCostRates({ ...valid, ...change })).toBeNull();
  });

  it('keeps the seeded defaults above zero', () => {
    expect(parseInfraCostRates({ ...defaultInfraCostRates() })).not.toBeNull();
  });

  it('prices transfer and storage exactly, rounding up', () => {
    expect(transferCostUsd(1_000_000_000, valid)).toBe('0.150000000000');
    expect(transferCostUsd(1, valid)).toBe('0.000000000150');
    expect(transferCostUsd(1, { transferPerGb: '0.000000000001' })).toBe('0.000000000001');
    const month = 28n * 24n * 3600n * 1000n;
    // 1 GB of Blob for 28 days at $0.028, and 1 GB of database at $0.55 twice over.
    expect(storageCostPico(1_000_000_000n * month, 0n, valid)).toBe(28_000_000_000n);
    expect(storageCostPico(0n, 1_000_000_000n * month, valid)).toBe(1_100_000_000_000n);
    expect(storageCostPico(0n, 1_000_000_000n * month, { ...valid, databaseIndexFactor: '1.5' })).toBe(825_000_000_000n);
    expect(storageCostPico(1n, 0n, valid)).toBe(1n);
  });
});
