# Re0 知识库构建计费设计

- 版本：1.0
- 更新日期：2026-09-06
- 状态：**已评审，已实施；上线模式由 `BUILD_BILLING_MODE` 切换（默认 shadow）**
- 上级文档：[requirement.md](./requirement.md) 第 4.1、4.2 节
- 关联文档：[architecture.md](./architecture.md) 8.2、11.1；[publisher-revenue-share.md](./publisher-revenue-share.md)

## 1. 目的

用户创建或刷新知识库时，平台要为抓取和 Embedding 付费，而现行规则（requirement.md 4.2「索引与刷新任务不计 Call」）把这部分成本完全放在平台侧。本文把构建并入既有的 API Call 池计费：用户仍然只看到一种计量单位，扣减顺序、账期、调用包规则全部不变。

### 1.1 设计原则

- **只按 Call，不按 Token。** 构建费用从内容量折算成整数 Call，用户在创建前就能算出上限。费率来自不可变 Plan Version，不随供应商账单浮动。
- **只为新增内容付费。** `build-version.ts` 已按 source digest 把未变化的文档和向量原样搬运，未变化的部分不计费。
- **只在成功时扣费。** 版本发布成功才写 Usage Event；失败、被丢弃、被平台重试的构建不扣费。这与检索「开始即计费」不同，因为构建失败时用户什么也没拿到。
- **平台发起的重建不收费。** 解析器、切块器、Embedding 模型升级导致的全量重建是平台决策。

### 1.2 与现行需求的冲突

本方案实施前必须先修改 requirement.md 4.2 的以下条目，否则代码与需求矛盾：

| 现行文案 | 改为 |
| --- | --- |
| 版本存证、认领验证、索引与刷新任务不计 Call | 版本存证、认领验证不计 Call；索引与刷新按新增内容量折算 Call（见 4.2.1），来源未变化不计费，平台发起的重建不计费 |

同一承诺还出现在 `lib/i18n/messages/zh.ts` 与 `en.ts` 的 Pricing 卡片、对比表和 FAQ 中，须同步修改（见第 8 节）。

## 2. 范围

### 2.1 包含

| 能力 | 说明 |
| --- | --- |
| 构建费率 | Plan Version 上的三个冻结字段 |
| 报价 | 创建向导和刷新按钮在执行前给出费用上限 |
| 预留与结算 | 复用 `usage_reservation` / `usage_event`，带权重 |
| 定时刷新闸门 | 余额不足时跳过并提示 |
| 展示 | 库详情、Dashboard、Pricing |
| 分成隔离 | 构建事件不进入发布者分成的分子与分母 |

### 2.2 不包含

- 按 Token 或按供应商账单计费；
- 单独的「构建额度」池（评估见 9.1）；
- 退费；删除知识库不返还已扣 Call；
- 版本存证、认领验证、画像重建的计费，这些保持免费。

## 3. 计价规则

### 3.1 成本来源

一次构建真正产生外部成本的只有两步：

| 步骤 | 计量 | 适用来源 |
| --- | --- | --- |
| 抓取（渲染服务托管 API：Firecrawl / AnySearch / Jina） | 页数 | website、llms_txt、openapi |
| Embedding | Token 数 | 全部来源 |

github、notion 走各自 API，pdf 是用户上传，都没有抓取费。画像（`rebuild-profile.ts`）是词频统计，不走 LLM；存证走链上但已承诺免费。

### 3.2 公式

每次成功发布一个版本：

```
build_calls = build_base_calls
            + ceil(fresh_tokens   / build_tokens_per_call)
            + ceil(pages_fetched  / build_pages_per_call)
```

- `fresh_tokens`：本次新解析、新 Embedding 的 Chunk 的 Token 总和，即 `buildVersion` 里 `totalTokens` 减去 carry 阶段搬运的 Token。
- `pages_fetched`：本次实际抓取的文件数，取自 `workflow_operation.fetch_summary`。carry 的来源不计。
- 三个费率来自本次构建开始时 workspace 的最新 Plan Version，并冻结到事件里。

### 3.3 初始费率

| 字段 | Free | Pro | 说明 |
| --- | --- | --- | --- |
| build_base_calls | 1 | 1 | 排队、抓取、校验的固定开销 |
| build_tokens_per_call | 20,000 | 20,000 | 每 2 万新增 Token 计 1 Call |
| build_pages_per_call | 5 | 5 | 每抓取 5 页计 1 Call |

Additional Calls 包沿用 `PACK_INHERITS_PRO` 语义，三列写 0，不代表费率。

成本校验：一个 Call 折合 $0.001（$5 / 5,000）。2 万 Token 的 Embedding 供应商成本约 $0.0004；5 页托管抓取约 $0.004 到 $0.008。抓取一项接近持平，上线后可在控制台通过新 Plan Version 调到 3 页/Call。

### 3.4 费用示例

| 场景 | 内容量 | 约 Token | 构建费 | 占月额度 |
| --- | --- | --- | --- | --- |
| 小型 PDF 手册 | 2 MB | 50 万 | 26 Calls | Free 2.6% |
| Free 满容量库 | 20 MB | 500 万 | 251 Calls | Free 25% |
| Pro 满容量库 | 100 MB | 2,500 万 | 1,251 Calls | Pro 25% |
| 网站 200 页 | 3 MB | 75 万 | 1 + 38 + 40 = 79 | Pro 1.6% |
| 刷新，来源未变化 | 0 新增 | 0 | 0 | 不产生版本 |
| 刷新，1 个来源变了 1 MB | 1 MB | 25 万 | 14 Calls | Free 1.4% |

费用上限由单库容量上限（requirement.md 4.1）封顶，所以任何一次构建的最坏情况都可以事先算出。

## 4. 扣费流程

复用 `lib/application/plans/quota.ts` 的预留、提交两段式。扣减顺序不变：先当前账期套餐额度，再 Additional Calls 余额，两者都为零返回 `quota_exceeded`。

```
创建/刷新请求
   │
   ├─ 1. 报价 quoteBuild()            余额 < base → quota_exceeded，不写库
   │
   ▼
workflow_operation(pending)
   │
   ├─ 2. reserveBuild()               预留报价上限，request_id = build:<operationId>
   │
   ▼
fetch → normalize → chunk
   │
   ├─ 3. priceBuild()                 fresh_tokens、pages_fetched 已确定
   │        实际费用 > 可用余额 → 失败 quota_exceeded，不进入 embed-index
   │
   ▼
embed-index → profile → evaluate
   │
   ▼
publishVersion()  ── 4. commitBuild() 同一事务：写 usage_event，释放多余预留
```

### 4.1 报价

调用点：`app/dashboard/assets/new/actions.ts` 的创建动作，以及库详情页的手动刷新动作。

| 来源 | 估算依据 | 上限计算 |
| --- | --- | --- |
| pdf | 上传清单字节数 | tokens ≈ bytes / 4 |
| github | 仓库 size（已在 `checkGithubImport` 中读取） | tokens ≈ bytes / 4，按 Plan 容量上限封顶 |
| notion | 页面数未知 | 按 Plan 容量上限封顶 |
| website / llms_txt / openapi | 抓取深度与页数上限 | pages 取抓取上限；tokens 按容量上限封顶 |

报价只用于预留和向导展示，不作为最终扣费。可用余额小于 `build_base_calls` 时直接返回 `quota_exceeded`，不创建库、不排队。

### 4.2 预留

`runOperation` 领到操作后、开始抓取前调用 `reserveBuild`：

- 与 `reserveCall` 同一把 `workspace FOR UPDATE` 锁，同样的分摊逻辑，只是 `calls` 为报价上限而不是 1；
- `request_id` 固定为 `build:<operationId>`，`attempts` 重试时命中已有预留，不会二次占位；
- 预留的过期不用 15 分钟 TTL。构建的预留在 `workflow_operation` 进入终态（succeeded / failed / skipped）时由 `runOperation` 显式释放或提交；`RESERVATION_TTL_MS` 清扫只处理 `kind = 'retrieval'` 的预留。

### 4.3 结算

在 `buildVersion` 的 chunk 阶段结束、embed-index 开始前调用 `priceBuild`：

- 计算实际 `build_calls`；
- 若实际值超出预留且剩余余额补不上，抛 `IngestionFailure('quota_exceeded', 'embed-index')`，`index_status` 置 failed，错误信息提示购买调用包后重试。此时没有产生供应商侧 Embedding 费用；
- 实际值记入 `workflow_operation.charged_calls`，供 publish 阶段提交。

`quota_exceeded` 加入 `INGESTION_ERRORS`，并且不视为可重试错误（`run-operation.ts` 第 239 行附近的重试判定要排除它）。

### 4.4 提交

`publishVersion` 的事务里增加一条语句：写 `usage_event`，`calls = charged_calls`，`entrypoint = 'build'`，`operation = 'index' | 'refresh'`，然后把预留置为 committed。「五条语句一个事务」变成六条。

失败路径：`runOperation` 的每一个非 succeeded 分支都调用 `releaseBuild(reservationId)`。`skipped: unchanged` 同样释放，不写事件。

## 5. 数据模型

### 5.1 新增列

| 表 | 列 | 类型 | 说明 |
| --- | --- | --- | --- |
| plan_version | build_base_calls | integer not null default 1 | 冻结 |
| plan_version | build_tokens_per_call | integer not null default 20000 | 冻结；0 表示 pack |
| plan_version | build_pages_per_call | integer not null default 5 | 冻结；0 表示 pack |
| usage_reservation | calls | integer not null default 1 | 权重 |
| usage_reservation | kind | text not null default 'retrieval' | 'retrieval' / 'build'，决定 TTL 清扫范围 |
| usage_event | calls | integer not null default 1 | 权重，检索始终为 1 |
| usage_event | build_detail | jsonb | 见 5.2 |
| workflow_operation | reservation_id | uuid references usage_reservation | |
| workflow_operation | quoted_calls | integer | 报价上限 |
| workflow_operation | charged_calls | integer | 实际结算 |
| usage_summary | build_calls | integer not null default 0 | Dashboard 拆分展示 |

新迁移编号 `0031_asset_build_billing.sql`。

### 5.2 build_detail

```json
{
  "freshTokens": 748213,
  "carriedTokens": 1203000,
  "pagesFetched": 196,
  "planVersionId": "…",
  "baseCalls": 1,
  "tokensPerCall": 20000,
  "pagesPerCall": 5
}
```

账单争议时不需要重算，事件自带当时的费率与计量。

### 5.3 计数逻辑改动

`quota.ts` 里三处 `count(*)::int` 改为 `coalesce(sum(calls), 0)::int`：

- `reserveCall` 的 `events` 与 `held` 子查询；
- `commitCall` 中日归因上限的计数保持 `count(*)`，且加 `entrypoint <> 'build'` 过滤，构建不参与日上限。

`usage.ts` 的 `rebuildUsageSummary` 按 `entrypoint` 分别汇总到 `calls` 与 `build_calls`；`usageOverview` 返回两项。

### 5.4 OperationTrigger

`lib/domain/ingestion.ts` 的 `OPERATION_TRIGGERS` 增加 `'platform'`。管理后台平台库维护、`scripts/rebuild-profiles.mts`、解析器或模型版本升级触发的重建都用它，`reserveBuild` 对 `platform` 直接返回空预留，`priceBuild` 返回 0。

### 5.5 分成隔离

`lib/application/revenue/close-period.ts` 第 143 行附近读取账期内 `usage_event` 的查询加 `entrypoint <> 'build'`。分子（可计分成 Call）和分母（全部计费 Call）都排除构建事件，否则用户大量构建会稀释发布者分成。`publisher-revenue-share.md` 3.2 补一句说明。

## 6. 应用层接口

新增 `lib/application/plans/build-quota.ts`，与 `quota.ts` 并列：

```ts
export function priceBuild(input: {
  freshTokens: number;
  pagesFetched: number;
  rates: { baseCalls: number; tokensPerCall: number; pagesPerCall: number };
}): number;                                   // 纯函数，放 lib/domain/build-billing.ts

export async function quoteBuild(input: {
  workspaceId: string;
  sourceType: ConnectedSourceType;
  estimate: { bytes?: number; pages?: number };
}): Promise<{ maxCalls: number; planAllowanceRemaining: number; addonBalanceRemaining: number }>;

export async function reserveBuild(input: {
  workspaceId: string;
  operationId: string;
  maxCalls: number;
}): Promise<ReservedCall>;                    // request_id = `build:${operationId}`

export async function commitBuild(tx, input: {
  reservationId: string;
  operationId: string;
  assetId: string;
  versionId: string;
  operation: 'index' | 'refresh';
  calls: number;
  detail: BuildDetail;
}): Promise<void>;                            // 在 publishVersion 的事务内调用

export async function releaseBuild(reservationId: string): Promise<void>;
```

`priceBuild` 与费率校验放在 `lib/domain`，无 IO，便于单元测试；其余四个走 Postgres 事务，遵守 architecture.md 11.1「计数不进 Redis」。

## 7. 定时刷新闸门

> 当前状态：`refreshSchedule` 只调度平台库（`is_platform_asset = true`），平台库的构建不计入任何工作空间，因此本节的闸门尚未实现，代码里也没有对应分支。把定时刷新扩展到用户库时，须连同本节一起实现，并注意两点：同一轮内多个库要累减同一工作空间的余额；来源未变化的刷新不会写 `charged_calls`，估算不能只取最近一次成功构建。

`schedule-refreshes.ts` 的 `scheduleDueRefreshes` 在插入 `workflow_operation` 前：

1. 以该库上一次 `charged_calls` 作为估算（首次刷新用上一次 index 的费用）；
2. 调 `quoteBuild` 比对余额；
3. 余额不足时不入队，写一条 `refresh_skipped_quota` 审计记录，Dashboard 库列表显示「刷新已暂停：余额不足」；
4. 余额恢复后下一次调度自动恢复，不需要用户手动开启。

Free 套餐不能购买调用包，因此 Free 用户的定时刷新在额度耗尽后会停到下一账期，这是预期行为，文案要写明。

## 8. 展示与文案

| 位置 | 改动 |
| --- | --- |
| 创建向导最后一步 | 「预计最多消耗 N Calls，当前可用 M」；不足时禁用提交并给购买入口 |
| 库详情版本列表 | 每个版本显示「构建消耗 N Calls」，来自 `usage_event.calls` |
| 库详情刷新按钮 | 点击前展示报价 |
| Dashboard 首页 | 「本账期 Calls」拆为检索 / 构建两行 |
| Dashboard 请求记录 | 构建事件出现在列表，entrypoint 显示为 build |
| Pricing 对比表 | 新增一行「知识库构建」：按新增内容量折算，每 2 万 Token 计 1 Call |
| Pricing FAQ | 新增：「创建知识库要消耗 Calls 吗」；修改存证 FAQ 保持「存证不计 Call」 |
| 管理后台订阅配置 | Plan Version 表单增加三个费率字段，pack 档禁用 |
| 管理后台用户详情 | 显示该 workspace 构建消耗 |
| requirement.md 4.2 | 见 1.2 |

## 9. 已评估的替代方案

### 9.1 单独的构建额度池

给每档套餐一个独立的「每月构建 Calls」。优点是构建不会挤占检索额度；缺点是引入第二种余额、第二套扣减顺序、第二套调用包，与「只有一种计量单位」的定位冲突，Pricing 页面也要多一行解释。不采用。费用上限被容量封顶，25% 月额度的最坏情况可以接受。

### 9.2 按供应商账单实时折算

把 `llm_cost_event` 式的 micro-USD 成本按汇率折成 Call。用户无法事先预测，且随供应商改价漂移，违反可预测计费。不采用，但 `build_detail` 保留计量，便于日后核对费率是否覆盖成本。

### 9.3 开始即扣费

与检索一致，构建一开始就提交。构建失败时用户被扣费却没有版本，投诉成本高于平台承担失败成本。不采用。

## 10. 验收标准

- Free 用户创建 2 MB PDF 库，成功后 `usage_event` 有一条 `calls = 26` 的 build 事件，Dashboard 检索 Calls 不变，构建 Calls 为 26；
- 同一 operation 因供应商超时重试三次后成功，只产生一条事件；
- 来源未变化的刷新返回 skipped，不产生事件，预留被释放；
- 构建在 chunk 后发现余额不足，失败为 `quota_exceeded`，无 Embedding 请求发出，无事件写入；
- 余额恰好等于报价时，两个并发构建只有一个能预留成功；
- 管理后台用 platform trigger 重建平台库，不产生事件；
- 升级 Embedding 模型后触发的全量重建不产生事件；
- 账期结算时分成池的分子分母都不含 build 事件；
- 定时刷新在余额不足时跳过并留下审计记录，充值后下一轮自动恢复；
- Pricing、FAQ、requirement.md 4.2 无「索引不计 Call」的残留文案。

集成测试放在 `tests/` 下现有的 quota 与 ingestion 用例旁，用 `./scripts/test-integration.sh` 运行。

## 11. 分阶段

| 阶段 | 内容 | 出口条件 |
| --- | --- | --- |
| 1. 影子计费 | 迁移 0031、费率列、`priceBuild`、构建写 `usage_event` 但 `calls = 0`，`build_detail` 记录应扣值 | 跑满两周，费用分布与 3.4 表基本一致 |
| 2. 启用扣费 | 报价、预留、结算、失败释放；向导与库详情展示；Pricing 与 requirement.md 文案 | 第 10 节验收全部通过 |
| 3. 闸门与隔离 | 定时刷新闸门、分成隔离、platform trigger | 与阶段 2 同一发布，不得晚于第一个含构建事件的账期结算 |

阶段 3 与阶段 2 必须同一次上线：否则第一个账期的分成会被构建事件污染，定时刷新也可能在用户不知情时耗尽额度。

## 12. 已知风险

- **抓取费率偏低。** 托管 Firecrawl 单页成本高于 1/5 Call，网站类库在初期可能是负毛利。影子期结束后按实际页均成本重估 `build_pages_per_call`。
- **报价与实际差距大。** notion 和 website 在抓取前无法准确估算，预留会按容量上限占位，短时间内挤占检索并发。预留在 chunk 后立即按实际值收缩，占位窗口等于抓取加解析时间。
- **Free 用户体感。** 5 个满容量库超过 Free 月额度，用户可能认为「容量上限」是承诺额度。Pricing 页需写明容量是上限而非额度。
- **历史库首次刷新。** 方案上线前建的库，第一次刷新如果 `source_digests` 为 null（架构注释里的「rebuild all」）会按全量计费。迁移时对这些库的第一次刷新使用 platform trigger，费用为 0。
