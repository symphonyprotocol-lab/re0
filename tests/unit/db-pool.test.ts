import { describe, expect, it, vi } from 'vitest';
import { createPool } from '@/lib/infra/db';

describe('database pool', () => {
  it('survives an idle client being dropped instead of crashing the instance', async () => {
    const pool = createPool('postgres://user:pw@127.0.0.1:1/none');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    /* An EventEmitter with no `error` listener throws: that is the uncaught exception. */
    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('idle client dropped'));
    logged.mockRestore();
    await pool.end();
  });
});
