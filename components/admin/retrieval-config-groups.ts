import type { RetrievalSettingKey } from '@/lib/domain/retrieval-config';

/**
 * How the retrieval knobs are laid out: by the stage of retrieval they
 * govern, so an operator tuning recall is not reading about the playground's
 * budget. The order inside a group follows the pipeline.
 *
 * Its own module, without `'use client'`, because both the client form and
 * the server-rendered page read it -- a value exported from a client module
 * reaches a server component as a client reference, not as an array.
 */
export const RETRIEVAL_SETTING_GROUPS: {
  id: 'chunk' | 'rerank' | 'cache' | 'playground' | 'agent' | 'routing' | 'directory' | 'a2a';
  keys: RetrievalSettingKey[];
}[] = [
  { id: 'chunk', keys: ['recallLimit', 'rrfK'] },
  { id: 'rerank', keys: ['rerankWindow', 'rerankDocumentChars'] },
  { id: 'cache', keys: ['cacheTtlSeconds'] },
  { id: 'playground', keys: ['playgroundTokensDefault', 'playgroundTokensMax'] },
  {
    id: 'agent',
    keys: ['playgroundAgent', 'playgroundAgentSteps', 'playgroundAgentQueries', 'playgroundAgentResolves'],
  },
  { id: 'routing', keys: ['routingRecallLimit', 'routingRareSampleCap', 'routingResultLimit'] },
  {
    id: 'directory',
    keys: ['channelActivityBps', 'channelFreshnessBps', 'channelQualityBps', 'channelHalfLifeDays'],
  },
  { id: 'a2a', keys: ['askCallsPerAnswer', 'askDailyAnswers'] },
];
