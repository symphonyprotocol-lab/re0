# 知识入库 credit 计费审计

2026-11-09，基于 `rebuild`（含 PR #89 / #91 本地 PDF / Word 解析）。规则：**可以多算，不能少算**。用户为知识付出的 credits 必须 ≥ 实际产生的成本，按 `credits = ceil(美元成本 / 0.0001)` 换算（见 `docs/handover/knowledge-billing.md`）。用户随后决定 P1–P4 **全部计费、失败不退**（「全部需要计费，失败不退」），已在同一个 PR 里实现。

## 结论摘要

- **统一管线**：所有导入入口都走同一条管线。
  1. `createKnowledgeInTx` / `reprocessInTx` 先放 1 credit 预留。
  2. `processKnowledge` 在 `withProviderMeter` 里运行。
  3. 每次付费调用前，按上限估计补足预留；不够就不发请求。
  4. 调用返回后，收据立即落库，并原子补足预留。
  5. 成功时，在写入片段的同一事务里按完整成本结算。
  - 没有绕开计量的付费调用。
- **少算问题**：审计发现 6 处少算，已修复（F1–F6）。最严重的是余额不足时，超出余额的那次调用整笔由平台承担。
- **P1–P4 已按用户决定实现**：
  - 失败不再全额退款，只退未用掉的预留（P1）。
  - 知识画像和示例问题由 Ree 主人付费（P2）。
  - 模型切换后的重新向量化由各知识库主人付费（P3）。
  - 存储和流量计费（P4）。
- **欠款**：任何已经发生的成本，余额不够时记为欠款（`credit_debt`），下次到账先还。

## 计费口径

| 成本 | 依据 | 单价 / 换算 | 位置 |
| --- | --- | --- | --- |
| Firecrawl Parse | 供应商实际 `creditsUsed`；缺失时取所有页数中的最大值 | 后台配置的账户单价（当前 $0.0038 / Firecrawl credit） | `lib/infra/connectors/firecrawl.ts:109` |
| embedding / 转写 / 生成 | Gateway 实际账单优先；否则按配置单价或 Gateway 目录价 × 实测用量 | 同上；生成目录价必须同时有输入和输出单价，否则不用 | `lib/infra/ai/provider-meter.ts`、`lib/infra/ai/usage.ts:96` |
| 流量（P4） | 处理时我们读写的字节数：网页 / GitHub 抓取、从 Blob 读回上传文件、发给 Firecrawl / 转写的文件 | `INFRA_COST_RATES.transferPerGb` = **$0.15 / GB**（见下方保守取值） | `lib/constants.ts:103`、`meterTransfer` `lib/infra/ai/provider-meter.ts:43` |
| Blob 存储（P4） | 上传文件大小 × 存储秒数 | **$0.028 / GB-month**：Vercel 标价 $0.023，加 $0.005 摊销上传 / 列举等操作费 | `lib/constants.ts:103`、`lib/services/storage-billing.ts` |
| 数据库存储（P4） | 知识正文、children、活动记录、片段正文 + 向量（每片段 1536×4 + 200 字节）× 2（索引）× 存储秒数 | **$0.55 / GB-month**：Neon 存储 $0.35 + 即时恢复历史 $0.20 | 同上 |

**保守取值说明**（PR 里同样标出）：

- **流量**：代码和配置里找不到函数出站抓取的计价表。Vercel 相关的几项是：Blob 数据传输 $0.05 / GB；缓存未命中时另加 Fast Origin Transfer $0.06 / GB；Fast Data Transfer 起价 $0.15 / GB。这里统一取最贵的 $0.15 / GB。
- **单位**：GB 按 10^9 字节（单位更小，算出的 GB 更多）。按秒的存储价把一个月按 28 天算（最短的月）。
- **集中定义**：三个单价都只定义在 `INFRA_COST_RATES` 一个常量里。
- **价格来源**：
  - [Vercel Blob 用量与价格](https://vercel.com/docs/vercel-blob/usage-and-pricing)
  - [Vercel 价格页](https://vercel.com/pricing)
  - [Neon 价格页](https://neon.com/pricing)

## 按导入路径

| 路径 | 入口 | 成本来源 | 是否计费 | 计费位置 | 测试 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 文档 · Markdown / TXT | `POST /api/rees/[id]/knowledge` (`kind: document`) | embedding + Blob 读取流量 | 是 | 预留 `lib/services/knowledge.ts:233`；收据 `recordProviderCharge` `:267`；流量 `:440`、`:554`；结算 `:594` | `knowledge.test.ts` "bills actual embedding tokens…"、"follows supplier price changes…"、"charges a call that overran…"、"refuses the call before…" | 已修 F1、F2；加了流量 |
| 文档 · Word（本地解析） | 同上 | embedding + Blob 读取 | 是 | 同上 | `knowledge.test.ts` "parses Word locally…"、"fails a Word file that is not a document, keeping only the cost of reading it" | 正确 |
| 文档 · 有文字层的 PDF | 同上 | embedding + Blob 读取 | 是 | 同上 | `knowledge.test.ts` "parses a 30-page text PDF locally…"；`knowledge-costs.test.ts` | 正确 |
| 文档 · 扫描 PDF（Firecrawl） | 同上 | Firecrawl + embedding + Blob 读取 + 上传到 Firecrawl | 是 | Firecrawl `lib/infra/connectors/firecrawl.ts:71`、`:76`、`:109` | `knowledge.test.ts` "sends a 30-page PDF with a scanned page…"、"refuses a scanned PDF before Firecrawl…"、"keeps supplier costs already reserved…"、"fails when Firecrawl cannot provide PDF page attribution…"、"keeps what a run spent when embedding fails…"；`document-connectors.test.ts` | 已修 F1、F2、F4；失败不退（P1） |
| 音频 · MP3 / WAV / M4A | 同上 (`kind: audio`) | 转写 + embedding + Blob 读取 + 上传到转写端点 | 是 | `lib/infra/ai/transcription.ts:107`、`:109`、`:119` | `knowledge-kinds.test.ts` "transcribes 100 MB in pieces…"；`transcription-usage.test.ts` | 已修 F3 |
| GitHub 仓库 | 同上 (`kind: github`) | embedding + 抓取流量 | 是 | 抓取流量 `lib/infra/connectors/http.ts:145` | `knowledge-kinds.test.ts` "requires a GitHub connection…" | 加了流量 |
| 单个网页 | 同上 (`kind: page`) | embedding + 抓取流量 | 是 | 同上 | `knowledge-kinds.test.ts` "fetches a single page…"（断言流量收据的字节数） | 加了流量 |
| 整站 | 同上 (`kind: site`) | embedding + 抓取流量（含 robots / sitemap） | 是 | 同上 | `knowledge-kinds.test.ts` "refuses a website until its domain is verified…" | 加了流量 |
| 粘贴文本（历史数据） | 只剩重新处理 | embedding | 是 | 同上 | `knowledge.test.ts` "processes pasted text…"、"charges zero for an explicitly free supplier…" | 正确 |
| 单条 / 批量重新处理 | `refresh`、`batch reprocess` → `reprocessInTx` / `processMany` | 同首次处理 | 是，每次新预留、新结算 | `lib/services/knowledge.ts:356`、`:666` | `knowledge.test.ts` "keeps what a run spent when embedding fails…"（失败后重新处理再收一次）；`knowledge-library.test.ts` | 正确 |
| 失败（任何原因，P1） | `failAndRefund` | 已发生的全部成本 | **是**，只退没用掉的预留；有无法定价的收据时整笔预留不退 | `settleRun` `lib/services/metered-work.ts:34`；`lib/services/knowledge.ts:652` | `knowledge.test.ts` 多个失败用例 | **P1 已实现** |
| 超时回收 / 迟到收据 | `recoverStale` → `failAndRefund('unknown')`；运行关闭后才到的收据 | 已发生的成本 | 是；迟到收据按差额补扣 | `chargeLateReceipt` `lib/services/metered-work.ts:60`；`lib/services/knowledge.ts:267` | `knowledge.test.ts` "keeps a retried run funded when a timed-out worker returns" | **P1 已实现** |
| 并发 / 重复触发 | 同一条知识跑两次 `processKnowledge` | — | 只领取一次 | `processKnowledgeRun` `lib/services/knowledge.ts:533` | `knowledge.test.ts` "bills actual embedding tokens…" | 正确 |
| 移动 / 暂停 / 启用 / 回收站 / 恢复 / 改名 | batch、PATCH、restore | 无（只会触发 P2 的画像刷新） | 不需要 | `runBatch` | `knowledge-library.test.ts` | 正确 |
| 知识画像（P2） | `refreshProfile`：入库后、启停 / 恢复 / 发布后、模型切换后重建 | embedding | **是**，Ree 主人付费；必须执行，余额不够就记欠款 | `lib/services/profile.ts:111` | `knowledge-billing.test.ts` P2 | **P2 已实现** |
| 示例问题（P2） | `suggestQuestions`：第一条来源 ready 后 | 生成 | **是**，Ree 主人付费；属可选功能，余额不够就不调用、不生成 | `lib/services/profile.ts:170`；生成计量 `lib/infra/ai/usage.ts:96` | `knowledge-billing.test.ts` P2 | **P2 已实现** |
| 模型切换后重新向量化（P3） | `runReembed`（后台 / cron） | embedding | **是**，每批按知识库主人分组，各付各的；切换必须完成，余额不够就记欠款；候选模型没有单价时任务失败 | `lib/services/reembed.ts:244` | `knowledge-billing.test.ts` P3 | **P3 已实现** |
| 存储（P4） | 每天的 cron `/api/cron/charge-storage`；清空回收站前同一事务内结算 | Blob 文件 + 数据库行，按秒计 | **是**，按累计成本向上取整，从不低于成本，最多多 1 credit | `accrueStorage` `lib/services/storage-billing.ts:57`；`chargeStorage` `:99`；`purgeTrash` `lib/services/knowledge-library.ts:236` | `knowledge-billing.test.ts` P4 | **P4 已实现** |
| MCP / API Key | `lib/services/mcp.ts` | — | — | — | — | 只读，没有导入路径 |

## 已修复的少算

| # | 问题 | 修复 | 位置 | 测试 |
| --- | --- | --- | --- | --- |
| F1 | 余额不足时，超出余额的那次调用整笔不收。例：余额 100、Firecrawl 3,800 credits，只扣 1 | 按全部已发生成本结算：先扣光余额，剩下的记 `credit_debt` | `takeOrOwe` / `chargeKnowledgeShortfall` `lib/services/credits.ts:319`、`:352` | "charges a call that overran the balance in full…"（含还债） |
| F2 | 付费调用前不检查余额 | 调用前按上限估计预留（Firecrawl 本地页数、转写分段时长、embedding / 生成按 UTF-8 字节数和输出上限），并行调用互相计入，不够就不发请求；结算按实测用量，多出的退回 | `lib/infra/ai/provider-meter.ts:123`；`reserveEstimate` `lib/services/knowledge.ts:313` | "refuses the call before it is made…"、"refuses a scanned PDF before Firecrawl…"、单元测试 |
| F3 | 转写时长偏短；拿不到时长时按 0 计费，来源照样 ready | 取上报时长、最后片段结束时间、分段自身时长三者中的最大值；都拿不到时失败 | `lib/infra/ai/transcription.ts:119` | `transcription-usage.test.ts` |
| F4 | Firecrawl 缺 `creditsUsed` 时只按 `numPages` 计费 | 取所有页数中的最大值 | `lib/infra/connectors/firecrawl.ts:109` | `document-connectors.test.ts` |
| F5 | 用量换算时四舍五入 | 向上取整（浮点噪声除外） | `lib/domain/provider-cost.ts` `rateCost` | `provider-cost.test.ts` |
| F6 | 带"未确认"收据仍能结算成 ready | 有未确认收据就失败，且整笔预留不退 | `lib/services/knowledge.ts:592` | 所有用例经过 `expectChargedAtLeastCost` |

## 测试不变量

`tests/integration/billing-audit.ts` 的 `expectChargedAtLeastCost(knowledgeId)` 对每一轮处理（成功或失败）断言：

- `chargedCredits`（含欠款）≥ `ceil(全部已知收据成本 / 0.0001)`；
- 没有收据的运行扣费为 0；ready 运行没有未确认收据；
- 账本净扣 + 欠款 = 各轮扣费之和，没有未关闭的预留。

P2 / P3 的运行在 `knowledge-billing.test.ts` 的 `runsOf` 里做同样的断言。存储断言三点：
- `chargedCredits = ceil(累计 pico 美元 / 10^8)`，并且足以覆盖累计成本；
- 每次累计成本都高于"只按 Vercel 标价 $0.023 / GB-month、31 天一个月、只算文件本身"的独立下限；
- 多次小额结算后仍不低于总成本。

## 用户可见的行为变化

- **失败不退**：处理失败时，已发生的成本照收，只退没用掉的预留。重新处理一个反复失败的文件，每次都收费。什么都没花的失败（文件不存在、名字触发的模拟失败）仍然全额退回。
- **未知成本整笔不退**：失败时如果有供应商成本无法确定（例如自定义 embedding 端点没返回 usage），整笔预留不退。
- **每次处理都多一点流量费**：读回上传文件、抓取网页 / 仓库、发给 Firecrawl / 转写，按 $0.15 / GB 计。金额通常远小于 1 credit，但每轮只向上取整一次，所以小文件通常多 1 credit。后台成本页会多出"流量"类收据。
- **画像和示例问题收费**：入库后的知识画像，以及启停 / 恢复 / 发布、模型切换后的画像重建，每次至少 1 credit；余额为 0 时记欠款。示例问题在余额不够时直接不生成。
- **重新向量化收费**：管理员切换 embedding 模型后，每个知识库主人为自己的片段付费，余额不够就记欠款。候选模型必须先配好单价，否则任务失败。
- **存储每天扣费**：账本里出现"知识存储"（`storage_charge`）条目，计入"消耗"统计。回收站里的来源一直计费，直到 30 天后被清除；已删除 Ree 的知识也一直计费，因为它们仍然占着存储。
- **可能欠款**：任何已经发生的成本，余额不够时都会记欠款（`/billing` 显示欠款，下次到账先还）。

## 剩余说明

- **未计入的成本**：
  - embedding 请求本身的出站字节（很小）。
  - 网页抓取中 4xx / 5xx 错误响应的正文。
  - 流式生成（`wrapStream`）不在计量范围内。计量范围里没有流式生成调用；聊天走自己的计费。
- **未关联到知识行的 Blob 文件**：申请了上传令牌但没有加入知识库的文件，由 Blob 平台承担。这类文件不在 `knowledge` 表里，需要单独的孤儿文件清理。
- **迟到收据的账本位置**：迟到收据补扣时写成 `knowledge_hold` 条目，备注 "(late receipt)"。`/billing` 的"消耗"汇总只统计结算条目，所以这笔补扣不会出现在消耗汇总里，但余额和账本都正确。
