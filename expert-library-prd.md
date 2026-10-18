# Re0 专家库审批与分成资格 PRD

- 版本：1.0
- 日期：2026-10-17
- 状态：已自审，随本文一并实现
- 上级文档：[requirement.md](./requirement.md) 第 4.4 节、第 5.3 节
- 关联文档：[publisher-revenue-share.md](./publisher-revenue-share.md)、[architecture.md](./architecture.md)

## 1. 背景与目标

现状：任何已认领、公开且已发布的用户知识库，只要被其他工作空间成功检索，就按次写入 `earning_event` 并参与账期分成（publisher-revenue-share.md 3.1）。上传门槛与分成门槛是同一道门，带来两个问题：

- **供给质量没有筛选**：任何通过公开审核的库都分钱，公开审核只回答「能不能上架」，不回答「值不值得付钱」；
- **分成池被低价值库稀释**：分配按可计分成 Call 线性进行（share doc 6.2），一个凑数的库每被调用一次都在摊薄真正的专家库。

本文把「上架资格」与「分成资格」正式拆开：**只有被管理员标记为「专家库」的公开知识库，且其上传者是订阅用户，才参与分成**。标记必须由用户主动申请、管理员在后台审批。

### 1.1 一句话规则

> 一次 `query-docs` 要产生收益，目标库必须同时满足：公开、已发布、已认领（有 Owner 且来源权利已验证）、**带「专家库」标签**、**Owner 工作空间当前处于付费订阅**；其余既有规则（非平台库、非自刷、非匿名、日上限）不变。

## 2. 范围

### 2.1 包含

| 能力 | 说明 |
| --- | --- |
| 专家库标签 | `library` 上的一个可撤销标记，只能由后台审批写入 |
| 用户侧申请 | 知识库所有者在 Dashboard 知识库详情页发起、撤回申请，查看结论 |
| 后台审批 | 新增「专家库审批」页面：队列、详情、通过 / 拒绝 / 撤销标签，全部写审计 |
| 分成门禁 | 收益事件写入时增加两项条件：专家库标签、Owner 付费订阅 |
| 撤销反冲 | 撤销标签时，该库尚未关账账期的收益事件作废 |
| 展示 | 公开详情页显示「专家库」徽标；收益页文案说明新规则 |

### 2.2 不包含

- 不改变上架审核流程（requirement.md 7.4 五道关）与 `lifecycle_status` 状态机；
- 不改变分配算法、分成率、持有期、抵扣与出账（share doc 3.2–3.4）；
- 不按「专家程度」加权：标签只决定有／无，不决定多／少（share doc 6.2 原则延续）；
- 不做邮件 / 站内信通知，结论在 Dashboard 可见；
- 不做自动评审（分数门槛自动打标）：第一版全部人工；
- 与 [expert-data-track-proposal.md](./expert-data-track-proposal.md) 的「专家数据与评测赛道」无关：那是独立产品线，本文的「专家库」是知识库目录内的一个资格标签。

## 3. 角色

| 角色 | 现有身份 | 本文新增能力 |
| --- | --- | --- |
| 知识库所有者（Owner / Admin 角色） | `workspace_member.role in (owner, admin)` | 发起、撤回专家库申请；查看结论 |
| 工作空间 Viewer | `workspace_member.role = member` | 只读：看到申请状态，不能操作 |
| 专家库审批员 | `administrator`，持有新增能力 `expertLibraries` | 审批队列、通过 / 拒绝、撤销标签 |

`expertLibraries` 授予 `super`、`operator` 与 `reviewer`：审批本身是内容质量判断（Reviewer 的职责），后果是商业的（Operator 的职责），两类角色都需要进入；`support` 不授予。

## 4. 规则

### 4.1 申请前置条件（用户侧，提交时校验）

| 条件 | 依据 | 不满足时的提示码 |
| --- | --- | --- |
| 操作者是工作空间 Owner / Admin | requirement.md 3.3 | `access_denied` |
| 库归属于当前工作空间、非平台库、未删除 | architecture.md 5.2 | `not_found`（与不存在不可区分） |
| `visibility = public` | 用户要求 | `not_public` |
| `lifecycle_status = published` | 已通过公开审核，审批员才有可审内容 | `not_published` |
| Owner 工作空间处于付费订阅 | 用户要求：订阅用户 | `not_subscribed` |
| 该库没有待审申请 | 一库一队列 | `already_pending` |
| 该库尚未带标签 | 已是专家库无需再申请 | `already_tagged` |
| 距上一次「拒绝」或「撤销」满 7 天 | 防止反复提交挤占队列 | `cooldown` |
| 申请说明 ≤ 500 字（可选） | 给审批员的补充材料 | `invalid_note` |

「付费订阅」沿用 `lib/application/plans/in-force.ts` 的唯一定义：`subscriptionInForce()` 命中且 `plan_version.plan_id ≠ 'free'`。不另造一套判定。

### 4.2 审批通过条件（后台，决定时重新校验）

通过时**重新**检查 4.1 中的库侧条件：公开、已发布、仍归属申请时的工作空间、Owner 仍为付费订阅、当前版本索引就绪。任何一项不满足，通过被拒绝并提示 `library_ineligible`，审批员可改为拒绝或等待。拒绝不需要这些条件。

每个决定必须填写原因（≤ 200 字），写入申请记录与审计日志；通过的原因同样记录，因为它决定谁被付钱。

### 4.3 标签生效后

- 标签**不随条件变化自动摘除**：库改为私有、订阅到期、库被暂停时标签仍在，但分成门禁按调用时的实时条件判断，这些状态下不产生收益；条件恢复后自动恢复产生收益，不需要重新申请；
- 管理员可**撤销**标签（必须填原因）。撤销后：`library.expert_tagged_at` 清空，申请记录转为 `revoked`，该库在**尚未关账**账期里的收益事件标记作废（`flagged`，与库被暂停时关账作废同一机制），已关账账期不追溯；
- 所有权转移或撤销认领时，标签随库保留：标签是对内容的判断，不是对人的；但新 Owner 若非订阅用户，门禁自然不放行。

### 4.4 分成门禁（唯一的收益判定点）

`commitCall` 写 `earning_event` 的条件在既有基础上增加两项，全部在同一事务内、使用进入事务前已取得的事实判断（architecture.md 11.4）：

```text
既有：written && rightsVerified && planVersionId && caller ≠ owner
      && public && published && owner ≠ null && !platform && 日上限内
新增：&& library.expert_tagged_at IS NOT NULL
      && owner 工作空间 subscriptionInForce 且 plan ≠ free
```

不追溯：打标前的调用没有写过收益事件，打标后也不补写（与 requirement.md 4.4「不追溯认领前的调用」同一原则）。

分配、关账、结算、抵扣的代码**不改**：它们只消费 `earning_event`，而门禁已在写入侧收紧。

### 4.5 申请状态机

```text
                 ┌──────────── withdraw（所有者）──────────┐
                 │                                          ▼
  apply ──► pending ──► approve ──► approved ──► revoke ──► revoked
                 │                                 (管理员)
                 └──► reject ──► rejected
```

- 一个库同时最多一条 `pending`（部分唯一索引）；
- `approved` 与 `library.expert_tagged_at` 一一对应：通过时写入时间戳，撤销时清空；
- 历史记录只追加，不改写：一次拒绝、一次撤销都是一条留在表里的记录，详情页按时间倒序全部展示。

## 5. 用户侧流程（Dashboard）

入口：`/dashboard/libraries/[libraryId]` 新增「专家库」面板，位于元数据与解析范围表单之后、网站挂件面板之前；私有库同样显示（资格清单就是所有者了解条件的地方），已归档的库不显示。

面板内容：

1. **当前状态**：未申请 / 审核中（发起时间）/ 已通过（打标时间）/ 已拒绝（原因）/ 已撤销（原因）；
2. **资格清单**（三行，逐项打勾或说明缺什么）：公开、已发布、付费订阅。缺任何一项时申请按钮禁用并说明原因；
3. **操作**：
   - 可申请时显示「申请专家库」，展开一个可选说明框（≤ 500 字）与确认；
   - `pending` 时显示「撤回申请」；
   - `approved` 时显示徽标与「已参与分成」或「标签有效，但当前不满足分成条件：…」；
4. **历史**：该库全部申请记录（时间、结论、原因）。

Viewer 角色看到面板但没有按钮，页面已有的 `manage.readOnly` 提示覆盖此面板。

收益页 `/dashboard/revenue` 的描述与空状态文案改为：只有带专家库标签、且所有者为付费订阅的公开知识库参与分成，并给出到知识库详情页申请的指引。

公开详情页 `/libraries/...`：库带标签时在标题旁显示「专家库」徽标。目录列表第一版不加徽标（留待下一轮，与排序 / 筛选一起考虑）。

## 6. 后台审批流程（管理后台）

### 6.1 导航与权限

- 侧栏「业务管理」分组内、「所有权与认领」之后新增「专家库审批」，角标为待审数量；
- 路由 `/admin/expert-libraries`（列表）与 `/admin/expert-libraries/[applicationId]`（详情）；
- 页面与 Server Action 均以 `requireAdminCapability('expertLibraries')` 把门；
- 角色权限矩阵新增一列。

### 6.2 列表页

- Tab：待审核 / 已通过 / 已拒绝 / 已撤销 / 全部，各带计数；
- 搜索：知识库名称、Library ID、工作空间名；
- 列：知识库（名称 + ID）、申请工作空间、订阅状态（当前）、可见性 / 生命周期（当前）、申请时间、状态；
- 行内动作：查看详情；`pending` 行提供「通过」「拒绝」快捷按钮；`approved` 行提供「撤销标签」；
- 支持导出 CSV（与其它列表同一套 `CONSOLE_EXPORTS`）；
- 空状态文案说明「用户在知识库详情页主动申请后才会出现在这里」。

### 6.3 详情页

- 事实区：申请 ID、知识库、申请工作空间、申请人说明、当前所有者、当前可见性、生命周期、当前版本是否就绪、Owner 当前订阅套餐、Trust Score、申请时间、决定时间、决定人与原因；
- **资格检查区**（与 4.2 一致，逐项 通过 / 不满足）：公开、已发布、所有者未变、付费订阅、版本就绪。任一项不满足时「通过」按钮仍可点，但服务端会以 `library_ineligible` 拒绝，页面同时用通知条提醒；
- 操作：通过 / 拒绝（pending）、撤销标签（approved）；三者都弹确认框，列明后果，必填原因；
- 该库的全部申请历史与相关审计记录。

### 6.4 审计动作

| 动作 | 触发者 | `administrator_id` |
| --- | --- | --- |
| `expert_library.apply` | 所有者 | null（申请工作空间写入 after 值） |
| `expert_library.withdraw` | 所有者 | null |
| `expert_library.approve` | 审批员 | 有 |
| `expert_library.reject` | 审批员 | 有 |
| `expert_library.revoke` | 审批员 | 有 |

`target_type = 'expert_application'`，`target_id` 为申请 ID；before / after 记录状态与 `expert_tagged_at`。

## 7. 数据模型

```sql
-- 标签本体：空即不是专家库
alter table library add column expert_tagged_at timestamptz;

create type expert_application_status as enum
  ('pending', 'approved', 'rejected', 'withdrawn', 'revoked');

create table expert_application (
  id                uuid primary key,
  library_id        uuid not null references library(id),
  workspace_id      uuid not null references workspace(id),   -- 申请时的 Owner 工作空间
  status            expert_application_status not null,
  note              text,                                      -- 申请说明，≤ 500
  decision_reason   text,                                      -- 通过 / 拒绝 / 撤销原因
  decided_by_admin_id uuid references administrator(id),
  decided_at        timestamptz,
  created_at        timestamptz not null default now()
);
create unique index expert_application_pending_uq
  on expert_application (library_id) where status = 'pending';
create index expert_application_library_idx on expert_application (library_id, created_at desc);
create index expert_application_status_idx  on expert_application (status, created_at desc);
```

不在 `earning_event` 上加字段：事件是否写入已经体现了门禁结果；关账与结算代码不需要知道「为什么没写」。

## 8. 架构落点

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 领域 | `lib/domain/expert-library.ts` | 状态常量、申请 / 通过 / 撤销的纯规则、冷却期、错误类 |
| 领域 | `lib/domain/index.ts` | `isRevenueEligible` 增加两项输入 |
| 领域 | `lib/domain/admin.ts` | 新增 `expertLibraries` 能力及角色映射 |
| 应用 | `lib/application/expert-libraries/*` | 所有者侧：申请 / 撤回 / 查询；后台侧：列表 / 详情 / 决定 / 撤销 |
| 应用 | `lib/application/plans/quota.ts` | `EarningLibraryFacts` 增加 `expertTaggedAt`、`ownerSubscribed` |
| 应用 | `lib/application/retrieval/query-docs.ts` | `librarySelection` 多取两列事实 |
| 应用 | `lib/application/libraries/catalog.ts` | 公开详情返回 `isExpert` |
| 应用 | `lib/application/administration/console-exports.ts` | 注册导出 |
| Web | `app/dashboard/libraries/[libraryId]/*` | 专家库面板与两个 Server Action |
| Web | `app/admin/(console)/expert-libraries/*` | 列表、详情、Server Action |
| Web | `components/admin/sidebar.tsx`、`app/admin/(console)/layout.tsx` | 导航与角标 |
| 数据 | `db/schema.ts`、`db/migrations/0042_expert_library.sql` | 见第 7 节 |
| 文案 | `lib/i18n/messages/{zh,en}.ts` | 全部新文案，zh 为类型基准 |

检索链路（召回、排序）不读取任何新增字段：`expert_tagged_at` 只在 `commitCall` 的门禁里使用，与 share doc 6.3「分成不得影响排序」一致。

## 9. 验收标准

1. 一个公开、已发布、已认领、Owner 为 Pro 的库，**未打标**时被其他工作空间检索：`usage_event` 写入，`earning_event` 不写入；
2. 同一库通过审批后再被检索：`earning_event` 写入；
3. 同一库若 Owner 订阅到期（或为 Free）：即使带标签，`earning_event` 不写入；
4. 撤销标签后：该库当期（未关账）已有的 `earning_event.flagged = true`；已关账账期的事件不变；之后的检索不再写入；
5. 非 Owner / Admin 角色、私有库、未发布库、Free 工作空间发起申请，分别得到 4.1 表中的提示码；同一库存在待审申请时第二次申请被拒；
6. 通过时库已被改为私有、或 Owner 已降为 Free，服务端以 `library_ineligible` 拒绝通过；
7. 每个后台决定在 `audit_log` 留一条记录，含原因；用户侧申请与撤回也各留一条；
8. 不持有 `expertLibraries` 能力的管理员访问 `/admin/expert-libraries` 被送回概览页；
9. `npm run typecheck` 通过，新增契约测试与集成测试通过，既有收益测试更新后通过。

## 10. 自审记录

写完初稿后按以下问题过了一遍，结论与改动如下：

| 问题 | 结论 |
| --- | --- |
| 「订阅用户」在哪个时点判断？申请时、审批时、还是调用时？ | **三处都判断**。申请与审批时判断是为了不让审批员白看；调用时判断是真正的门禁。否则订阅到期后标签会继续付钱。 |
| 标签要不要随订阅到期自动摘除？ | 不摘。摘了用户续费后要重新排队审批，而审批判断的是内容；门禁实时判断已经保证不多付钱。 |
| 库改为私有要不要清标签？ | 同上，不清。改回公开会重新进入上架审核（既有规则），上架通过后标签仍在、分成自动恢复。 |
| 撤销标签要不要作废当期收益？ | 要，与「库被暂停时当期未出账收益作废」同一口径（share doc 5），否则撤销只对未来有效，对已经发生的刷量无约束力。只作废未关账账期，已关账不追溯。 |
| 既有 `isRevenueEligible` 有两个调用方，改签名会不会漏？ | 两处（`quota.ts`、`revenue/index.ts`）都改为必须传入新字段，编译期强制。 |
| 审批通过需不需要「当前版本就绪」？ | 需要，与上架审核 `approve` 同一要求；否则可能给一个索引失败的库打标。 |
| 要不要给 Reviewer 这个能力？ | 给。审批是内容判断；但 Reviewer 不能看账单与结算，所以在详情页只展示「当前套餐」而不展示金额。 |
| 拒绝后能否立即重申？ | 设 7 天冷却；撤销后同样 7 天。防止用队列消耗审批员时间，又不至于把一次误拒绝变成长期封禁。 |
| 要不要在目录列表加徽标 / 筛选？ | 本轮不做。它会被解读为排序信号，而 share doc 6.3 禁止分成因素影响排序；留待单独评审。 |
| 既有收益集成测试会不会全部失败？ | 会——它们的 fixture 库没有标签。更新 fixture 为打标并给 Owner 订阅，同时新增「未打标不计」「Free 不计」用例，把新规则钉死。 |
| 迁移是否可重放？ | 全部 `if not exists`，与仓库既有迁移风格一致，生产构建会自动执行（2026-10-16 起）。 |

## 11. 对既有文档的修订

- requirement.md 4.4：第一条规则增加「带专家库标签」与「所有者为付费订阅」两项；
- publisher-revenue-share.md 3.1：可计分成 Call 条件增加第 7、8 条；
- 两处修订随本文一并提交。
