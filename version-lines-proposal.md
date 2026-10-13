# re0 版本线设计方案

- 版本：0.1
- 更新日期：2026-10-05
- 状态：待评审
- 依据：[requirement.md](./requirement.md) §2.1「最新」、§6.1、§9.2；[seed-libraries-proposal.md](./seed-libraries-proposal.md) §5、§6
- 关联实现：`lib/application/ingestion/publish-version.ts`、`lib/application/retrieval/query-docs.ts`、`lib/domain/library.ts`

## 1. 问题

re0 对外的差异化是版本轴：同一个问题在来源的两个版本下答案不同，调用方能指定版本取到对应的答案。首批 50 个平台库的入选标准第一条就是它（seed-libraries-proposal.md §1）。

现在的实现给不出这个能力。re0 的 Version 是**同一来源在不同时间的快照**，不是**来源自己的版本**：

| 事实 | 位置 | 后果 |
| --- | --- | --- |
| 标签由构建日期和摘要生成，形如 `20260304-abcdef01` | `versionLabel`，`lib/domain/ingestion.ts` | Agent 无法知道哪个标签对应 Kubernetes 1.28 |
| 一个库只有一个 `current_version_id`，发布新版本即把上一个置为 `stale` | `publish-version.ts` | 1.28 和 1.32 不能同时是「当前」 |
| 来源只跟踪一个位置；GitHub 来源只跟踪 `re0.json` 里的一个 `branch` | `connectors/github.ts` | 刷新永远只追一条线 |
| `stale` 版本可以按标签查询 | `pinLabeledVersion` | 旧快照查得到，但它是「上周的最新版」，不是「1.28」 |

2026-10-05 起 `resolve-library-id` 的候选已带 `versions` 列表，补上了「标签不可发现」这一半；另一半——标签有含义、多条线并存——是本方案的范围。

## 2. 目标与非目标

目标：

- 一个 Library 可以同时维护多条**版本线**，每条线对应来源的一个版本（`v1.32`、`2025-03-31.basil`、`2024-07-01` 时点）；
- 调用方用 `/owner/name/<线标签>` 查询该线的当前内容；
- 每条线内部仍是不可变快照链，现有的发布事务、存证、缓存键和计量不变；
- 不指定线的查询行为与今天一致。

非目标：

- 自动从用户项目的依赖锁文件推断版本（属于 CLI 与 Skill，见 §9 阶段 4）；
- 跨线的差异对比或「哪个版本移除了这个字段」这类跨版本推理；
- 一次查询融合多条线的结果（requirement.md §9.1 不做跨库并行，同理不做跨线）。

## 3. 备选方案

**A. 版本线成为一等对象（推荐）。** 新增 `library_release`，Version 归属某条线，发布只替换同一条线内的上一个版本。

**B. 每个来源版本建一个独立 Library。** 用分级 ID（`/websites/stripe-api/2025-03-31`）即可，零模型改动。否决理由：Git 仓库 ID 固定两段，用不了分级；一个产品在 `resolve-library-id` 里变成 N 个候选互相挤占名额；认领、Trust、测试集、访问规则名单和分成都按 Library 计，全部要重复 N 份。可以作为阶段 1 上线前的临时手段，不作为模型。

**C. 只把标签改成来源的版本号，仍然单线。** 改动最小，但刷新只追一条线，1.28 在 1.32 发布后就不再更新，且「当前」只有一个。对版本线性演进、旧版不再变化的来源够用，对同时维护多个版本文档的来源（Kubernetes、Stripe、法规时点）不成立。

## 4. 模型

### 4.1 `library_release`

| 字段 | 说明 |
| --- | --- |
| `id`、`library_id` | |
| `label` | 来源自己的版本标识，库内唯一。不自造版本号 |
| `source_refs` | 按 Source ID 记录这条线从该来源取什么：GitHub 的 branch 或 tag、OpenAPI 文件的 URL、网站的基址或版本参数、法规的时点日期 |
| `current_version_id` | 这条线的当前快照 |
| `status` | `active`（参与刷新）、`frozen`（来源该版本不再变化，不再刷新，仍可查询）、`retired`（不可查询，保留记录） |
| `is_default` | 每库恰有一条；不指定线的查询落在它上面 |
| `created_at` | |

`library_version` 增加可空的 `release_id`。为空表示引入版本线之前的快照，视同默认线，不回填。

### 4.2 不变量

- `library.current_version_id` 恒等于默认线的 `current_version_id`，在同一个发布事务里一起切换。所有只读 `library.current_version_id` 的代码（目录、路由画像、Benchmark 评测、分成归因）因此无需改动；
- 发布只把**同一条线**的上一个版本置为 `stale`，不触碰其他线；
- 线标签不得与快照标签同形（`YYYYMMDD-xxxxxxxx[.n]`，`isVersionLabelShaped`），也不得与该库下的分级子库 slug 相同；
- 没有任何 `library_release` 行的库，行为与今天逐字节一致。

### 4.3 标签

字符集放宽到来源实际使用的形式：小写字母、数字、`.`、`-`、`_`，1–40 个字符，首字符为字母或数字。`v1.32`、`2025-03-31.basil`、`2024-07-01` 都合法。标签一经有版本发布即不可改名，只能新建一条线。

## 5. 查询

### 5.1 ID 解析

`/owner/name/<segment>` 的解析顺序在现有规则（requirement.md §6.1「最长存在的 Library ID 优先」）之后加一步：

1. 最长存在的 Library ID；
2. 剩余一段先按**线标签**匹配，命中则固定该线的 `current_version_id`；
3. 否则按快照标签匹配（现有 `pinLabeledVersion`）；
4. 都不命中返回 `library_not_found`，与今天相同。

线标签与快照标签不同形，两步不会歧义。`retired` 的线按不存在处理。

### 5.2 `resolve-library-id`

候选的 `versions` 在库有版本线时列出**线标签**（默认线在前，其余按创建时间倒序），没有版本线时保持今天的快照标签列表。`version` 字段仍是默认线当前快照的标签。

路由画像只为默认线的当前版本维护，不变：路由解决「哪个库」，线由 Agent 根据问题和 `versions` 选择。

### 5.3 缓存、计量、分成、存证

- 缓存键已包含 Version ID，天然按线隔离；
- 计量按 Call，与线无关；
- 分成按 Library 归因，查询哪条线都计入同一个库；
- 存证按 Version，不变。

## 6. 构建与刷新

- `workflow_operation` 增加可空的 `release_id`；一次构建只为一条线产出一个版本；
- 连接器的取数位置由「Source 的 `location` 与 `config`」叠加「该线的 `source_refs[sourceId]`」得到，线上的值覆盖来源上的值；
- 增量比较（按来源摘要沿用未变内容）改为与**同一条线**的当前版本比较；
- 定时刷新只排入 `active` 的线。`frozen` 是成本上限的主要手段：一个维护了八个历史版本的库，通常只有最新一两条线需要轮询；
- 构建计量（requirement.md §4.2.1）按每次成功发布的版本计，不因多线而改变规则；平台库的构建由平台承担，本来就不计费。

## 7. 与检索测试集的关系

seed-libraries-proposal.md §6 第 2 条要求每个库「至少写出三个两版答案不同的问题」。有了版本线，这条检查可以落进 `library_eval_question`：问题增加可空的 `release_label`，为空时问默认线，非空时问指定线。同一个问题对两条线各登记一条、期望的答案文字不同，构建后的评测即可持续验证「版本轴成立」，不必靠上线前人工核对一次。

Benchmark 的计分口径不变：按库汇总全部问题的命中率。

## 8. 迁移

Expand-only，一个迁移：新建 `library_release`；`library_version.release_id` 与 `workflow_operation.release_id` 可空新增。不回填、不修改既有行。存量库没有线，走 §4.2 最后一条。

回退：删除全部 `library_release` 行并把两个 `release_id` 置空后，系统回到今天的行为；非默认线的版本变成按快照标签可查的普通历史版本。

## 9. 实施阶段

1. **模型与查询**：迁移；发布事务按线替换并维护 §4.2 第一条不变量；ID 解析加入线标签；`resolve-library-id` 的 `versions` 输出线标签。管理后台在平台库详情页增加「版本线」面板（新建、冻结、设为默认）。此阶段的线由运营手工触发构建；
2. **刷新**：`workflow_operation.release_id`、连接器叠加 `source_refs`、定时刷新只排 `active`；
3. **测试集按线**：`release_label` 与 §7；seed 第一批库按 §6 检查录入问题；
4. **调用侧**：CLI `setup` 与 Skill 读取项目依赖版本并在查询时附带线标签；`re0.json` 增加 `releases` 声明，开放给用户库。

阶段 1–2 完成即可支撑首批平台库。阶段 4 的用户库开放依赖 §10 第 1、2 项。

## 10. 待评审决策

1. **用户库的容量口径**：单库容量（Free 20 MB、Pro 100 MB）按每条线计还是全部线合计。合计更简单也更保守；按线计对多版本文档更友好，但等于把容量上限乘以线数；
2. **每库线数上限**：建议平台库 12 条、用户库首期不开放；
3. **默认线的语义**：固定为运营指定的一条，还是自动跟随最新创建的线。建议固定，自动跟随会让不指定版本的调用方在来源发新版的当天无声地换了答案；
4. **`frozen` 的判定**：运营手工冻结，还是连续 N 次刷新摘要不变后自动冻结。建议首期手工；
5. **线标签的大小写**：来源使用大写时（如 `Basil`）是否折叠为小写。建议折叠，与 Library ID 一致；
6. **W3C、IETF 这类只有修订日期的来源**：是否值得建线，还是用快照标签即可。取决于 seed 第二批的实际问题。
