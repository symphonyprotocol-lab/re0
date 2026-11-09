# 知识入库 credit 计费审计

2026-11-09，基于 `rebuild`（含 PR #89 / #91 本地 PDF / Word 解析）。规则：**可以多算，不能少算**——用户为一条知识付出的 credits 必须 ≥ 这次处理实际产生的供应商成本（按 `credits = ceil(美元成本 / 0.0001)`，见 `docs/handover/knowledge-billing.md`）。

## 结论摘要

- 所有导入入口最终都走同一条管线：`createKnowledgeInTx` / `reprocessInTx` 先放 1 credit 预留 → `processKnowledge` 在 `withProviderMeter` 里跑 → 每次付费调用的收据先落库并原子补足预留 → 成功时在写入片段的同一事务里按完整成本结算（`settled.charged === total.credits`，否则整轮失败）。没有绕开计量的付费调用。
- 发现并已修复 6 处少算（见下文"已修复"）。最严重的是**余额不足时，超出余额的那次调用整笔由平台承担**：例如余额 100 的用户上传一份 100 页扫描 PDF，Firecrawl 实际成本 3,800 credits，用户只被扣 1 credit。
- 有 4 项属于产品政策，按现状保留，列为待决（见"待决"）。最主要的一项是：处理失败一律全额退款，已发生的供应商成本由平台承担。

## 按导入路径

成本来源里的"无"是指没有第三方付费调用（只有本地 CPU、出站流量或 Blob 存储）。

| 路径 | 入口 | 成本来源 | 是否计费 | 计费位置 | 测试 | 问题 / 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| 文档 · Markdown / TXT 上传 | `POST /api/rees/[id]/knowledge` (`kind: document`) | embedding | 是 | 预留 `lib/services/knowledge.ts:232`；每次调用 `recordProviderCharge` `:266`；结算 `:582` | `knowledge.test.ts` "bills actual embedding tokens…"、"follows supplier price changes…"、"charges a call that overran…"、"refuses the call before…" | 正确；修复后加了调用前预留（F2）和余额不足补扣（F1） |
| 文档 · Word（本地解析，#89/#91） | 同上 | embedding（解析在本地，无 Firecrawl） | 是 | 同上 | `knowledge.test.ts` "parses Word locally…"、"fails and refunds a Word file…" | 正确；本地解析不产生收据，只按 embedding 结算 |
| 文档 · 有文字层的 PDF（本地解析） | 同上 | embedding | 是 | 同上 | `knowledge.test.ts` "parses a 30-page text PDF locally…"；`knowledge-costs.test.ts` | 正确 |
| 文档 · 扫描 / 乱码 PDF（Firecrawl 兜底） | 同上 | Firecrawl Parse + embedding | 是 | Firecrawl 计量 `lib/infra/connectors/firecrawl.ts:71`、`:107` | `knowledge.test.ts` "sends a 30-page PDF with a scanned page…"、"refuses a scanned PDF before Firecrawl…"、"keeps supplier costs already reserved…"、"fails and refunds when Firecrawl cannot provide…"；`document-connectors.test.ts`（单元） | **F1**：一次 Firecrawl 调用的成本超出余额时整笔不收；**F4**：缺 `creditsUsed` 时只按 `numPages` 计费，截断响应会少算；**F2**：调用前没有按页数预留 |
| 音频 · MP3 / WAV / M4A | 同上 (`kind: audio`) | 转写（每段一次调用）+ embedding | 是 | 转写计量 `lib/infra/ai/transcription.ts:107`、`:118` | `knowledge-kinds.test.ts` "transcribes 100 MB in pieces…"；`transcription-usage.test.ts`（单元） | **F3**：响应缺时长时取最后一个片段的结束时间（片段结束早于尾部静音就会少算），MP3 / M4A 自己能算出的时长没用上；再不行就记"未确认"，来源照样 ready，这次转写**按 0 计费** |
| GitHub 仓库 | 同上 (`kind: github`) | embedding（GitHub API 免费） | 是 | 同上 | `knowledge-kinds.test.ts` "requires a GitHub connection…" | 正确 |
| 单个网页 | 同上 (`kind: page`) | embedding（本地抓取，不走 Firecrawl） | 是 | 同上 | `knowledge-kinds.test.ts` "fetches a single page…" | 正确 |
| 整站 | 同上 (`kind: site`) | embedding（本地爬取） | 是 | 同上 | `knowledge-kinds.test.ts` "refuses a website until its domain is verified…" | 正确 |
| 粘贴文本（历史数据） | 新建入口已移除；只剩重新处理 | embedding | 是 | 同上 | `knowledge.test.ts` "processes pasted text…"、"charges zero for an explicitly free supplier…" | 正确 |
| 单条重新处理 | `POST /api/rees/[id]/knowledge/[kid]/refresh` → `refreshKnowledge` | 与该类型首次处理相同 | 是，每次新预留、新结算 | `reprocessInTx` `lib/services/knowledge.ts:348`、`:362` | `knowledge.test.ts` "bills actual embedding tokens…"（重新处理再扣一次）、"fails and refunds in full when the file is gone; reprocessing charges again" | 正确 |
| 批量重新处理 | `POST /api/rees/[id]/knowledge/batch` (`reprocess`) → `runBatch` → `processMany` | 同上 | 是，每条一个预留，余额不足整批拒绝 | `lib/services/knowledge-library.ts:138`；`processMany` `lib/services/knowledge.ts:655` | `knowledge-library.test.ts` "reprocessing charges again…"、"refuses a reprocess the balance cannot cover…" | 正确 |
| 漏跑的 pending 补跑 | `GET /api/rees/[id]/knowledge` → `recoverStale` → `processKnowledge` | 同首次处理 | 是（复用原预留） | `lib/services/knowledge.ts:1023` | `knowledge.test.ts` "keeps a retried run funded…" | 正确 |
| 超时运行回收 | `recoverStale` → `failAndRefund('unknown')` | 已发生的供应商成本 | **否**，全额退款 | `lib/services/knowledge.ts:624` | `knowledge-costs.test.ts` "closes a legacy processing snapshot…" | 政策 P1（待决）；修复后，超时旧任务迟到的 embedding 在发出前就被拒绝（F2 的附带效果），平台不再为它付费 |
| 并发 / 重复触发 | 同一条知识 `processKnowledge` 跑两次 | — | 只领取一次 | 领取 `pending → processing`，`processKnowledgeRun` `lib/services/knowledge.ts:523` | `knowledge.test.ts` "bills actual embedding tokens…"（两个 worker 并发） | 正确 |
| 移动 / 暂停 / 启用 / 回收站 / 恢复 / 改名 | batch、PATCH、restore 路由 | 无（不重新 embedding） | 不需要 | `runBatch` 其余分支 | `knowledge-library.test.ts` | 正确；恢复保留原片段，不重新处理 |
| 知识画像 / 示例问题 | `afterKnowledgeReady` / `refreshProfile`（入库成功后、启停变化后） | 生成 + embedding | **否**（平台承担） | `lib/services/knowledge.ts:519`、`:665`；`lib/services/profile.ts:107` | — | 政策 P2（待决） |
| embedding 模型切换后重新向量化 | 后台 `reembed` 任务 | embedding | **否**（平台承担） | `lib/services/reembed.ts:231` | — | 政策 P3（待决）；处理中途模型切换导致的重复 embedding 由用户承担（按实际成本） |
| MCP / API Key | `lib/services/mcp.ts` | — | — | — | — | 只读知识，不写入；没有导入路径 |

## 已修复

| # | 问题 | 少算场景 | 修复 | 位置 | 测试 |
| --- | --- | --- | --- | --- | --- |
| F1 | 余额不足时，超出余额的那次调用整笔不收（"那次调用由平台承担"） | 余额 20、embedding 实际 40 → 只扣 1；余额 100、Firecrawl 3,800 → 只扣 1 | 余额不足失败时按全部已发生成本结算：先把余额全部转入预留，剩下的记 `credit_debt`（与退款不足同一机制，下次到账先还债），流水备注 "N owed"，`settled` 活动带 `owed` | `chargeKnowledgeShortfall` `lib/services/credits.ts:320`；`failAndRefund` `lib/services/knowledge.ts:638` | `knowledge.test.ts` "charges a call that overran the balance in full…"（含还债）、"keeps supplier costs already reserved…"（340 = 310 + 欠 30） |
| F2 | 付费调用前不检查余额，只有 1 credit 预留 | 同 F1：付费调用已经发生，才发现余额不够 | `prepareProviderCall` 支持 `estimate`：按同一单价把"已知成本 + 本次上限估计"在请求**之前**预留，不够就抛 `InsufficientCredits`，不发请求。估计值：Firecrawl 用本地读到的页数（每页 1 credit）；转写用分段自己的时长（WAV 头、MP3 帧、M4A `mvhd`）；embedding 用 UTF-8 字节数 + 每条 8（字节级 BPE 的 token 数不会超过字节数）。估计只是预留，最终仍按实测用量结算，多出的部分在结算时退回。同一轮里并行的调用（转写分段、embedding 分批）把彼此的估计也算进去；调用结束（成功、失败或换 Key 重试）后它的估计就移出 | `lib/infra/ai/provider-meter.ts:92`；`reserveEstimate` `lib/services/knowledge.ts:305`；`lib/infra/connectors/firecrawl.ts:71`；`lib/infra/ai/transcription.ts:107`；`lib/infra/ai/models.ts:191`；`lib/infra/connectors/pdf.ts`（回退结果带 `pages`） | `knowledge.test.ts` "refuses the call before it is made…"、"refuses a scanned PDF before Firecrawl…"；`document-connectors.test.ts` "reserves the local page count…"、"releases each rotated key's page estimate…"、"makes no paid call…"；`transcription-usage.test.ts` "reserves the piece's own length…" |
| F3 | 转写时长偏短；拿不到时长时这次调用按 0 计费，来源照样 ready | 响应没有 `duration`，最后一个片段在尾部静音之前就结束；或 MP3 / M4A 响应既无时长也无片段 | 计费秒数取"上报时长、最后片段结束时间、分段自身时长"三者中的最大值；去掉转写的 `acceptUnknownCost`，三者都拿不到时按 `usage_unavailable` 失败（保留收据供核对），不再静默按 0 计费 | `lib/infra/ai/transcription.ts:118`、`localSeconds` `:152` | `transcription-usage.test.ts` "bills the longest of…"、"prices an MP3 piece by its own frames…"、"fails rather than bill zero…" |
| F4 | Firecrawl 缺 `creditsUsed` 时只按 `numPages` 计费 | `numPages < totalPages` 的截断响应只按已返回页数计费；只有 `pages` 数组、没有 metadata 时直接失败 | 没有 `creditsUsed` 时，取 `numPages`、`totalPages`、`pages` 数组长度、本地页数中的最大值 | `lib/infra/connectors/firecrawl.ts:107` | `document-connectors.test.ts` "bills the largest page count of a truncated reply…"、"bills the pages a reply returned…" |
| F5 | 计量用量四舍五入到百万分之一单位 | 如转写 4.4200000763 秒被舍到 4.420000 秒（金额极小，但方向是向下） | 实测用量向上取整，浮点噪声（< 1e-6 单位）不算，避免把 0.14 / 0.01 这类情况多算一个步长 | `rateCost` `lib/domain/provider-cost.ts:113` | `provider-cost.test.ts` "respects duration billing increments…" |
| F6 | 成功路径允许带"未确认"收据结算，未确认部分按 0 计费 | 任何被 `acceptUnknownCost` 放行的调用 | 成功结算前检查：本轮只要有未确认收据就以 `usage_unavailable` 失败，绝不带着按 0 计费的成本变成 ready | `lib/services/knowledge.ts:580` | 所有成功用例经过 `expectChargedAtLeastCost`（断言 ready 运行没有未确认收据） |

附带修正：后台知识成本页的 `refundedCredits` 改为 `greatest(预留 − 已扣, 0)`（`lib/services/admin-knowledge-costs.ts`），因为有欠款时已扣会大于预留。

### 测试不变量

新文件 `tests/integration/billing-audit.ts` 提供 `expectChargedAtLeastCost(knowledgeId)`，对一条知识的每一轮处理断言：

- ready 运行和余额不足运行：`chargedCredits`（含欠款）≥ `ceil(全部已知收据美元成本 / 0.0001)`，且 ready 运行没有未确认收据；
- 其他失败运行：扣费为 0（政策 P1）；
- 账本净扣 + 欠款 = 各轮 `chargedCredits` 之和，没有未关闭的预留。

上表每种导入路径的集成测试都调用了它。

## 待决（产品政策，未改动）

| # | 内容 | 现状 | 影响 / 建议 |
| --- | --- | --- | --- |
| P1 | 处理失败（余额不足除外）全额退款，已发生的供应商成本由平台承担；超时回收同理 | `failAndRefund`，`docs/handover/knowledge-billing.md`"沿用处理失败全额退款的产品政策" | 可以被反复利用：比如一份 Firecrawl 能解析、但之后才失败的文件（页码缺失、截断、没有正文），每次重新处理平台都付一次 Firecrawl。建议：失败原因属于来源本身（`empty_text`、`parse_failed` 等）时按已发生成本结算，平台侧故障（`embedding_unavailable`、`pricing_unavailable`、超时）才全额退款。需要产品决定 |
| P2 | 知识画像、示例问题的生成和 embedding 免费 | `afterKnowledgeReady` 在计量范围外运行 | 每次入库成功、启停、恢复都会触发一次，成本随来源数量增长；是否计入入库费用需要产品决定 |
| P3 | 管理员切换 embedding 模型后的全量重新向量化免费 | `lib/services/reembed.ts` | 平台主动操作，平台承担比较合理；记录在案 |
| P4 | 本地解析 CPU、网页 / GitHub 抓取流量、Blob 存储和向量存储不计费 | 只有第三方付费调用进入收据 | 符合现有"只按第三方实际成本"的规则；如果要覆盖存储成本，需要单独定价 |

另外两点说明：

- F1 会让用户欠款（余额显示 0，`/billing` 显示欠款，下次到账先还）。F2 的调用前预留让绝大多数情况在付费调用发生之前就被拒绝，欠款只在估计偏低时出现：没有本地页数的 PDF，或者供应商实际计费超过字节上限。
- 自定义 embedding 端点不返回 usage 时仍然失败退款（原有政策，`knowledge.test.ts` "records missing usage for reconciliation…"），没有改成按字节上限计费。
