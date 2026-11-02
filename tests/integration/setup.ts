/**
 * Shared set-up for the integration files: the database under test, the
 * secrets, and model endpoints pointed at a local fake. Import it first.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

process.env.DATABASE_URL = TEST_DATABASE_URL ?? 'postgres://unused';
process.env.AUTH_SECRET ??= 'test-auth-secret-that-is-long-enough-0000';
process.env.ADMIN_SECRET_KEY ??= 'test-admin-secret-key-that-is-long-enough';
delete process.env.DATABASE_WS_PROXY;

export function pointModelsAt(baseUrl: string): void {
  process.env.GENERATION_BASE_URL = baseUrl;
  process.env.GENERATION_API_KEY = 'test-key';
  process.env.GENERATION_MODEL = 'fake-gen-1';
  process.env.EMBEDDING_BASE_URL = baseUrl;
  process.env.EMBEDDING_API_KEY = 'test-key';
  process.env.EMBEDDING_MODEL = 'fake-embed';
  process.env.TRANSCRIPTION_BASE_URL = baseUrl;
  process.env.TRANSCRIPTION_API_KEY = 'test-key';
  process.env.TRANSCRIPTION_MODEL = 'fake-whisper';
}

let counter = 0;
export function uniqueName(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
