/**
 * The model call log (rebuild-proposal.md 7: usage goes to the logs and the
 * cost board, never to the bill). One row per call, written after the call
 * and never in its way: a failed insert is only reported.
 */
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { ModelKind } from '@/lib/constants';
import { db, schema } from '@/lib/infra/db';

/*
 * The provider-level types, derived from `ai` rather than imported from
 * `@ai-sdk/provider`: that package is only a dependency of `ai`, and Vercel's
 * pnpm install does not let us import a package we do not list ourselves.
 */
type LanguageModelV4 = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type LanguageModelV4StreamPart = Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;
type LanguageModelV4Usage = Extract<LanguageModelV4StreamPart, { type: 'finish' }>['usage'];

export interface ModelCallRecord {
  kind: ModelKind;
  model: string;
  configId: string | null;
  inputTokens?: number;
  outputTokens?: number;
  seconds?: number;
}

export function recordModelCall(call: ModelCallRecord): void {
  if (!process.env.DATABASE_URL) return;
  void db()
    .insert(schema.modelCall)
    .values({
      kind: call.kind,
      model: call.model,
      configId: call.configId,
      inputTokens: Math.max(0, Math.round(call.inputTokens ?? 0)),
      outputTokens: Math.max(0, Math.round(call.outputTokens ?? 0)),
      seconds: Math.max(0, Math.round(call.seconds ?? 0)),
    })
    .catch((error: unknown) => console.warn('model call log failed', error instanceof Error ? error.message : error));
}

function tokens(usage: LanguageModelV4Usage | undefined): { inputTokens: number; outputTokens: number } {
  return { inputTokens: usage?.inputTokens.total ?? 0, outputTokens: usage?.outputTokens.total ?? 0 };
}

/** A generation model that logs each call, streamed or not, once it finishes. */
export function loggedLanguageModel(model: LanguageModelV4, call: { model: string; configId: string | null }): LanguageModelV4 {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        recordModelCall({ kind: 'generation', ...call, ...tokens(result.usage) });
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        let usage: LanguageModelV4Usage | undefined;
        const stream = result.stream.pipeThrough(
          new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if (part.type === 'finish') usage = part.usage;
              controller.enqueue(part);
            },
            flush() {
              recordModelCall({ kind: 'generation', ...call, ...tokens(usage) });
            },
          }),
        );
        return { ...result, stream };
      },
    },
  }) as LanguageModelV4;
}
