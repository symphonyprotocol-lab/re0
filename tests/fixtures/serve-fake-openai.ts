/**
 * The fake model endpoint on a fixed port, for walking the app through by
 * hand under `next dev` without spending on real models:
 *
 *   npx tsx tests/fixtures/serve-fake-openai.ts 5443 [delay ms between streamed pieces]
 *
 * then point `LLM_BASE_URL=http://127.0.0.1:5443/v1` (with any `LLM_API_KEY`)
 * at it. Embeddings, streamed answers and timestamped transcription, as in
 * the integration tests.
 */
import { startFakeOpenAi } from './fake-openai';

void startFakeOpenAi(Number(process.argv[2] ?? 5443), { delayMs: Number(process.argv[3] ?? 0) }).then((fake) => {
  fake.transcripts.set('0:2', 'The lighthouse keeper records the tide tables at dawn, every day of the year.');
  console.log(`fake OpenAI-compatible endpoint at ${fake.baseUrl}`);
});
