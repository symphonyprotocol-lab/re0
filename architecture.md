# re0 开发与部署架构

- 版本：4.0
- 更新日期：2026-10-29（按 [agent-first-proposal.md](./agent-first-proposal.md) 第 3.4 节与第 11 节改写：资产与频道术语；删除 MCP Server 一节，新增 A2A Server；分成记账改为频道收入记账；各节编号保持不变）
- 状态：架构基线；P0、P1 已实施（P1：2026-10-30），P2 及之后的目标设计在文中以「阶段」标注区分；§4.1 登记专家模块的技术边界
- 产品需求：[requirement.md](./requirement.md)
- 设计依据：[knowleg-market.pen](./knowleg-market.pen)
- 转向依据：[agent-first-proposal.md](./agent-first-proposal.md)

> 术语说明：本文描述目标系统时一律用「数据资产」（简称「资产」）与「频道」。引用现有代码、表名、接口时保留它们现在的名字（`library`、`library_version`、`libraryId`、`/v1/libraries`、`createWorkspaceLibrary` 等），改名在提案第 3.5 节的 P5 完成；新模块与新表从现在起一律用 asset、channel 命名。

## 1. 架构结论

re0 使用一个 TypeScript 代码库交付公共站点（频道、用户主页、在线试用）、用户 Dashboard（Agent 工作台）、管理后台、REST API 和 A2A Server；耗时的抓取、解析、Embedding、刷新和删除由 Vercel Workflows 执行。网站插件、分享页与远程 MCP 已下线，代码保留在开关之后（提案第 3.6 节）。

4.0 决策把运行基座从 Vinext/Cloudflare 换到 Vercel + Neon。3.0 换栈的依据是「仓库当前基座是 vinext starter」，而该 starter 已在提交 `306e76a` 中随站点代码一并删除，依据不再成立；仓库目前没有任何应用代码，本次切换的成本仅限文档修订。

| 关注点 | 4.0 决策 |
| --- | --- |
| Web 与 BFF | Next.js App Router，Vercel 原生，不再使用 Vinext 兼容层 |
| 开发者文档站 | [Fumadocs](https://github.com/fuma-nama/fumadocs)，与主应用同一个 Next.js 项目，内容为仓库内 MDX |
| 运行环境 | Vercel Functions |
| 业务数据库 | Neon Postgres + Drizzle |
| 关键词检索 | Postgres 全文检索 + BM25 排序，可重建派生索引 |
| 向量检索 | 同库 pgvector，与 Chunk 同事务；资产内召回默认精确扫描，不依赖全局 ANN，见 §9.1 |
| 频道级发现 | 频道画像（频道内公开资产的文档标题集 + 实体表 + 聚类质心）+ 全局 GIN 倒排 + scatter-gather 确认，见 §9.6 |
| 对象存储 | Vercel Blob（私有 Blob）；同一 Adapter 接口保留 S3 兼容实现作为退路，见 §1.2 |
| 长任务 | Vercel Workflows |
| 边缘态 | Upstash Redis，只承担匿名限流与检索缓存 |
| 身份 | 可替换 Identity Adapter；首发 GitHub + Google OAuth |
| 支付 | 外部 Subscription Provider Adapter |
| Embedding / Rerank | 外部 AI Provider Adapter，可替换 |
| 契约 | Zod/JSON Schema + OpenAPI，REST 为站内权威业务入口；A2A 按 A2A Protocol v1.0（`@a2a-js/sdk` v1.x），见 §13 |
| Agent 协议 | A2A Server：三层 Agent Card、JSON-RPC 与 HTTP+JSON 绑定、SSE 流式、Postgres 任务存储，见 §13.1 |
| 可观测性 | 结构化日志、Trace、Metrics 和错误聚合 |

部署前创建一个共享 Neon Project 和一个共享对象存储 Bucket，并同时连接到 Development、Preview、Production；Upstash Database 与其余有副作用的外部服务仍按环境分别配置。所有环境变量必须由部署平台注入，不得依赖开发者本机状态。

### 1.1 核心原则

1. Web、REST、A2A 和 Admin 复用同一 Application Use Case，不复制授权、检索或计量逻辑；Agent 的工具与 A2A 的 `AgentExecutor` 只是 Use Case 的薄包装。
2. Neon 是业务状态、发布指针、关键词索引和向量的唯一权威；对象存储和缓存是可重建或可清理的派生数据。
3. 查询先授权（按 requirement.md 6.2 判断可见性）并固定资产 Version、Policy Version，再进行任何关键词或向量召回。
4. Version 不可变；刷新通过原子切换 `current_version_id` 发布。
5. Workflow 的每一步幂等、可恢复，并以 Digest 和 Operation ID 去重。
6. REST/A2A 按成功受理的 Call 计量，计费写入只追加 Usage Event；谁发起谁付 Call，匿名由平台承担并走匿名限流（requirement.md 4.2）。频道收入写入只追加 Earning Event，与支付事件同事务（§11.4）。
7. 普通用户身份与管理员身份分离，所有高风险后台动作审计。
8. 有副作用的 Agent 操作（创建、刷新、放进频道）必须经人确认；模型、资产内容与其他 Agent 都不能代为确认（requirement.md 5.2）。

### 1.2 选型理由与被否决的替代

本节记录 4.0 决策的取舍，避免后续重复讨论。

**为什么用 Neon 取代 D1 + Vectorize。** 决定性理由不是性能或额度，是**一致性边界**。3.0 形态下 Chunk 正文在 D1、关键词索引在 D1、向量在 Vectorize，三者会漂移，所以发布事务只能覆盖 D1 那一部分，向量与对象的一致性靠写入顺序约定和 Recovery 清理兜底。换成 Neon 后，Chunk、全文索引和向量在同一个 Postgres 事务内，§8.3 的发布事务成为真正的 ACID 事务，孤儿数据这一整类故障随之消失。

**对象存储：2026-09-05 改为 Vercel Blob。** 下面「保留 S3 兼容对象存储」的三条理由当时成立，现在被一个更重的运营理由压过：项目已经完全跑在 Vercel 上，Blob 随部署账户开通，Development / Preview / Production 各一个 Store 只是 Vercel 项目里的一个开关，不必再维护第二家供应商的账号、凭据轮换和 CORS 配置。代价照旧承认：`@vercel/blob` 只有一个实现，所以 `lib/infrastructure/objects/store.ts` 的 `ObjectStore` 接口不变，S3 实现原样保留，Key 布局（§7）对两者相同，换回 S3 兼容存储只是换环境变量。两点与 §7 相关的差异：

1. Blob 没有生命周期规则，§7 里「用存储侧规则清理临时对象」在 Blob 上不成立。向导中途放弃的 PDF 上传（`uploads/` 前缀）由 `drainOperations` 每次收尾时清理（`lib/application/ingestion/purge-uploads.ts`）：列出前缀，减去仍被某个 `pdf` Source 引用的 Key，删除超过 24 小时的剩余对象；也可用 `npm run uploads:purge` 手动执行。失败任务的其他临时对象仍由 Recovery 处理。
2. 浏览器直传不用预签名 PUT，而是服务端用读写 Token 签发一个限定路径、类型、大小和有效期的 Client Token，浏览器用 `@vercel/blob/client` 上传；下载用 `issueSignedToken` + `presignUrl` 生成短时 URL。两种存储的这两个动作都收敛在 `ObjectStore.uploadTicket` 和 `signedUrl` 后面。

**（原）为什么保留 S3 兼容对象存储而不用平台自带的对象服务。** 三条理由，按权重排序：

1. **可移植性**：S3 API 有多家实现，同一个 Adapter 可对 R2、S3、MinIO 等；专有对象服务只有一个实现，换平台时适配器作废。本项目已经历一次平台迁移，可移植性在此已被验证有价值。
2. **原生生命周期规则**：直接满足 §7 关于清理失败任务临时对象和过期导出的要求，不需要自建清理任务。
3. **存储单价**：容量按 GB-月常驻累积，单价差会持续放大。

出网费**不是**主要理由。re0 的检索路径读 Postgres 而非对象存储，真正流向终端用户的只有导出文件和审核用快照，量很小，不是 CDN 型负载。

**为什么 Upstash 只承担两件事。** 匿名限流和检索缓存在上一版是运行平台自带能力，换栈后丢失，Upstash 是补回这两项能力，不是新增能力。明确否决三种扩大用法：

- **不使用 Upstash Vector**：会重新制造「Chunk 与向量分属两个系统」的分裂，直接抵消采用 Neon 的全部收益；
- **不使用 Upstash Workflow / QStash 承担长任务**：Vercel Workflows 已承担该职责，两套持久化执行引擎意味着两套重试语义、两套 Step 状态和两套幂等 Digest 对齐，是负债而非冗余；调度用 Vercel Cron；
- **不把额度计数迁入 Redis**：见 §11.1，Reservation 与 Usage Event 是计费数据，必须与业务库同事务。

**被否决的方案：继续留在 Cloudflare。** 其优势是单一供应商、免费额度更宽、边缘能力自带。放弃它的代价是接受四家供应商的管理面。判断依据是当前处于零代码阶段，Adapter 边界可以一次画对；若已有大量基础设施代码，结论可能相反。

## 2. 与 Context7 的对齐边界（历史）

Context7 已从 requirement.md 第 1 节的决策顺序中移除，不再约束本文。本节留作历史记录，说明哪些做法来自早期借鉴、哪些从一开始就不同。

### 2.1 直接借鉴（历史）

- REST 的 Library Search、Context、Policies、Refresh、Add Source 资源形状；
- `/owner/repo`、`/source/slug` 和版本化资产 ID；
- JSON/TXT 双格式，TXT 由结构化结果渲染；
- SDK 的 Bearer Key、超时、有限重试和错误映射；
- 来源侧 JSON 配置、按热度后台刷新、Policy 的 quality/select 模式。

曾借鉴的两项 MCP 工具、`/mcp` 与 `/mcp/oauth` 入口、stdio 包装器与 CLI 的 setup/remove/skill 分发随 MCP 下线不再适用。

### 2.2 不直接复制

- re0 自己是 Agent，而不是给别人的 Agent 用的知识层：资产按来源分类型、按频道组织，对外的出口是频道、Agent Card 与 A2A；
- re0 的 Trust Score 使用 0–100，可见性由频道与 `access` 决定，不做发布前人工审核；
- re0 使用自己的命名、Schema、API Host、Key 前缀和自有数据平面；
- Context7 的 `resolve-library-id` 把「从问题提炼库名」外包给调用方 LLM，服务端只做名字/描述的元数据匹配。re0 的用户资产名字与内容常不相关（「昆虫大全」里的「影翅虫」），跨资产、跨频道的内容路由是 re0 必须自建的能力，见 §9.6。

## 3. 系统上下文与部署拓扑

```mermaid
flowchart TB
    Clients["Browser / A2A Agent / SDK / CLI"]
    Edge["Next.js App on Vercel\nPublic + Dashboard + Admin + REST + A2A"]
    Identity["GitHub / Google OAuth"]
    Payment["Subscription Provider"]
    PG[("Neon Postgres\nbusiness state + fulltext + pgvector + usage + audit")]
    OBJ[("Private Blob / S3-compatible Bucket\nsnapshots + normalized documents + images + audio")]
    CACHE[("Upstash Redis\nratelimit + retrieval cache")]
    WF["Vercel Workflows\ningest / refresh / delete"]
    Sources["GitHub / Website / Upload / Notion / Editor / Audio"]
    AI["Embedding / Rerank / Safety Providers"]
    Obs["Logs / Traces / Metrics / Alerts"]

    Clients --> Edge
    Edge --> Identity
    Edge --> Payment
    Edge --> PG
    Edge --> OBJ
    Edge --> CACHE
    Edge --> WF
    WF --> Sources
    WF --> AI
    WF --> PG
    WF --> OBJ
    Edge --> Obs
    WF --> Obs
```

### 3.1 运行边界

Edge App 只执行：

- 页面渲染和短 BFF 请求；
- Session/API Key 认证（A2A 的 Bearer 就是 API Key）；
- 工作空间授权、可见性（requirement.md 6.2）、Policy 和额度检查；
- Library Search、频道路由、全文与向量召回、融合、短 Rerank 和格式化；
- 四个生成入口的生成链路（§9.5）；
- A2A 请求处理、任务状态读写与 SSE 推送（§13.1）；
- Agent 工作台的工具调用与确认门（待确认操作的生成与执行）；
- Workflow 启动、状态读取和发布/删除入口；
- Payment Webhook 验签与幂等入库（含频道订阅事件）。

Workflow 执行：

- Git 抓取、网站爬取、Notion 同步、编辑器正文与音频文件处理；
- 解压、恶意文件检查、Parser、Chunker 和 Citation；
- Embedding 批处理、全文索引与向量写入（与 Chunk 同事务）；
- 质量评估、刷新、重建和数据删除。

普通请求不得同步等待完整 Ingestion。小型文件仍进入 Workflow，以保持同一状态机和重试语义。

### 3.2 环境隔离

`development`、`preview`、`production` 的资源边界如下：

- 共享一个 Neon Project，按环境分支：production 用主分支；每个预览部署由 Neon 集成在构建前自动建一个 `preview/<git 分支>` 子分支，连接串只注入那一次部署（项目级 Preview 变量不变，所以在 Vercel 的环境变量列表里看不到它）；本地开发连一个常驻的 `dev` 子分支（Auto-delete 设为 Never，否则默认一天后被回收）。预览分支上的新迁移由 `vercel.json` 的 `buildCommand` 在 `VERCEL_ENV=preview` 时执行，生产的迁移不在构建里跑，仍按 §19.2 排序；
- 每个环境一个私有对象存储 Bucket（`recall0-blob` / `recall0-blob-preview` / `recall0-blob-dev`），跟着库的分支一起分。**必须分**：`purgeAbandonedUploads` 以「本库没有任何 `pdf` 源引用它」为删除依据，库删除也照着行里的 Key 删对象；库分支了而 Bucket 共用时，非生产环境的这两条路都会删到生产对象。Key 布局（§7）三个 Bucket 相同，由 Workspace、批次和文件 ID 生成；
- 独立 Upstash Database 与 REST Token；
- 独立 OAuth Client、Payment Environment 和 Provider Key；
- 独立 Workflow 名称和 Webhook Secret。

禁止把 Production 数据复制到 Preview。必要的测试数据必须脱敏或由 Fixture 生成。**这条与当前的预览分支实现有冲突**：Neon 集成建的是主分支的写时复制分支，行数据跟着过去。主分支今天只有 Plan 种子，所以尚未违反；在主分支收下第一份真实用户数据之前，预览分支必须换成 schema-only（Neon API 的 `init_source: "schema-only"`），否则每个预览部署都是一份生产数据的副本。

共享一个库带来一条反向约束：**凡是参与加密或哈希数据库内容的 Secret，三套环境必须取同一个值**——`SESSION_SIGNING_SECRET`（封装 GitHub / Notion 授权令牌、派生管理员邀请哈希、封装落库的 TOTP 种子；种子本身每次渲染随机生成，不由该 Secret 派生）、`API_KEY_HASH_SECRET` 和 `CREDENTIAL_ENCRYPTION_KEY`。各持一份时，一个环境写下的行在另一个环境打不开：preview 里连好的 Notion 授权到了生产就解不开，本地发出的管理员邀请在生产完成不了。只与传输或会话有关、不落库的 Secret 不受此约束。

## 4. 代码组织

目标布局（旧模块名在 P5 统一改为 asset；页面路径随 P1 改为 `/assets/*`、`/channels/*`；标注「开关」的模块已下线但代码保留；标注阶段的目录在该阶段出现）：

```text
app/
  (public)/
    page.tsx                # 首页：对话入口、四个场景、频道目录、给 Agent 开发者（P1 改版）
    pricing/
    playground/             # 公开演示：只读、只查公开频道里的免费资产
    libraries/              # P1 改为 assets/：资产详情、认领向导
    channels/               # 频道目录与频道主页（P1）
    u/[handle]/             # 用户主页（P1）
    login/
  .well-known/agent-card.json/   # 平台 Agent Card（P1）
  a2a/[[...tenant]]/route.ts     # A2A Server：三层卡的 JSON-RPC 与 HTTP+JSON（P1）
  docs/                     # Fumadocs 开发者文档站
    layout.tsx
    [[...slug]]/page.tsx
  dashboard/
    page.tsx                # Agent 工作台（P2）
    libraries/              # P1 改为 assets/
    channels/               # 我的频道、待答列表、评论管理、订阅收入（P1 / P3a）
    api-keys/
    requests/
    policies/
    revenue/                # 改为展示频道订阅收入与出账（P3a）
    settings/
  admin/
    login/
    overview/
    users/
    libraries/              # 资产与频道：下架与恢复
    claims/                 # 认领与争议裁定
    platform-libraries/
    plans/
    billing/
    settlements/            # 频道收入结算与出账
    administrators/
    audit/
  api/v1/
    libraries/              # P5 改为 assets/
    context/
    claims/
    policies/
    usage/
    requests/
    anchors/
    api-keys/
  api/search/               # Fumadocs 搜索索引
  embed/                    # 开关：网站插件，已下线
  s/                        # 开关：分享页，已下线
  mcp/                      # 开关：远程 MCP，已下线
content/
  docs/                     # 文档站 MDX 内容
components/
contracts/
  api/
  a2a/                      # Agent Card 与 Artifact `data` Part 的 Schema（P1）
  errors.ts
  schemas.ts
db/
  schema.ts
  migrations/
  queries/
lib/
  source.ts                 # Fumadocs loader
  application/
    auth/
    libraries/              # P5 改为 assets/
    channels/               # 频道、归属、可见性、目录排序（P1）
    claims/
    ingestion/
    retrieval/
    playground/             # 共用的 Agent 循环与生成链路
    agent/                  # 工作台工具、待确认操作（P2）
    a2a/                    # AgentExecutor、Agent Card 生成、TaskStore（P1 / P2）
    posts/ audio/ comments/ qa/   # 文章、音频、评论、问答（P3a / P3b）
    policies/
    plans/
    revenue/                # 频道收入记账、结算、出账
    embed/ showcase/        # 开关：已下线
    administration/
  domain/                   # 含保留 owner 名单、资产 ID 解析
  webmcp/                   # 开关：已下线
  infrastructure/
    postgres/
    objects/
    cache/
    identity/
    payment/
    ai/
    chain/
    connectors/
workflows/
  index-library.ts
  refresh-library.ts
  delete-library.ts
  anchor-versions.ts
  anchor-audit.ts
  settle-revenue.ts         # 频道收入结算
move/
  re0_anchor/               # 锚定 Move 包，见 §8.5
packages/
  sdk/
  cli/
  verifier/
  mcp/ tools-ai-sdk/        # 开关：已下线
skills/
plugins/
tests/
  contract/
  integration/
  e2e/
  security/
  fixtures/
```

已删除的模块：`lib/application/expert-libraries`（专家库标签、申请、门槛）、自检问题（`library_eval_question`）、按检索计收益的分成部分（可计分成 Call、分成池、`share_rate`）；`lib/application/revenue` 保留并改记频道收入。`llms_txt` 与 `openapi` 连接器删除。

约束：

- Route Handler、Agent 工具与 A2A `AgentExecutor` 只能调用 `lib/application` Use Case；
- `contracts` 是 REST、A2A、SDK、CLI 和前端共同的权威类型来源；
- 下线的模块（网站插件、分享页、MCP）由开关隔离：入口与路由撤掉，代码保留，开关关闭时不注册路由、不出现在导航与 sitemap；
- 新代码从现在起一律用 asset、channel 命名，不再新增 library 标识符；
- Provider SDK 只出现在 `lib/infrastructure` 或 Workflow；
- Domain 不依赖 Next.js、Vercel、Neon、Payment、AI SDK 或链 SDK；
- 管理后台不能直连表，必须经过 Admin Use Case 和 Audit Decorator；
- `packages` 只放需要独立发布的薄客户端，不放服务端检索实现；
- `packages/verifier` 不得 import 任何 `lib/` 代码，见 §8.5；
- `move/` 是链上产物，不参与应用构建：Next.js、typecheck 和 vitest 都不读它，它的工具链是 Aptos CLI，见 [move/README.md](./move/README.md)；
- **文档站是内容，不是应用**：`app/docs` 与 `content/docs` 只读取仓库内 MDX，不访问 Postgres、对象存储或任何 Use Case；它的构建失败不得阻断 API 与 A2A 的部署。

### 4.1 专家模块的技术边界

专家数据与评测赛道（requirement.md §2.4，方案见 [expert-data-track-proposal.md](./expert-data-track-proposal.md)）是同一代码库内的**旁路模块**：它复用基座，不进入资产与频道的任何主链路。该赛道的「Data Asset」是合同交付物，与本文的「数据资产」不是同一个对象。本节只定边界，模块内部设计以方案为准。

**放在哪里。**

```text
app/expert/                       专家区，独立 Layout 与导航，不在 /dashboard 下
app/dashboard/data-assets/        买方控制台（阶段 2）
app/dashboard/evaluations/
app/admin/(console)/expert*/      运营、合规、财务页面
app/api/v1/data-assets/           买方 API（阶段 2）；专家 API 不在首期
app/api/v1/data-exports/
app/api/v1/evaluation-runs/
contracts/expert-data.ts          由 contracts/api/index.ts 导出
lib/domain/expert-data/
lib/application/expert-data/      accounts、profiles、knowledge、orders、projects、
                                  submissions、reviews、assets、licensing、exports、
                                  evaluations、compensation、administration
lib/infrastructure/evaluation/    评测 Runner 与买方模型端点 Adapter
workflows/process-expert-submission.ts
workflows/build-data-asset.ts
workflows/build-data-export.ts
workflows/run-expert-evaluation.ts
workflows/settle-expert-compensation.ts
```

**复用什么，怎么复用。**

| 基座能力 | 复用方式 | 硬边界 |
| --- | --- | --- |
| `user` / OAuth（§5.1） | 只复用登录身份 | 专家身份是独立的 `expert_account`，不是 `workspace_member`；进入 `/expert` 以 `expert_account` 存在为准，普通 Dashboard 的会话解析不读专家表 |
| `workspace` | 只作买方与资产所有权边界 | 专家模块的所有对象以 `expert_account` 为所有者，不引用 `workspace` |
| `administrator` / Permission / Audit Decorator（§5.3、§14） | 直接复用 | 新增 `expert_*`、`data_asset.*`、`data_license.*` 权限；不新增宽泛的 `expert.manage` |
| `api_key` | 新增买方 Scope `assets:read`、`assets:export`、`evals:run` | 现有 Key 默认不获得这些 Scope；专家 Scope 推迟到阶段 4 |
| `ObjectStore`（§7） | 复用 Adapter 与私有 Store | 独立前缀（§7 末尾）；Adapter 之上加按前缀校验调用方的 Guard，Blob 没有前缀级 IAM，隔离全部在应用层 |
| `workflow_operation` / `runOperation`（§8） | 复用持久化 Step、幂等键与 Recovery | 独立 Operation Type 族 `expert.*`，不进入 Library Refresh 队列状态机，不出现在 `/admin/refresh-queue` |
| `audit_log` | 记录高风险管理动作 | 任务正文、Gold、证件、合同正文不进日志 |
| Payment Adapter（§11.3） | 复用外部收付款原则与 Webhook 幂等 | 不复用 `billing_document`、`revenue_period`、`settlement`、`payout`；专家侧有自己的 `expert_settlement` / `expert_payout` |
| `llm_config`（§9.5） | 不复用 | 买方模型凭证用独立的 `evaluation_model_config`，Secret 按 Workspace 隔离加密入库 |
| Anchor（§8.5） | 后续增加 Subject 类型 | 不阻塞发布、授权、导出、评测或付款 |

**不进入什么。** 以下是不变量，任何一条被违反视为缺陷：

- 专家知识与训练样本不写入 `library`、`library_version`、`document`、`chunk`、`library_profile`、`channel`，不建 `search_vector` 与 `embedding`，不进入 §9 的任何检索路径与缓存；
- `/v1/context`、`/v1/libraries/search`、A2A 技能、在线试用不读专家模块的表和前缀；
- 专家数据订单不产生 `usage_reservation`、`usage_event`、`earning_event`，不进入 `revenue_period` 与频道收入结算；
- Hidden Eval 的 Payload、Gold 与 Rubric 私有部分不进入普通导出、日志、Trace、Analytics 与前端缓存，只有 Eval Runner 的 Use Case 可读；
- 专家区与资产 Dashboard（Agent 工作台）不共享 Layout、导航、i18n 命名空间（专家区用 `expert.*`）和列表查询；
- 删除 `app/expert`、`app/admin/(console)/expert*`、`lib/{domain,application}/expert-data`、`lib/infrastructure/evaluation` 与上述五个 Workflow 后，§18 现有全部测试保持通过，不需要修改或回填任何既有表。

**数据与迁移。** 专家模块的表全部以 `expert_`、`data_`、`media_`、`license_`、`evaluation_`、`acceptance_` 为前缀，只做 Expand 迁移，不修改既有列；金额、ID 与时间遵循 §6.4。Hidden Eval 与普通 Data Item 在同一 Postgres 内以行级状态区分，两者的隔离是应用层的：独立的对象存储前缀加访问 Guard，不是物理隔离，对外不得如此表述。

**分阶段进入代码库。** 阶段 0 只上线专家预注册、资格测试与后台验证队列（Migration 1 中的身份部分）；其余按方案 §17 的门禁推进。阶段 0 门禁未过时，代码库里不出现买方 API、导出与评测 Runner。

## 5. 身份、工作空间与授权

### 5.1 普通用户身份

Identity Adapter 提供统一接口：

```ts
interface IdentityAdapter {
  beginOAuth(provider: "github" | "google", returnTo: string): Promise<Response>;
  handleCallback(request: Request): Promise<IdentityProfile>;
  getSession(request: Request): Promise<UserSession | null>;
  revokeSession(sessionId: string): Promise<void>;
}
```

Identity Provider 的 Subject 是外部身份主键；邮箱只用于展示和验证，不作为资源外键。账户绑定必须要求现有会话或二次验证。

API Key 格式使用 `mm_live_` / `mm_test_` 前缀。服务端只保存：

- Key ID、Hash、Prefix、Last Four；
- Workspace、名称、环境、Scopes；
- Created/Expires/Revoked/Last Used 时间。

完整 Key 只在创建响应中出现一次。

**GitHub 仓库导入授权。** 登录只回答「你是谁」，登录换到的 Provider Token 用完即弃（requirement.md 12）。工作空间导入 GitHub 库时，规则是「只能导入自己控制的、公开且非 Fork 的仓库」——自己名下，或在组织中拥有 admin / maintain 权限（与 §5.4 认领的门槛相同）（`lib/domain/github.ts`），因此向导先要求一次独立的 GitHub 授权（`POST /api/auth/github/connect`，回调 `/api/auth/github/callback/connect`，须与登录回调一起登记在 GitHub App 的 Callback URL 列表里，GitHub App 要求精确匹配），只申请 `read:user read:org`（后者让应用看得见组织成员身份，否则组织仓库列不出来），不申请任何 `repo` 写权限——公开仓库的内容本就无需授权即可读取，这次授权买到的不是内容访问权，而是「列出的是谁的仓库」的证明。换到的 Token 用 Cookie 密封密钥加密后单独存入 `github_connection`（每用户一行，重连即替换），向导用它列出 `affiliation=owner,organization_member&visibility=public` 的仓库并在应用层剔除 Fork 与权限不足的组织仓库（限制第三方应用的组织需先批准本应用，其仓库才会出现）；提交时 `createWorkspaceLibrary` 不信任向导列表，用同一 Token 重读所选仓库，比对 GitHub 返回的 owner id 与授权账号 id、或 `permissions` 中的 admin / maintain，并把仓库 id 写入 `source.config.repositoryId` 供 §5.4 的认领比对。GitHub 回应 401 即视为用户已在 GitHub 侧撤销，连接记录随即删除。

### 5.2 工作空间授权

所有普通资源绑定 `workspace_id`。授权顺序：

1. 解析 Session 或 API Key（A2A 请求的 Bearer 就是 API Key，另按 `tenant` 识别卡的层级）；
2. 检查用户、工作空间和 Key 状态；
3. 检查 Membership Role 与 Key Scope（A2A 写操作要求 `assets:write`）；
4. 加载 Plan Version 和 Policy Version；
5. 对具体资产按 requirement.md 6.2 判断可见性：所在频道的可见性、`access`、调用者是否为所有者或订阅者。

不得先全局召回不可见内容再在应用层过滤。不可见资产与不存在资产使用相同 404 外观。

### 5.3 管理员身份

管理员单独使用 `administrator`、`admin_session`、`admin_role` 和 `admin_permission`：

- 强制 MFA、30 天滑动 Session（每次使用顺延，一个月未使用即失效）且自登录起最长 90 天必须重新认证、停用账户或清除二次验证即刻吊销；
- 不接受普通用户 API Key；
- 角色最小化：Reviewer、Support、Operations、Super Admin；
- 高风险动作要求 `reason`，由统一 Audit Decorator 写入日志；
- Super Admin 权限变更不能由被修改者本人单独完成。

**首位管理员**（requirement.md 3.2）：管理员由邀请产生，但空环境里没有人可以发出第一封邀请，于是 `administrator` 表为空时 `/admin/login` 渲染注册表单而不是登录表单（`offerBootstrap`），提交走 `bootstrapFirstAdministrator`。三点决定它不是一个自助注册后门：

1. **判定在写入里，不在页面里**。插入语句自带 `where not exists (select 1 from administrator)`，决定与写入之间没有空隙；绕过页面直接调用 Server Action 得到的是同一个 `bootstrap_closed`。
2. **并发由 `pg_advisory_xact_lock` 串行化**。两个同时到达的请求在 READ COMMITTED 下会各自读到空表，锁让它们排队，后到的那个看见前者写下的行。
3. **MFA 不因为是第一个就可以跳过**。密钥由服务端从签名密钥派生（`admin-totp:bootstrap`），浏览器不参与选择；必须先提交一个能验证通过的 6 位码，账户才会以 `active` 落库。派生意味着它对任何能打开该页面的人可见——但能打开该页面的人本来就能直接把账户注册掉，所以这不额外让渡什么。

首位管理员固定拿 `super` 角色，注册以 `admin.bootstrap` 记入审计链，操作者与目标都是它自己——这是这套日志里唯一一条没有前置操作者的记录。

### 5.4 来源所有权验证（Claim）

产品规则见 [requirement.md](./requirement.md) 第 7.3 节。这里是授权链路的一部分：`library.owner_workspace_id` 决定谁能改这项资产，也决定它能否放进公开频道（来源型资产入公开频道前必须已认领，requirement.md 7.3），因此它的写入路径必须比普通业务写入更严。

- **唯一写入口**：`owner_workspace_id` 只能由「`verified` 的认领」或「管理员争议裁定」写入，不存在第三条路径；Ingestion、审核和刷新都不得触碰该字段；
- **登录身份不是证据**：OAuth Subject 只回答「你是谁」。GitHub 权限校验必须用用户自己的 Token 向 GitHub 查询其对目标仓库的权限级别，并核对返回的仓库 ID 与 `source` 记录一致，不能只比对仓库名字符串；
- **挑战 Token**：高熵随机值，只保存 Hash；与 `(申请人, library_id, 验证方式)` 绑定并带 7 天过期；校验时按 Hash 比对，明文只在生成时返回一次；
- **域名验证**：网站资产的域名挑战记录在 `domain_verification`（`lib/domain/domain-verification.ts`、`lib/application/libraries/domain-verification.ts`），与 `(workspace, host, 验证方式)` 绑定；明文 Token 只返回给发起方，之后每次校验都由客户端带回并按 Hash 比对，错误 Token 与不存在的挑战返回相同结果。消费挑战时要求状态为 `verified`、域名与来源 host 完全一致（子域不继承）、验证时间在 1 小时以内，并同事务写入一条 `verified` 的 `library_claim`，任一条件不满足则整体回滚。**阶段**：`createWorkspaceLibrary` 仍在创建网站资产时消费挑战（`consumed_library_id`）；P1 起「放进公开频道」的用例（`lib/application/channels/manage.ts` `moveAsset`）检查网站有本工作空间已验证的认领、GitHub 库有导入时记下的仓库归属，缺了即拒。把消费点挪到移入公开频道时、创建不属于频道的资产不再要求验证（requirement.md 7.3.1），尚未实施。`llms.txt` 与 OpenAPI 来源已删除；
- **DNS 与 well-known 校验走同一条出网安全通道**：复用 §15.1 的解析与抓取约束（禁止私网、Metadata Endpoint、Loopback、重定向绕过），验证请求不因用途特殊而放宽；DNS 查询使用受控解析器，不接受用户指定的 nameserver；
- **并发**：同一 `library_id` 的 `pending` 认领由部分唯一索引保证只有一个；校验通过时在单事务内完成「认领置 verified + 写 owner + 追加审计事件」，失败则整体回滚，避免出现有 owner 却无认领记录的状态；
- **限流与冷却**：发起与重试按 `账户` 和 `library_id` 双维度限流，承载在 §11.2 的同一限流设施；连续失败到阈值后锁定入口，需人工解锁；
- **响应最小化**：失败只返回稳定原因码，不回显 GitHub 权限详情、DNS 响应原文或抓取正文；对调用者不可见的资产，认领接口的响应必须与「不存在」不可区分，避免成为私有资产探测面；
- **审计**：发起、通过、失败、争议、转移、撤销全部写入 `audit_log`，其中转移与撤销属于高风险动作，要求 `reason`。

## 6. Postgres 数据模型

### 6.1 身份与商业

| 表 | 核心职责 |
| --- | --- |
| `user` | 普通账户、状态、展示资料 |
| `oauth_account` | Provider Subject 与 User 映射 |
| `user_session` | 普通用户会话摘要和撤销状态 |
| `github_connection` | 用户为仓库导入授予的 GitHub Token（加密）、GitHub 账号 id 与 login，每用户一行 |
| `user.storage_tier` | 容量档位：`base`（500 MB）/ `extended`（2 GB），首次订阅频道或购买 Additional Calls 时升级，不回退 |
| `workspace` | 资源和计费边界；`handle` 是工作空间的公开名，唯一，用于 `/u/{handle}` 与用户卡（P1） |
| `workspace_member` | Role 与状态 |
| `api_key` | Hash、Scope（含 A2A 写操作的 `assets:write`，P2）、环境和使用状态 |
| `plan` | 只剩一个免费档；Additional Calls 是加购包，不是订阅档位；`pro` 已删除 |
| `plan_version` | 不可变的月度免费 Calls、Additional Calls 价格、两级工作空间容量、API Key 上限（20）和构建费率 |
| `subscription` | 套餐订阅的 Provider Customer/Subscription、周期和状态；Pro 取消后只剩注册时写入的免费行 |
| `channel_plan_version` | 频道的不可变订阅方案：`interval`、`price_minor`、`currency`、`fee_rate_bps`（2000）、`provider_price_id`、`effective_from`（P3a） |
| `channel_subscription` | 频道订阅：`channel_id`、`user_id`、`plan_version_id`、`status`、`current_period_end`、`cancel_at_period_end`、`provider_subscription_id`（P3a） |
| `addon_grant` | 已购 Additional Calls 的总量、已用量和剩余余额；**无到期时间**，跨账期结转 |
| `payment_event` | 验签后的外部 Event 幂等记录 |
| `billing_document` | Provider 订单/发票的只读投影：外部 ID、状态、金额、币种；管理后台账单页读它 |

### 6.2 知识与检索

| 表 | 核心职责 |
| --- | --- |
| `library` | 一项资产：稳定 ID、Workspace、`kind`（七种资产类型）、`access`（`free` / `paid`，移出频道时重置为 `free`）、生命周期、当前版本、删除墓碑（`deleted_at`，见 §8.4）；`visibility` 列随频道落地删除（P1），可见性由所在频道与 `access` 决定；P5 改名 `asset` |
| `library_alias` | 旧 ID 到新 ID 的 Redirect |
| `channel` | 频道：`slug`、`workspace_id`、`title`、`description`、`visibility`（public / private，默认 public）、`status`、`subscriber_daily_limit`（可空）、`profile`（频道画像，§9.6）（P1） |
| `channel_asset` | 资产归属：`channel_id`、`asset_id`（**唯一**，一项资产最多属于一个频道）、`pinned_at`、`published_at`、`scheduled_at`（P1）。平台资产放在 `workspace_id` 为空的平台频道 `re0` 里 |
| `channel_visit` | 频道目录「热门」的活跃度输入：`channel_id`、`visitor_kind`（user / workspace / anonymous）、`visitor_key`（用户、调用方工作空间或匿名限流用的哈希键）、`visited_on`，每位访问者每天一行，所有者不记（P1）；权重与半衰期在 `retrieval_config` 的 `channel_*` 列 |
| `source` | 类型（`website`、`github`、`pdf`、`markdown`、`notion`，新增 `editor`、`audio`；`llms_txt`、`openapi` 已删除）、位置、配置、Credential Reference、刷新策略；每项资产只有一个 Source |
| `library_version` | Source Digest、解析版本、质量、不可变状态 |
| `document` | 规范化文档元数据和对象存储 Key |
| `chunk` | 正文、Token、Citation、质量和安全状态、`search_vector` 与 `embedding` 列 |
| `library_rule` | 来源维护者规则，按 Version 冻结 |
| `library_review` | 历史上的公开审核记录；发布前审核取消后只记频道层面的下架与恢复（requirement.md 7.4） |
| `post_draft` | 文章草稿，发布前不进版本线（P3a） |
| `audio_media` | 音频文件：`asset_id`、`object_key`、`mime`、`bytes`、`duration_ms`、`sha256`（P3b） |
| `comment` / `comment_report` | 评论与举报；评论不是资产，不进检索、不上链（P3a） |
| `channel_question` / `answer_endorsement` | 待答列表与作者确认（P3a） |
| `library_claim` | 认领申请：申请人、验证方式、挑战 Token 摘要、状态、失败原因码、过期时间、裁定记录 |
| `domain_verification` | 创建前的域名挑战：工作空间、host、验证方式、Token 摘要、状态、尝试次数、过期与验证时间、消费它的 Library（§5.4） |
| `library_score` | Trust/Benchmark（只有结构分）算法版本和分项；`library_eval_question` 已删除 |
| `library_profile` | 资产级内容画像：文档标题与目录集、关键实体与同义词表、chunk 向量聚类质心、自动生成的描述与主题标签；随 Version 发布派生，可重建。跨频道发现用的画像上移到 `channel.profile`，由频道内公开资产的画像聚合而来，见 §9.6 |

### 6.3 Policy、Usage 与运营

| 表 | 核心职责 |
| --- | --- |
| `policy_version` | 工作空间不可变 Policy 快照 |
| `policy_library_entry` | Allow/Block/Except 的 Library/Org/Domain 条目 |
| `usage_reservation` | 并发额度预留、提交和释放的操作状态 |
| `usage_event` | 只追加的最终计费事实与诊断字段 |
| `usage_summary` | 周期与日期聚合，可重建 |
| `publisher_account` | 创作者收款资料：PayPal 邮箱、`tax_form_status`、`tax_form_kind`（W-9 / W-8BEN 等）、协议版本 |
| `earning_event` | 只追加的频道收入事实：`channel_id`、`channel_subscription_id`、`provider_transaction_id`、`gross_minor`、`share_bps`（8000）、账期、状态；退款与拒付记为负数，注销核销记为 `written_off`（P3a）。按检索计收益的字段（`share_rate`、可计分成 Call）已删除 |
| `revenue_period` | 账期、结算状态；可分配池与可计分成 Call 总数已删除 |
| `payout` | 出账金额、方式（paypal）、收款 PayPal 邮箱、交易号、状态（requested / paid / failed）、失败原因、申请人与处理人 |
| `agent_conversation` / `agent_action` | 工作台对话与待确认操作（工作台与 A2A 共用）：`tool`、`params`、`estimated_calls`、`estimated_bytes`、`makes_public`、`state`（pending / confirmed / rejected / expired）、`a2a_task_id`、`expires_at`（P2） |
| `a2a_task` | A2A 任务：`id`、`context_id`、`workspace_id`、`api_key_id`、`tenant`、`skill`、`state`、`history`、`artifacts`、`workflow_run_id`、`body_purge_at`（P1） |
| `a2a_push_config` | 推送通知配置：`task_id`、`url`、`token`（加密保存）（P2） |
| `anchor_batch` | 批次类型、Leaf Schema 版本、Merkle Root、Leaf 数、窗口区间、网络、交易哈希、状态、重试次数、确认时间 |
| `anchor_leaf` | 批次 ID、Leaf 哈希、Leaf Schema 版本、Subject 类型与 ID、Leaf 序号、Merkle Proof |
| `workflow_operation` | Ingest/Refresh/Delete 状态、Digest、Attempt、错误 |
| `request_log` | 面向用户的请求摘要，不存 Query 正文 |
| `report` | 举报、侵权和安全事件 |
| `administrator` | 后台账户和 MFA 状态 |
| `admin_role` / `admin_permission` | 后台 RBAC |
| `audit_log` | 管理动作的防篡改审计链 |

### 6.4 ID、约束与时间

- 内部 ID 使用应用生成的 UUIDv7；
- 所有时间保存 UTC ISO 8601 或整数 Epoch，界面按用户时区渲染；
- `library.public_id`、`api_key.key_hash`、`usage_reservation.request_id`、`usage_event.request_id`、`payment_event.external_event_id` 必须唯一；
- `library.current_version_id` 只能指向同一资产的 Ready Version；
- `channel_asset.asset_id` 唯一；`channel.slug` 在平台内唯一；`workspace.handle` 唯一；
- `chunk` 必须同时包含资产、Version、Document 和 Citation；
- `workflow_operation` 对 `(library_id, source_digest, operation_type)` 唯一；
- `anchor_leaf` 对 `(subject_type, subject_id, leaf_schema_version)` 唯一，`anchor_batch.tx_hash` 唯一；Subject 类型为 `version | audit_head | earning_statement`，三者共用同一套批次、Leaf 与 Proof 结构；
- `library_claim` 对 `library_id` 的 `pending` 记录有**部分唯一索引**，保证同一资产同时只有一个进行中的认领；挑战 Token 只存 Hash，不存明文；`library.owner_workspace_id` 只能由 `verified` 的认领或管理员裁定写入；
- `addon_grant` 没有到期字段；余额只在消费时递减，账期滚动不得清零或重估；
- 金额保存整数最小货币单位和 ISO 4217 币种，不使用浮点数。

`search_vector` 与 `embedding` 是 `chunk` 上的派生列，随 Chunk 同事务写入，因此不存在独立的向量清单或跨系统清理批次。数据库导出不依赖全文与向量索引；恢复时从 `chunk` 正文重建 `search_vector`，`embedding` 可从正文重新调用 Embedding Provider 生成，也可随备份一并导出以省去重算成本。`library_profile` 同属派生数据，可从已发布 Version 的内容重建。可重建性也是成本手段：长期无查询的冷资产允许把 `embedding` 置空释放存储，按需重算，见 §9.1。

### 6.5 转向后的新增、删除与改名

新表从一开始就用 asset、channel 命名；对现有 `library` 表的改动先写在现有表上，P5 随表一起改名。完整清单见提案第 12 节：

- **新增**：`library.kind`、`library.access`、`workspace.handle`、`user.storage_tier`、`channel`、`channel_asset`、保留 owner 名单（`lib/domain`）、`post_draft`、`audio_media`、`comment`、`comment_report`、`channel_plan_version`、`channel_subscription`、`publisher_account` 的税务字段、`earning_event` 的频道收入字段、`channel_question`、`answer_endorsement`、`agent_conversation`、`agent_action`、`a2a_task`、`a2a_push_config`、`api_key.scopes` 的 `assets:write`；
- **删除**：`library_eval_question`；`library.expert_tagged_at` 与专家申请相关表；分成池与按检索计收益所用的字段；`library.visibility`（P1）；`source_type` 的 `llms_txt`、`openapi`；分享页线索相关表；
- **停用（保留在开关之后）**：`site_key`、`library_showcase`、`library_showcase_daily` 及分享页域名相关表；
- **P5 改名**：13 张表名含 library（`library`、`library_version`、`library_profile` 等）与 22 个 `library_id` 列一次迁移完成 `ALTER TABLE … RENAME` 与列改名，Drizzle schema 同步改名，不在 Drizzle 层映射旧表名；
- 现有数据按新模型直接重建（提案第 3.3 节）：每个来源重建为一项资产，不保留原有版本历史，已有锚点随之作废；迁移后所有资产都不属于任何频道。

## 7. 对象存储布局

存储默认私有（Vercel Blob 全部以 `access: 'private'` 写入；S3 实现则要求 Bucket 私有），Object Key 不使用用户输入原文：

```text
sources/{workspaceHash}/{libraryId}/{operationId}/snapshot.*
normalized/{libraryId}/{versionId}/{documentId}.json
manifests/{libraryId}/{versionId}/documents.json
manifests/{libraryId}/{versionId}/vectors.json
exports/{workspaceHash}/{exportId}.csv
quarantine/{operationId}/{objectId}
uploads/{workspaceId}/{batchId}/{fileId}.pdf
uploads/platform/{batchId}/{fileId}.pdf
images/{libraryId}/{imageId}.*          # 文章图片（P3a）
audio/{libraryId}/{mediaId}.*           # 音频文件（P3b）
```

文章图片与音频文件是资产的一部分，大小计入工作空间容量；两者都只存私有 Bucket，付费资产的图片与音频只对订阅者按次签发短时效地址，不提供下载；图片不进检索，音频不转写，不送往任何第三方服务（requirement.md 8.1、12）。

`uploads/` 是 Dashboard 直传的 PDF：向导在创建资产前上传，或创建后在该资产的文件页上传，`source.config.files` 记录其 Key，构建时由 PDF 连接器读回；Key 以工作空间 id 开头，创建和改文件的请求都只能引用自己前缀下的对象。文件页的每次保存（`updateLibraryFiles`）改写 `source.config.files` 并排队一次 `refresh`：已有 pending 的构建则复用它（它尚未读取来源），正在 running 的则在其后再排一次。被移除文件的对象不立即删除——已发布版本的引用仍指向它——由上传清扫在无来源引用且超过 24 小时后回收。没有文件的上传文件资产不排队构建，`index_status` 停在 `pending`。平台的上传文件资产走同一套机制，只是由管理后台上传：Key 以固定的 `platform` 段代替工作空间 id（工作空间 id 是 UUID，永远不会与它重合），创建对话框直传后把清单交给 `createPlatformLibrary`，之后在详情页的「PDF 文件」面板增删（`updatePlatformLibraryFiles`，写审计 `platform_library.files`）；「添加来源」给已有平台库加 PDF 来源的做法随「一项资产一个来源」停用（现有多来源平台库在 P1 按来源拆开）。平台上传文件资产的刷新策略固定为手动；引用指向公开的 `/files/{fileId}`，该路由只放行已发布平台资产的文件；后台文件面板走 `/admin/files/{fileId}` 预览草稿（管理员 Cookie 只作用于 `/admin` 路径）。

- 下载通过短时签名 URL 或服务端流式代理；
- Object Metadata 不保存 Token、邮箱、Query 或私有标题；
- Quarantine 对普通应用不可读，只允许安全 Workflow/Reviewer；
- 上传完成前使用临时 Key，校验成功后再移动到 Source Snapshot；
- 使用存储侧原生生命周期规则清理失败任务临时对象和过期导出，不自建清理任务。

专家模块（§4.1）使用独立前缀，与上述布局互不重叠，隔离由应用层 Guard 按前缀执行：

```text
expert-verification/{expertHash}/{verificationId}/evidence.*
expert-projects/{projectId}/...
data-assets/{assetId}/{versionId}/...
media/{ownerType}/{ownerId}/{mediaAssetId}/...
data-exports/{buyerHash}/{exportId}/package.*
eval-runs/{buyerHash}/{runId}/...
quarantine/expert-data/{operationId}/{objectId}
```

`data-exports/` 的过期对象由 drain 收尾时的清理任务删除（与 `purge-uploads` 同一模式），因为 Blob 没有生命周期规则；`media/` 中扫描未通过的对象在拒收时即删除。

## 8. Ingestion 与发布

### 8.1 Workflow 状态机

```mermaid
stateDiagram-v2
    [*] --> Pending
    Pending --> Fetching
    Fetching --> Scanning
    Scanning --> Parsing
    Parsing --> Chunking
    Chunking --> Embedding
    Embedding --> Evaluating
    Evaluating --> Publishing
    Publishing --> Ready
    Fetching --> Failed
    Scanning --> Failed
    Parsing --> Failed
    Chunking --> Failed
    Embedding --> Failed
    Evaluating --> Failed
    Publishing --> Failed
```

### 8.2 幂等步骤

发布前的人工审核分支（AwaitingReview / ChangesRequested）随公开审核取消而删除：放进公开频道是所有者经确认门的动作，不等待审核；安全扫描照常执行；下架与恢复在频道层面由管理后台处理（requirement.md 7.4）。**阶段**：现有实现的用户资产仍带这条分支，随 P1 删除。

每一步由 Vercel Workflows 的持久化 Step 包装，并在 Postgres 写入状态：

Website 来源通过 `source.config.indexDepth` 选择嵌套深度（0–3 层，默认 0），每层跟进同域、仍在入口路径范围内的子页面，sitemap 发现页算第 1 层。

1. `validate-source`：套餐、容量、URL、授权和配置 Schema；
2. `fetch-snapshot`：抓取后计算 Source Digest 并写对象存储。网站来源先直接抓取（浏览器样 UA、`Accept: text/markdown` 协商、sitemap 发现），只有被拒（403）或页面是 JS 空壳时才调用远程渲染服务（Firecrawl、AnySearch 或 Jina Reader，在后台「模型配置」页选择，可替换）取 Markdown。渲染配置只追加（`render_config`，最新一条生效；从未保存时沿用 `RENDER_PROVIDER*` 环境变量），每家服务各有一个有序的 API Key 池（`render_provider_key`，加密存储）：构建按顺序使用，厂商返回 402（额度用完）或 401（Key 无效，AnySearch 另含 403）时换下一个 Key 并标记，被标记的 Key 6 小时内排到最后但放弃前仍会再试，首次成功即清除标记；429 只在本次构建内跳过。Firecrawl 的 403 是不支持该网站，不算 Key 失效。已存的 Key 只发往厂商官方地址，配置了自托管地址时不带 Key 调用；渲染目标同样经过 §15.1 的地址校验，渲染结果同样受单文档大小上限约束。未配置渲染服务时入口页为空壳以 `source_unrendered` 失败，这个独立错误码让后台能统计需要渲染的来源比例。摘要未变的来源不再解析和向量化，其文档与 Chunk（含向量）从当前版本复制到新版本；解析器、分块器、Embedding 模型或分词配置任一变化时不复用，整项资产重建。**一项资产只有一个来源**（requirement.md 6.1），用户资产与平台资产都是；`library_version.source_digests` 的多来源记法与「按来源部分刷新」只在现有多来源平台库上还有意义，这些库在 P1 按来源拆成多项资产后不再需要。`llms.txt` 与 OpenAPI 来源已删除。编辑器来源（`editor`，P3a）的正文由平台内编辑器或网址 / RSS 导入产生，不抓取、不渲染，直接进入 `scan`；音频来源（`audio`，P3b）只校验文件类型、大小与哈希，进入检索的是创作者写的标题与节目说明，不做语音识别。PDF 来源从对象存储读回向导上传的文件（单文件 30 MB 以内），用 pdf.js（unpdf）就地抽取文本层；只有当至多一半页面有文本层时（扫描件）才把整个文件交给 OCR 服务（`OCR_PROVIDER`，目前为 ocr.space，可替换）识别，未配置 OCR 时扫描件解析为空文档，由 `discover-parse` 报 `parse_failed`。文件以 multipart 直接上传给 OCR 厂商，不签发对象存储的临时 URL；页数与大小上限由厂商套餐决定，超出时厂商的拒绝原样以 `parse_failed` 上报；
3. `scan`：恶意文件、Secrets、PII、Prompt Injection 和链接安全；
4. `discover-parse`：只解析允许的文件和页面；
5. `normalize-cite`：产生统一文档格式和 Citation；
6. `chunk`：稳定 Chunk ID、Token 计数和去重；
7. `embed-index`：全文索引与 pgvector，与 Chunk 同事务写入；
8. `profile`：从 Version 内容生成资产画像——文档标题与目录集、关键实体与同义词表、chunk 向量聚类质心、自动描述与主题标签，写入 `library_profile`；资产所在频道的画像（`channel.profile`）由频道内公开资产的画像聚合后更新（§9.6，P1）。画像是「平台从内容起的真名」，频道级发现只信画像，不依赖用户命名与填表自觉；
9. `evaluate`：Trust 与 Benchmark 结构分（文档数、Chunk 数、引用完整性、重复率）；检索 Golden Set 随自检问题删除；
10. `review`：已取消。版本发布事务只移动版本指针；资产的 `lifecycle_status` 由 `advanceLifecycleAfterBuild` 推进为 `published`，`suspended` 不动。**阶段**：现有实现中公开用户资产的 `submit` / `resubmit` / `reviewUserLibrary` 路径随 P1 删除；
11. `publish`：原子切换发布指针。

Step 输出只保存可序列化摘要；大对象保存在对象存储。外部 Provider 调用保存 Input Digest 和 Provider Request ID，重试时优先查询已有结果。

### 8.3 发布事务

发布前，Version 的文档、Chunk、全文索引和向量必须完整。单个 Postgres 事务执行：

1. 验证 Version 属于 Library 且状态可发布；
2. 把 Version 标记为 Ready/Published；
3. 更新 `library.current_version_id`；
4. 标记上一个 Version 为 Superseded；
5. 追加 Publication Event。

任何一步失败时整个事务回滚。查询在开始时读取并固定 `current_version_id`，因此不会混合新旧 Chunk。

因为全文索引和向量是 `chunk` 上的列，它们与发布指针处在同一事务边界内，不存在「索引已写、指针未切」或「指针已切、向量缺失」的中间态。跨系统需要保序的只剩对象存储：对象必须先于事务提交完成写入，未被任何已发布 Version 引用的对象由生命周期规则和 Recovery 清理。

### 8.4 刷新与删除

- 公开查询只负责尝试创建 Refresh Operation，不等待执行；
- Source Digest 未变化时更新 `last_checked_at` 并结束；
- 平台资产按 Source 的 `refresh_policy`（`daily` / `weekly` / `manual`）自动刷新：`/api/cron/drain` 每次先调用 `scheduleDueRefreshes`（`lib/application/ingestion/schedule-refreshes.ts`），为每个到期且没有未完成 Operation 覆盖的 Source 排一条 `trigger = scheduled` 的 Refresh Operation，再执行 drain。某个 Source 的「最近检查时间」取该资产 `last_checked_at` 与覆盖它的最近一条已结束 Operation 的较晚者；从未检查过的定时 Source 视为立即到期。一项资产只有一个 Source，因此每次刷新就是整项资产的 Operation（现有多来源平台库拆开前仍按 Source 分别排队）；
- `workflow_operation.trigger` 记录 Operation 由谁发起（`manual`：管理员或工作空间操作；`scheduled`：定时任务），定时排队不写审计日志；
- 管理后台 `/admin/refresh-queue` 展示跨资产的队列：执行中与等待中的 Operation、最近完成的 Operation 及其结果与抓取方式、每个平台 Source 的策略/最近检查/下次刷新；有未完成 Operation 时页面每几秒自动重新渲染；
- 不属于频道的资产默认手动刷新，Webhook 必须验签和去重；Agent 工作台的 `refresh_asset` 与 A2A `refresh` 经确认门后走同一条路径；
- 删除首先在 Postgres 把资产设为不可访问并撤销发布指针：一个事务写入 `deleted_at` 墓碑、`lifecycle_status = archived`、`index_status = deleting`、`current_version_id = null`，删除 Alias 与 Source，把排队中的 Operation 置为 `cancelled`，并排队一条 Delete Operation（`lib/application/libraries/delete.ts`）；
- `library` 行本身不删：`usage_event`、`channel_asset`、`comment` 引用它，计费事实是只追加的。删除时同时从所属频道移出。所有面向用户、后台、目录与路由的读取都过滤 `deleted_at is null`；`library_public_id_uq` 是仅覆盖存活行的部分唯一索引，因此资产 ID 在删除时即释放；
- Delete Workflow 再删除 Chunk 行（连带全文与向量列）、Document、Profile、对象存储对象和缓存（`lib/application/ingestion/purge-library.ts`，与构建共用 `runOperation` 队列）；Version 行作为元数据保留；
- 清理失败持续重试并报警，不得恢复查询权限：Delete Operation 失败时回到 `pending` 且不受构建的重试上限约束；`buildVersion` 与 `publishVersion` 都拒绝墓碑，删除时仍在运行的构建无法把指针放回去；
- 平台资产由管理后台删除并记入审计（`platform_library.delete`），用户资产由工作空间 Owner/Admin 在 Dashboard 删除（删除不进入 Agent 的工具集合）；两者走同一机制。

### 8.5 存证旁路

链上存证挂在发布之后，完整设计见 [aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md)，此处只写架构约束：

- 存证**不进入 §8.3 的发布事务**，也不进入 §9 的查询链路；把该模块整体移除后系统行为不变。它有自己的 Cron 入口 `/api/cron/anchor`，不搭在 §8.4 的队列 drain 上——删掉那个目录与 `vercel.json` 里的一行即可移除整套调度，共享路径一处不改；
- Anchor Workflow 由 Cron 触发，通过既有 Publication Event、审计链头和已关账 `revenue_period` 反查生成 Leaf，发布事务和结算事务都不做任何改动；
- 三类 Subject（`version`、`audit_head`、`earning_statement`）共用同一套 Workflow、批次与 Proof 结构，不为结算单新增并行表；`earning_statement` 改为创作者的频道收入结算单（P3a 之前没有新的结算单可锚）；现有知识库按来源重建为资产时旧版本的锚点作废，Verifier 对不再存在的版本 ID 返回「版本不存在」；
- 链上模块在 `move/re0_anchor`，一个 entry function 和一条 Event，无资金、无用户资产、无状态；它以 `immutable` 发布，一经上链不可变更，因此校验方要读的字段必须一次到位，缺陷只能靠发布新对象修复，见 [move/README.md](./move/README.md)；
- Anchor Signer 的私钥由环境变量持有，只允许 `lib/infrastructure/chain` 的 Signer Adapter 读取；业务代码不得直接引用它，也不得引用链 SDK；密钥不进日志、Trace 与告警内容，见 §17.1；
- 链或节点不可用时批次停留在 `pending` 并重试告警，发布、刷新、检索、计量、审核和出账全部不受影响；
- Context 与 Search 响应默认不返回 Anchor 字段，避免影响 `maxTokens` 裁剪与响应体积；存证信息走独立的 Anchor 查询接口；
- 存证在管理后台没有界面；任何读取锚定的查询停在 leaf 哈希，**不读原像**，见 §14；
- 链上读数走 `APTOS_INDEXER_*` 一套凭据，与写入路径分开，避免供应商故障同时打掉锚定与读回（提案 §4.9）；读取不可达是一种要处置的状态，不是空数据；
- **存证没有自己的开关**：是否对外表述存证，由 `APTOS_ANCHOR_OBJECT_ADDRESS` 与 `APTOS_ANCHOR_SIGNER_KEY` 是否配置推导。把这几项从某个环境移除，该环境就不再有任何存证痕迹——这是 §8.5「移除后系统行为不变」在配置层的对应物；
- 公开 Verifier 作为独立包发布，**不允许 import 任何服务端 `lib/` 代码**，以保证「校验不依赖 re0」这一验收标准成立；
- 存证不产生 Usage Event，不进入 §11 的额度链路。

## 9. 混合检索

### 9.1 向量布局

向量是 `chunk` 表上的 `embedding` 列，不存在独立的向量存储和 Vector ID 映射。租户与版本隔离由同表的 `library_id`、`version_id`、`workspace_id` 列承担，通过 SQL 谓词过滤，不需要额外的 Metadata Index 概念；可见性（资产所在频道、`access`、订阅）在固定资产集合时由 Policy Engine 判定，不作为 chunk 列。

**索引按查询形状分层，「一张表」不等于「一个全局向量索引」：**

- **资产内向量召回默认精确扫描，不依赖 ANN 索引**：查询已固定 Version，候选行数以单版本为界（通常数百到数千），按 `(library_id, version_id)` 索引捞行后精确计算余弦距离——零召回损失，且不受平台总资产数影响；问频道时过滤条件从一项资产放宽为一组 `(library_id, version_id)`，一次查询覆盖频道内调用者有权看到的全部资产，而不是逐项查询再合并（提案第 3.7 节）；
- **不建全局 chunk 级 HNSW**。十万资产、上亿 chunk 量级下它三重失效：图上近邻大概率不属于目标资产，过滤后召回崩坏；索引体积远超可用内存，遍历退化为随机 IO；每次 ingestion 批量写入都在维护全局图，放大发布事务成本。当前 Schema 中的全局 HNSW 属于该结论前的遗留，应移除；
- **全局关键词能力由 `chunk` 上的 GIN 倒排承担**：倒排查询成本与词频成正比，不与表大小成正比；罕见词（恰恰是需要段落级定位的词）在亿级行上依旧廉价。该索引服务 §9.6 的路由层，不服务资产内召回；
- **全局语义能力由画像向量层的小型 HNSW 承担**（行数 = 频道数 × 质心数），见 §9.6；
- 超大单项资产（单版本行数超出精确扫描的延迟预算）按资产单独评估局部索引或表分区，不以此为由回退到全局索引；
- 查询必须至少过滤 `library_id + version_id`（问频道时为一组）；不属于频道的资产额外过滤 `workspace_id`；
- 过滤条件由 Repository 层强制拼装，不允许调用方传入裸 SQL 或跳过隔离列；
- 正文、Citation 与相似度在同一次查询中取得，不需要「先拿 ID 再回查」的二次往返；
- `quarantined`、`unsafe`、版本不匹配的行在同一 WHERE 子句中排除。

Embedding 维度、距离度量和索引参数版本化，随 `retrievalConfigVersion` 一起参与缓存键。更换 Embedding 模型必须走新 Version 重建，不得在原地覆盖列。

**向量是存储成本的最大项，压缩是第一杠杆**：半精度（halfvec）与 Matryoshka 降维（512/256 维）在「资产内小候选集精确排序 + FTS 融合 + Rerank 兜底」的链路下精度损失可接受，合计可把向量体积压到 fp32/1536 维的约六分之一。压缩参数属于 `retrievalConfigVersion`，变更走新 Version 重建。冷资产 `embedding` 置空与重算见 §6.4。

### 9.2 查询链路

```text
authenticate caller
  -> load workspace, plan and scopes
  -> load and pin policy version
  -> resolve asset or channel and enforce policy
  -> authorize visibility (channel, access, ownership or subscription)
  -> pin one ready version per asset in scope
  -> reserve one call idempotently (caller pays; anonymous: platform, rate limited)
  -> build query embedding
  -> postgres fulltext recall within asset set + versions
  -> pgvector exact recall with the same sql filters
  -> reciprocal-rank fusion
  -> rerank, deduplicate and safety filter
  -> trim to maxTokens
  -> citations already loaded with the rows
  -> finalize usage event
  -> return canonical JSON or derived TXT
```

### 9.3 召回与融合

- 全文与向量召回各自限制候选数，不能全库扫描；
- 全文查询条件必须包含 `library_id` 和 `version_id`（问频道时为固定下来的一组）；
- 向量召回的 SQL 过滤必须包含同一标识；
- 两路召回可以合并为单条 SQL，但融合参数与候选上限仍按下列规则版本化；
- Reciprocal Rank Fusion 参数版本化；
- Rerank 只处理融合后的有限候选；
- **候选上限、RRF 常数、Rerank 窗口与输入长度、公共缓存 TTL、在线试用的片段预算、选频道与资产的召回与采样上限是管理后台的「召回管理」配置**（`retrieval_config`，追加式版本行，最新一行生效，取值范围由 `lib/domain/retrieval-config.ts` 约束）。每次检索按请求读取最新一行，保存即对下一次请求生效；未保存过时使用代码默认值，即改造前的常量；
- 近重复 Chunk 按内容 Hash、来源段落和版本去重；
- `quarantined`、`unsafe`、低分或 Citation 缺失 Chunk 不返回；
- `maxTokens` 在格式化前严格裁剪，代码块不得被无提示截断。

### 9.4 缓存

只缓存不可变版本的检索结果。Cache Key 包含：

```text
libraryVersion + policyVersion + queryHash + maxTokens + responseType + retrievalConfigVersion + retrievalConfigRowId
```

`retrievalConfigVersion` 是代码行为的版本，`retrievalConfigRowId` 是后台「召回管理」生效行的 id：改参数不需要清缓存，旧 Key 自然不再被命中。TTL 也来自同一配置，填 0 即关闭公共缓存。

缓存承载在 Upstash Redis，Key 按 Workspace 前缀分区。

缓存命中仍执行身份、Policy、资产与频道状态、可见性和额度检查；`paid` 资产的结果不得被非订阅者命中。私有响应不能进入公共 CDN Cache；服务端私有缓存必须按 Workspace 分区并加密。资产暂停、频道下架、Policy 更新或删除时通过版本变化自然失效，安全暂停与下架还必须主动撤销相关 Cache Tag，实现方式是维护 `tag -> key set` 并批量删除。

缓存不可用时直接穿透回源，不影响正确性，只影响 p95；不得因缓存故障拒绝请求。

### 9.5 生成链路

调用 LLM 生成答案的入口限于四个：在线试用、Agent 工作台、频道 AI 分身和 A2A `ask`，**共用同一条生成链路**（同一个检索函数、逐句闸门、引用绑定校验、降级为 Chunk 列表），产品规则见 [requirement.md](./requirement.md) 第 5.1 节；REST 与 A2A `find_channels` / `search_context` 不调用模型。在线试用（`/playground`）与工作台共用同一个 Agent 循环，区别只在工具集合（公开演示只读、只查公开频道里的免费资产；工作台另有资产与频道操作工具与确认门，§13.1）。**阶段**：工作台与 A2A `ask` 已在 P2 实施（`lib/application/playground/agent.ts` 的 `workbench` 输入、`lib/application/agent/ask.ts`），分身在 P1。工作台只要模型声明了工具调用就启用规划，不受在线试用的 Agent 开关影响；一轮最多 3 项待确认操作、2 次列表；只列表或只提议、没有确认过的证据时以 `acted` 结束，不调用作答模型。A2A `ask` 不走规划：直接用 `search_context` 的同一个范围检索（`searchScope`，`meter: false`），再交给 `answerFromContext`。架构约束：

```text
（Agent 模式）规划：模型只能调用工具——检索工具（搜频道 / 查资产，同一检索函数）、answer，以及工作台里的资产与频道操作工具（有副作用的生成待确认操作，不直接执行）
  -> 每次检索过与 scatter-gather 相同的确认门，只有确认过的结果进入证据池
  -> 步数、调用次数、总时长有上限；规划失败且证据池为空时退回下面的固定流程
（固定流程）路由到频道 + 频道内 scatter-gather；追问路由不到时沿用上一轮的范围
调用 §9.2 的同一个检索函数取得 Chunk 与 Citation
  -> 零结果：直接返回 no_relevant_context，不调用模型
  -> 构造 Prompt：系统提示 + Chunk（标注为不可信数据）+ 用户问题
  -> 调用 LLM Provider（流式），带硬性 Token 预算；超时是「无输出」超时（等首个 Token、等下一个 Token），总时长另有硬上限
  -> 逐句闸门：一句话的标记全部到齐、且证明不会再追加标记后才出闸
  -> 引用绑定校验：每条事实性陈述必须映射到本次返回的 chunk_id
  -> 未绑定的段落丢弃或降级为非事实展示
  -> 追加一个 Usage Event（在线试用、工作台、分身 1 Call 计提问者；A2A ask 10 Calls 计调用方工作空间，每天最多 500 个答案；ask 降级为 Chunk 列表时按 search_context 计 1 Call）
```

- 生成层**只包裹**检索结果，不得自行访问 Postgres、对象存储或缓存，也不得改写 Chunk 正文；
- 生成是流式的，但**模型正文不直接过给前端**：服务端按句缓冲、绑定成功才下发，所以「未绑定内容不得作为事实展示」在传输层就已成立，前端没有可以渲染未绑定正文的通道；历史只进入规划（Agent 模式的规划模型，或固定流程中落空后的改写调用），不进入作答：作答调用看到的只有本轮证据、原问题和标注为「仅供理解问题」的改写问题——历史正是第 4 条排除的外部知识。规划模型写的任何文本都不下发；一问仍只计一次（首次读取预留座位，其余读取不计量），提交给证据池第一位的资产（[playground-agent-proposal.md](./playground-agent-proposal.md)）；资产与频道操作的结果由服务端模板生成，不经过模型；
- `llm_config` 按 `slug` 分链存放多个可选模型：一条 slug 的最新一行是该模型当前的配置，其中一个模型标记为默认。**选用哪个模型只由控制台决定**，请求体没有模型字段，访客不能替平台挑更贵的模型；
- 每个模型带上下文窗口（`max_input_tokens`）、输入/输出/缓存三档单价，以及工具调用、推理、图片识别三项能力声明；**检索预算由上下文窗口推算**，不再是所有模型共用一个常量，但上限默认 6k Token（`playgroundTokensMax`，控制台可调）——窗口说明模型能装多少，不说明一个问题需要多少；128k 窗口推出的 64k 预算等于没有预算，Prompt 大小只由召回上限决定，这个上限让预算重新成为约束。推理模型可设推理强度，非推理模型带强度会被拒绝而不是静默丢弃；
- 成本口径：`prompt_tokens` 仍是供应商口径的全部输入（含缓存命中），其中 `cached_tokens` 按缓存单价计、其余按输入单价计，两者不重复计费；`reasoning_tokens` 是 `completion_tokens` 的构成部分，只记录不另计价；
- REST、A2A `search_context` 与四个生成入口共用同一个检索函数，Contract Test 对「它们对同一请求返回相同 Version 与 Citation」有断言；
- 检索阶段的 Usage、Policy 与额度逻辑完全复用 §10 与 §11，生成阶段不再做第二次计量；
- LLM Provider Key 随条目保存在 `llm_config`，密封至静态（§9.7、§15.3），只在服务端 Route Handler 与 Workflow 中解开，不回显给后台、不进入前端 Bundle；Provider 通过 `lib/providers` 的 Adapter 隔离，类型不得泄漏到 Domain 或 SDK；
- 模型调用失败或超时时降级为直接返回 Chunk 列表，不返回错误页，也不重试到超过预算；
- 生成结果与 Query 正文适用同一保密要求，不写产品日志与 Analytics；模型 Token 只进成本指标；
- **REST 与 A2A `find_channels` / `search_context` 不得引入 LLM 依赖**：移除生成层后，它们的行为必须完全不变；
- 分身的界面始终标明「AI 分身，依据频道内容作答」，不冒充创作者本人；A2A `ask` 的 Artifact 带 `text` 与 `data` 两个 Part，`data` 里每条 Citation 附版本锚点（§13.1）。

### 9.6 频道级发现与跨频道路由

用户从自然语言问题出发时（「影翅虫的防治与危害」），目标可能在一个叫「昆虫大全」或「医药宝典」的频道里——**线索在内容里，不在名字里**。UGC 平台上名字与内容不相关是常态而非例外，因此名字驱动的 resolve 只能作为辅助路径，发现必须基于内容。线索还可能只存在于某个章节段落（既不在文档标题也不在任何摘要里），所以设计必须覆盖到段落粒度。

**画像上移到频道**（提案第 3.7 节，P1）：资产打散后单项资产太小，跨频道发现在频道层做。`library_profile` 继续按资产生成（§8.2 `profile` 步），频道画像 `channel.profile` 由频道内公开资产的标题、实体与质心聚合而来；平台级提问先路由到频道，再在频道内检索；不属于频道或私有频道里的资产不进任何画像索引。

三层结构，画像负责把几万个频道缩到十几个候选，真实命中负责正确性：

**1. 画像层**（随发布派生）。每个频道三种内容表示：文档标题与目录集（最廉价有效的路由信号）；关键实体与同义词表（覆盖「影翅虫/隐翅虫」这类俗名与变体，纯库名匹配永远做不到）——词表按「本库词频 × 平台特异性」排序：先剥掉站点固定短语和地址（URL、邮箱、裸域名及路径，否则 emoji 图片地址会把 `https`/`svg`/`cdnjs` 顶到前排），再以其他频道当前画像的词表算平滑 IDF（`platformSpecificity`），人人都有的词被压低但不剔除，频道少时权重接近 1；chunk 向量聚类质心（每个频道 8–32 条代表向量——百科型大频道的不同主题簇各自有代表，避免被单条摘要向量稀释）。

**2. 路由层**（查询时三路融合，取 top 10–20 候选频道）：

- 画像 FTS：查询打文档标题集与实体表；
- 画像向量：查询 Embedding 对质心表做 ANN（§9.1 的画像层小型 HNSW），语义兜底换说法、错别字；
- 罕见词全局倒排：查询分词后，仅**低频高信息量词**打 `chunk` 表的 GIN 索引并按资产聚合到频道——段落级线索用段落级倒排接住，零遗漏；高频词不走此路（posting list 过长，且画像层已覆盖）。词频判定依赖 ingestion 侧累计的全局词频表。可选「实体 → 频道」物化倒排表作第一跳，miss 再落全局 GIN。

`domain_tag` 参与加权，不做硬过滤——「影翅虫皮炎的治疗」确实可能在医学频道里。

**3. 确认层**（scatter-gather）：对候选频道并行执行 §9.2 的频道内召回（一组资产一次查询），以真实 chunk 命中分数做最终裁决或直接融合返回。负担得起的前提正是 §9.1 的资产内精确扫描——并行十几个频道，每个频道只扫几千到几万行。

硬约束：

- **Policy 与可见性先于路由**：§10.2「Library Search 在元数据阶段应用 Policy」同样适用于画像检索；不属于频道、私有频道里的资产的画像与 chunk 不得出现在任何全局召回结果中，`paid` 资产对非订阅者只露标题与摘要，§5.2「不可见资产与不存在资产同 404 外观」延伸到路由层；
- **排序防对抗**：路由一旦基于内容，往频道里堆砌热门实体就是对路由做 SEO。候选排序必须融合 Trust/Benchmark 分数与安全状态，且 §11.4「检索链路不得读取收益字段」同样覆盖路由排序与频道目录排序；
- **候选必须附带命中证据**（命中的文档标题/实体、少量段落摘录）：名字不可信之后，证据是调用方一轮定案的依据，证据薄导致的错选与重试比省下的往返更贵，见 §12.1；
- **多入口共用同一实现**：REST 走调用方显式两轮（Library Search → 定案 → Context）；A2A `search_context` 与 `find_channels` 在服务端完成路由与检索，调用方不需要两轮；Web 问答与 A2A `ask` 走服务端自动 scatter-gather。几者只在「谁做最终裁决」上不同——交给调用方模型，或交给服务端命中分数。Web 的 Agent 模式（§9.5）让模型决定查什么、查哪个范围，但哪些结果算证据仍由服务端确认门裁决；
- **中文分词是前置依赖**：`search_config` 目前没有中文路径，中文内容落到 `simple` 不分词，画像 FTS、全局倒排乃至资产内 FTS 对中文整体失效。该缺口（§22 待验证事项）已解决，见 §22。

### 9.7 模型配置

四类模型——向量、重排、试用生成、生成（工作台、分身与 A2A `ask` 的指派角色）——都是后台配置，不是部署配置。端点、模型名、凭据、超时统一保存在数据库，后台 `/admin/models` 一处管理：

- **向量与重排各有一条生效配置**（`provider_model_config`，按 kind 追加，最新一行生效）。两者都可以停用，停用是有记录的降级而非故障：没有向量模型时检索只走关键词一路，没有重排时融合顺序即最终顺序；
- **生成模型是注册表加指派**（`llm_config` + `llm_audience_assignment`，见 §9.5）。"试用模型"等是指派出来的角色，不是条目自身的属性；
- **凭据随条目保存并密封**（§15.3）。后台只显示"是否已配置"，不回显密钥；编辑时留空即沿用已存的那一把，所以改一个超时不需要重新粘贴供应商密钥；
- **向量维度是配置项，不是常量**。列宽固定为 1536，更窄的模型零填充进去——零维对点积和模长都无贡献，余弦距离因此完全不变，这是列宽可以固定而模型维度可以配置的全部理由。想用超过 1536 维的模型需要一次迁移改列宽，不是一次保存；
- **维度与模型名一起冻结在 `library_version` 上**。同一个模型在不同维度下产出的向量属于不同空间，检索时两者都要对得上才走向量一路，否则该版本退回关键词一路，直到它各自重建一次。

## 10. Policy Engine

### 10.1 Policy Schema

```ts
type WorkspacePolicy = {
  sourceTypes: Record<SourceType, { enabled: boolean }>;
  libraryFilters: {
    mode: "quality" | "select" | null;
    quality: {
      requireVerified: boolean;
      minTrustScore: number | null;
      maxAgeDays: number | null;
      blockedLibraries: string[];
      exceptedLibraries: string[];
      repoFilters: {
        minStars: number | null;
        allowedLicenses: string[];
      };
      websiteFilters: {
        minBacklinks: number | null;
        minReferringDomains: number | null;
        minOrganicTraffic: number | null;
      };
    };
    select: { allowedLibraries: string[] };
  };
};
```

`blockedLibraries`、`exceptedLibraries`、`allowedLibraries` 的条目可以是资产 ID、组织、域名，也可以是频道 ID `/channels/{slug}`，频道 ID 覆盖频道里的全部资产（requirement.md 第 10 节，P1）；`sourceTypes` 的键随来源类型调整（删除 `llms_txt`、`openapi`，新增 `editor`、`audio`）。字段名在 P5 随接口改名。

`PATCH /v1/policies` 使用增量语义：来源类型用 `enable/disable`，名单用 `add/remove/clear`。服务端生成完整、不可变的新 Policy Version，并返回 `accessibleLibraryCount`。

### 10.2 执行位置

- Library Search 在 Postgres 元数据查询阶段应用 Policy；
- Context Retrieval 在生成 Embedding 前完成 Policy 和可见性检查；可见性按 requirement.md 6.2：资产所在频道的可见性、`access`、调用者是否为所有者或订阅者，在固定可访问资产与版本时判定，先于召回；
- A2A、REST 和 Web 都调用相同 Policy Evaluator；
- Policy Evaluator 返回稳定 Reason Code，调用记录只保存 Reason Code；
- “始终允许”只绕过质量阈值；阻止名单和来源类型开关优先，且不能覆盖可见性（不属于频道、私有频道、`paid` 资产的订阅要求）、频道下架、安全暂停、账户停用或来源凭证撤销。

## 11. Usage、额度与订阅

### 11.1 Call Reservation

`usage_reservation` 状态为 `pending | committed | released`。在开始检索前使用单个 Postgres 事务完成：

- 根据 Workspace 当前周期统计未释放 Reservation 与最终 Usage Event；
- 检查 Plan Version 基础额度和 Add-on Grant 余额；
- 以唯一 `request_id` 插入 `pending` Reservation；
- 超额或重复时不产生第二个 Reservation。

扣减顺序固定为**先每月免费额度、后 Add-on 余额**，并在同一事务内记录本次扣减来源，使账单展示和争议复核不依赖事后推断。免费额度按账期重置；`addon_grant` 余额跨账期结转且无到期时间，因此额度判定不能用「当前账期内是否有有效 Grant」这类基于时间窗的条件，只能读余额。Additional Calls 对任何用户开放购买；首次购买把 `user.storage_tier` 升到 `extended`。

**谁付 Call**（requirement.md 4.2）：预留落在**发起方**的工作空间——REST 与 A2A 计调用方，分身提问计提问者；频道所有者不为访客付。匿名请求（公开频道里免费资产的阅读、REST 开放子集、匿名 A2A `search_context`）不预留、不产生 Usage Event，由平台承担并走 §11.2 的匿名限流。A2A `ask` 一次预留 10 Calls，另按工作空间维护每日答案计数（上限 500，控制台可调），两者都在同一事务内判定（`lib/application/plans/weighted-call.ts`）：每日计数 = 当天（UTC）`operation = 'ask'` 的 Usage Event 数 + 请求 ID 以 `ask:` 开头的 `pending` Reservation 数；有答案时按 10 Calls 提交一个 `ask` 事件，降级为 Chunk 列表时按 1 Call 提交 `search_context` 事件（不计入每日答案），零结果释放预留。多 Call 的提交与构建一样先扣每月免费额度、溢出部分扣 Add-on 余额（`debit_source = split`）。

禁止使用“先 SELECT 剩余额度，再普通 INSERT”的竞态实现，正确性由 `request_id` 唯一约束和事务内条件写入保证。正常有结果或无结果时，同一事务追加唯一的最终 Usage Event，并把 Reservation 标记为 `committed`；平台内部错误只把 Reservation 标记为 `released`，不产生 Usage Event。超时的 `pending` Reservation 由 Recovery 根据请求终态提交或释放。最终 Usage Event 不再修改或删除。聚合任务从 Usage Event 重建 `usage_summary`，Dashboard 不直接信任浏览器计数。

**额度计数不得迁移到 Redis 或任何缓存层。** Reservation 与 Usage Event 是计费事实，必须与业务库同事务；把计数放到缓存会在收费路径上引入一致性缺口，换取的延迟收益不成比例。§20 把 Usage 条件写入列为演进信号，届时的解法是分区或物化，不是外置计数器。

### 11.2 匿名限流

匿名访问（公开频道里免费资产的阅读与收听、REST 开放子集、匿名 A2A `find_channels` / `search_context`）使用短周期限流，承载在 Upstash Redis，键由经过加密/哈希的 IP 与设备信号组成；频道目录「热门」排序对匿名读者的去重也用这把键。不得把明文 IP 写进产品日志。匿名限流是防滥用能力，不与月度额度混合；它是「匿名由平台承担」的兜底，与 requirement.md 第 6.10 节「频道检索不设默认上限」配套。

- 使用滑动窗口算法，并启用实例内存中的封禁缓存：封禁期内的重复请求在函数本地直接拒绝，不再发起网络调用，使刷量成本落在攻击方而非平台账单；
- 限流服务不可用时 **Fail Closed**，拒绝匿名检索。依据与 §11.3 支付状态不确定时的处理一致：匿名访问是非核心能力，宁可暂时关闭也不能敞开被刷；
- 已认证用户的额度检查不走该路径，见 §11.1。

### 11.3 Payment Webhook

Webhook 处理顺序：

1. 读取原始 Body 并验签；
2. 按 `(provider, external_event_id)` 幂等写入；
3. 将 Provider 状态映射到内部 Subscription；
4. 关联不可变 Plan Version；
5. 记录处理结果，不直接改写历史 Usage。

支付状态不确定时，新增付费能力 Fail Closed；已支付周期读取按配置的 Grace Policy 处理。退款、发票和银行卡信息保留在 Provider，re0 只保存外部 ID、状态、金额和币种。

Payment Provider 为 **Paddle Billing**（`lib/infrastructure/payment/paddle.ts`，`PADDLE_*` 环境变量，见 `.env.example`）。三条实现约束：

- **价格来自不可变版本。** 结账由服务端创建交易，使用挂在 Additional Calls 这个 Paddle 商品下的非目录价格，金额取当时最新的 Plan Version；Paddle 目录里不保存我方价格。Pro 商品随 Pro 套餐删除（`PADDLE_PRO_PRODUCT_ID` 不再需要）。频道订阅（P3a）是另一个 Paddle 商品，价格取自频道方案版本 `channel_plan_version`，re0 用自己的 Paddle 账户作为记录商户销售创作者的内容；订阅续费沿用开通时的价格，与「方案修改只影响新订阅」一致；
- **频道订阅的事件**（P3a）：`transaction.completed` 为频道所有者记一条 `earning_event`（小计的 80%）并开通订阅者的 `channel_subscription`；续费延长 `current_period_end`；退款与拒付的 adjustment 冲回对应收入并按规则收回访问权（退款立即，退订到期末）；订阅到期后下一次调用即被拒；首次订阅把 `user.storage_tier` 升到 `extended`；
- **Webhook 只是通知。** 交易与 adjustment（退款、拒付）事件到达后，回读该交易及其全部 adjustment 的当前状态，整体写入 `billing_document`，不累加单个事件的增量；订阅事件自带完整实体，直接使用。三者都受 `observed_at` 守卫；
- **归属来自自定义数据。** 每笔结账交易带 `re0_workspace_id`、`re0_plan_version_id`、`re0_kind`，由服务端写入，只从验签后的通知或已认证的 API 读回。未打标的续费交易经其 `subscription_id` 归属；
- **生效套餐只有一个定义**（`lib/application/plans/in-force.ts`）：Pro 取消后每个工作空间只有注册时写入的免费行；Provider 计费行的宽限逻辑保留给频道订阅（账期结束后 1 天宽限等待续费 Webhook，`past_due` 不享受宽限）；
- **结账防重**：`payment_checkout` 记录本服务开出的结账。同一用户对同一频道的订阅结账在 advisory lock 下决定：仍可支付的旧结账直接复用；已付款但 Webhook 未到的返回 `pending`；`active`、`trialing`、`past_due`、`paused` 的订阅都拒绝再开一单。

这份「只保存」的投影落在 `billing_document`，按 `(provider, external_id)` 一行一单，随状态原地改写，供管理后台的订阅账单页查询（§5.3 的只读同步）。它与 `payment_event` 是两把不同的幂等钥匙，不能合并：`(provider, external_event_id)` 让重投的 Webhook 变成空操作，`(provider, external_id)` 让同一张单据保持一行而不是一次通知一行。两者必须同事务写入——事件写了而投影没写，重试会因为事件已处理而直接跳过，这次状态就永久丢失。Webhook 不保证顺序，因此投影另存 Provider 侧的状态时间，只有更新的事件才允许覆盖已有行：一条迟到的 `paid` 覆盖掉已退款的单据，会让后台报出平台并没有的收入。支付方式只记录类别（`card`、`alipay`），不记录任何卡片实例，卡号与后四位都不进入本侧存储。

### 11.4 频道收入记账

发布者分成已取消（[publisher-revenue-share.md](./publisher-revenue-share.md) 废止）；`lib/application/revenue`、`/v1/revenue*` 之外的结算与出账流程保留，改为结算创作者的频道订阅收入（requirement.md 4.4，提案第 6.9 节；P3a 落地）。架构约束：

- `earning_event` 与频道订阅的支付事件**同事务写入**：`transaction.completed` 入库时记收入（小计的 80%，`share_bps` = 8000），退款与拒付的 adjustment 入库时记负数冲回；理由与 §11.1 一致——收入是计费事实，不能靠异步补写，否则重放与漏写会直接变成付错钱；
- `earning_event` 只追加，携带当时的 `channel_plan_version_id` 与 `fee_rate_bps`（2000），历史账期按当时值结算，改费率只影响新订阅；
- 收入归属频道所有者的工作空间；按检索次数计算收益的部分（可计分成 Call、分成池、`share_rate`、日上限、专家与订阅资格判断）删除，不再有 `usage_event → earning_event` 的写入；
- 账期结算是批处理，跑在请求路径之外；结算只读 `earning_event` 与 `revenue_period`，可重复执行且幂等；持有期 `PAYOUT_HOLD_DAYS` = 120 天，提现门槛 `PAYOUT_THRESHOLD_MINOR` = $20，转为 Additional Calls 不设门槛但同样过持有期；
- 回冲产生新的 `earning_event` 记录，不修改历史行；已出账的收入被冲回时余额为负，负余额清零前拒绝提现与开新付费方案；注销时核销记 `written_off`；
- **检索链路与频道目录排序不得读取任何收益字段。** §9 的召回、融合与 Rerank 输入，以及 §9.6 的路由排序和频道目录的「热门」排序中不存在 `earning_event`、`channel_subscription`、`publisher_account` 或 `payout`。这条与 §10 的 Policy 先于检索同属硬约束；
- 除待结算给创作者的频道收入外，平台不持有用户资金；分账账本只记录应付与已付，不做双重记账与清结算。`payout` 只保存收款 PayPal 邮箱、交易号与状态，不保存银行账号、卡号或税务证件原件；人工打款在系统外完成，系统只登记结果；
- 结算单照常上链（`earning_statement`，§8.5）；P3a 开工前提是 Paddle 可售范围的书面确认、手续费口径与税务合规意见（提案第 13.2 节）。

## 12. REST API

### 12.1 查询契约

```text
GET /v1/libraries/search
  ?query=server+authentication      # 必填：用户问题或检索意图
  &libraryName=Next.js              # 可选：名字辅助提示

GET /v1/context
  ?libraryId=/vercel/next.js
  &query=server+authentication
  &type=json
  &maxTokens=5000
```

REST 保留，供网站内部、测试与脚本化管理使用，不对外宣传（提案第 13.3 节）；路径、字段与错误码在 P5 改为 `/v1/assets`、`assetId`、`asset_*`，本节写现在的名字。`/v1/revenue*` 随发布者分成删除。

Search 以 `query` 为主输入走 §9.6 的画像路由，`libraryName` 降级为可选提示。每个候选除 Trust/Benchmark 分数外必须携带**命中证据**——匹配到的文档标题、实体词和少量段落摘录——供调用方在不信任名字的前提下定案。

认证使用 `Authorization: Bearer mm_live_...`。匿名只允许明确开放的 Search/Context 子集，走 §11.2 的匿名限流，不计 Call。

权威 Context JSON：

```json
{
  "requestId": "req_...",
  "libraryId": "/vercel/next.js",
  "resolvedVersion": "v16.1.0",
  "codeSnippets": [],
  "infoSnippets": [],
  "rules": {
    "global": [],
    "libraryOwn": [],
    "workspace": []
  },
  "usage": {
    "calls": 1,
    "returnTokens": 0
  },
  "cached": false
}
```

Citation 是每个 Snippet 的必填字段，不另行依赖前端拼接。`type=txt` 由 Formatter 从这个对象生成。

### 12.2 管理契约

普通用户管理 API 位于 `/v1`。管理后台 API 位于 `/internal/admin/v1`，不公开进普通 SDK，并同时要求 Admin Session、Permission 和 CSRF/Origin 检查。

OpenAPI 是发布门槛：

- CI 校验所有 Route 与 Contract Schema；
- SDK 从 OpenAPI/共享 Contract 生成或验证；
- 错误对象统一为 `error`、`message`、`requestId` 和可选 `details`；
- 429 返回 `Retry-After` 与标准额度 Header；
- Library Alias 返回 301 和 `redirectUrl`。

## 13. A2A、SDK、CLI 与插件

远程 MCP Server（`/mcp`、`/mcp/oauth`、`resolve-library-id` / `query-docs`、stdio 包装器、`lib/webmcp`、`packages/mcp`、`packages/tools-ai-sdk`）已下线，代码保留在开关之后；Agent 的接入方式改为 Agent Card 与 A2A。

### 13.1 A2A Server

产品规则见 [requirement.md](./requirement.md) 第 9.5 节；外部规范为 A2A Protocol v1.0，实现用 `@a2a-js/sdk` v1.x。**阶段**：三层卡、`find_channels`、`search_context`、两种绑定、Postgres 任务存储在 P1；`ask`、`ingest`、`refresh`、`publish`、扩展卡、推送通知已在 P2 实施（迁移 `0063_agent_first_p2.sql`）。P1 开工前先装包核对 SDK 提供 `JsonRpcTransportHandler`、可替换的 `TaskStore` 与 v0.3 兼容模式（提案第 13.2 节）；若没有兼容模式，只实现 v1.0。

**三层 Agent Card**

| 层级 | 地址 | tenant | 公开卡 | 扩展卡（认证后） |
| --- | --- | --- | --- | --- |
| 平台 | `/.well-known/agent-card.json` | 空 | `find_channels`、`search_context`、`ask`：全部公开频道里的 `free` 资产，先路由到频道（§9.6） | 调用方工作空间的 `ingest`、`refresh`、`publish` |
| 用户 | `/a2a/users/{handle}/agent-card.json` | `users/{handle}` | 该用户全部公开频道里的 `free` 资产；没有公开频道时没有检索技能 | 本人认证时：他的全部资产，含不属于频道与私有频道的；`ingest`、`refresh`、`publish` |
| 频道 | `/a2a/channels/{slug}/agent-card.json` | `channels/{slug}` | 该频道的 `free` 资产 | 订阅者认证时：该频道的 `paid` 资产 |

- 三层卡由同一份卡片生成逻辑按层级输出，私有频道与下架的频道没有卡；用户主页、频道主页的 HTML 里加 `<link rel="agent-card">`，`sitemap.ts` 列出全部公开的用户卡与频道卡；
- 扩展卡按调用方生成（`DefaultRequestHandler` 的 `extendedAgentCardProvider`），写明调用方工作空间的额度、容量和每日答案上限（`description` 与 re0 扩展 `https://re0.io/a2a/extensions/workspace-quota/v1` 的参数），不得出现内部服务地址或凭证（A2A 规范 13.3）；写技能只出现在调用方自己的工作空间上：平台卡，或本人的用户卡；公开卡从不列出写技能；Agent Card 的 `description` 写明结果可用公开 Verifier 独立核对，以及确认门用 `INPUT_REQUIRED` 表示「等资产所有者确认」的约定。

**路由与绑定**

- `app/a2a/[[...tenant]]/route.ts` 承接三层卡的 **JSON-RPC** 与 **HTTP+JSON** 请求（gRPC 不做），按 `supportedInterfaces[].tenant` 路由到平台 / 用户 / 频道的检索范围；
- `JsonRpcTransportHandler` 不依赖 Express：Route Handler 解析请求体、构造带工作空间身份与 tenant 的 `ServerCallContext`，调用 `handle()`；流式方法返回的 `AsyncGenerator` 转成 `text/event-stream`（SSE），跑在默认的 Node.js 运行时上；
- 鉴权：`securitySchemes` 声明 HTTP Bearer，凭证就是 API Key，Key 归属的工作空间即调用身份；匿名只能用公开卡上的 `find_channels` 与 `search_context`，走 §11.2 的匿名限流、不计 Call；`ask` 需要认证；`find_channels`、`search_context`、`ask` 要求 `knowledge:search` 或 `knowledge:read`，`ingest`、`refresh`、`publish` 要求 `assets:write`；OAuth 留到以后；
- `AgentExecutor` 只是适配层：把 A2A Message 转成 §9.5 的生成链路或 §9.2 的检索调用，把结果写成 Artifact；鉴权、Policy、可见性、计量都在 `lib/application` 完成，A2A 层不重写业务规则。Route Handler 只要求 Key 至少有一个 A2A 权限（`knowledge:search`、`knowledge:read`、`assets:write`），每个技能需要哪个权限由执行器判定（`skillRefusal`）；
- 写技能（`ingest` → `create_asset`、`refresh` → `refresh_asset`、`publish` → `move_asset`）只调用 `proposeAction` 写一条 `agent_action`（`origin = a2a`、`a2a_task_id`），任务先存库再写操作行，然后转 `INPUT_REQUIRED`；对等待中的任务再发消息只会得到同样的等待说明；
- 来自其他 Agent 的 Message 一律是不可信输入，与 Chunk 一样不能改变系统提示、工具权限或确认门。

**结果**

Artifact 固定带两个 Part：`text`（`ask` 的答案正文，或 `search_context` 的可读摘要）与 `data`（结构化证据：每条 Citation 的 `chunk_id`、资产 ID、来源 URL、章节、Version，以及该版本的链上锚点，§8.5）。`find_channels` 与 `search_context` 不调用模型，移除生成层后行为完全不变；`ask` 走 §9.5 共用的生成链路。Schema 放在 `contracts/a2a`。

**任务存储与订阅**

- **任务存储放 Postgres**（`a2a_task`）。SDK 默认的 `InMemoryTaskStore` 和事件总线都在单个函数实例的内存里，Vercel 上第二个请求可能落到别的实例：`GetTask` 会找不到任务，`SubscribeToTask` 只能拿到一张快照。实现基于 Postgres 的 `TaskStore`，`history` 与 `artifacts` 随任务行保存；Upstash Redis 只做限流与缓存，不拿来做事件总线；
- `SubscribeToTask` 在函数时长内以短间隔读库推送状态变化，到时长上限后正常关闭流，由客户端重连；长任务建议调用方设 `returnImmediately: true`，再用推送通知或 `GetTask` 查进度。`returnImmediately` 在第一个事件后返回，执行器继续运行，Route Handler 用 Next 的 `after()` 把函数保持到执行器结束；SDK 的事件总线不跨请求保留（`keepBusAliveStates: []`）；
- 请求之外的状态变化（所有者确认或拒绝、待确认操作过期、构建结束）由 `lib/application/a2a/task-events.ts` 直接写 `a2a_task`（对旧状态做比较后更新，终态不再改），并发推送通知；`GetTask` 与 `SubscribeToTask` 读取前先补上（过期的待确认操作、已结束的构建），`/api/cron/drain` 每次也补一遍；
- 状态路径：`find_channels` / `search_context` / `ask` 直接返回 Message 或 `WORKING → COMPLETED`；`ingest` / `refresh` 为 `SUBMITTED → WORKING → COMPLETED / FAILED`，对应一次构建 Workflow（`workflow_run_id`）；需要确认的操作转 `INPUT_REQUIRED`，状态消息写明等的是资产所有者在 Dashboard 中的确认并给出待确认操作的链接，人确认后回到 `WORKING`，待确认操作 24 小时过期或被拒绝时转 `FAILED`。待确认操作与工作台共用 `agent_action` 表，**调用方 Agent 不能自己确认**；
- `CancelTask` 对构建任务的语义是取消排队：`workflow_operation` 仍是 `pending` 时改为 `cancelled`，已开始的构建拒绝取消（`TaskNotCancelableError`），已开始写入的版本按 §8.3 的发布事务处理，不留半成品；还在等待确认的任务被取消时，其待确认操作转为 `rejected`；
- 任务正文（Message、Query）与 Query 同等保密：不进普通日志和 Analytics，`body_purge_at` 默认 30 天后删除正文、只留 ID 与计量信息。

**推送通知**

- 回调 URL 在登记时过与抓取相同的 SSRF 校验（§15.1：禁止私网、Loopback、Metadata Endpoint、重定向绕过），每次发送前再解析校验一次；
- 推送 Token 与认证信息用 `CREDENTIAL_ENCRYPTION_KEY` 加密保存在 `a2a_push_config`（`sealCredential`），读回配置时不返回，不进日志；只有已认证调用方能登记，按 tenant 与调用方工作空间隔离，每个任务最多 5 个；
- 发送不跟随重定向，5 秒超时，失败只记录目标主机，不重试到私网地址；发送前的解析校验检查主机解析出的全部地址。

**确认门（`agent_action`）**

- 工作台与 A2A 共用 `lib/application/agent/actions.ts`：`proposeAction` 校验参数、把资产与频道引用解析为本工作空间的 ID、估算 Call 与容量、写一行 `pending` 并带服务端生成的摘要与参数摘要（`params_digest`，参数规范化 JSON 的 SHA-256）；
- `confirmAction` 只接受 `owner` 类型的确认者（只有 Dashboard 的 Server Action 用当前会话构造），要求可管理资产的角色；用一条条件更新 `pending → confirmed`（同时比较摘要与 `expires_at`）保证一次性，然后以该用户身份调用与 Dashboard 相同的用例（`createWorkspaceLibrary`、`requestLibraryRebuild`、`createChannel`、`moveAsset`），结果写回操作行并写 `audit_log`（`target_type = agent_action`，`administrator_id` 为空，确认者在 `after_value`）；用例拒绝时操作转 `failed` 并记原因；
- 模型、Chunk 文本与 A2A 调用方在领域层是被点名拒绝的确认者类型（`lib/domain/agent-action.ts` `mayConfirm`），工具集合里也没有确认工具；`expireActions` 由 drain 与读取时调用。

**计量**

`search_context` 每次成功检索计 1 Call、零结果不计；`ask` 每个答案计 10 Calls、每个工作空间每天最多 500 个答案，两个值在控制台配置；`find_channels` 与协议操作（`GetTask`、`ListTasks`、`CancelTask`、取卡、推送配置）不计；全部计入**调用方**工作空间，匿名由平台承担（§11.1、§11.2）。

### 13.2 SDK

TypeScript SDK：

```ts
const client = new Re0({ apiKey: process.env.RE0_API_KEY });

const libraries = await client.searchLibrary(
  "server authentication",
  "Next.js"
);

const docs = await client.getContext(
  "server authentication",
  "/vercel/next.js",
  { type: "json", maxTokens: 5000 }
);
```

SDK 只封装 REST；默认：60 秒总超时、只对网络错误/429/5xx 进行有限指数退避、不重试 4xx、`cache: no-store`、可注入 Base URL 供测试和私有部署。随 P5 的接口改名（`searchAssets`、`assetId`）发新版本，不保留别名。

### 13.3 CLI 与分发

CLI 命令：

```text
re0 auth login|logout|status
re0 library <name> <query>        # P5 改为 asset
re0 docs <library-id> <query>
```

`setup` / `remove` / `skill` 中写入 MCP 配置的部分随 MCP 下线（代码保留在开关之后）。配置写入必须可预览、可重复执行、保留用户其他配置。Skills 与插件只组合 SDK，不直接访问数据库、对象存储或缓存；AI SDK Tools（`packages/tools-ai-sdk`）随 MCP 下线。

### 13.4 网站插件（Embed Widget，已下线）

网站插件与分享页（`app/s`、`lib/application/showcase`、自定义域名、线索收集）**暂时下线**：入口与路由撤掉，代码保留在开关之后；已收集的线索删除，自定义域名不再提供（提案第 3.6 节）。频道取代了它们对外的职责。以下为下线前的实现记录，代码在 `lib/domain/site-key.ts`、`lib/application/embed/`、`app/embed/route.ts`、`app/api/embed/ask/route.ts` 与 `public/widget.js`、`public/embed-app.{js,css}`：

- **站点密钥**（`site_key` 表）：一把密钥对应一项资产，明文存储——它被粘贴进客户网页，所有访客可见，哈希保护不了什么。保护所有者额度的是密钥自己的两列：`allowed_origins`（规范化的 `scheme://host[:port]` 列表）与 `daily_limit`。创建、编辑、吊销是库管理者（owner/admin）的权利，用例逐一复核角色与库归属。
- **Loader 与 iframe**：`widget.js` 只在宿主页画一个按钮，点开后把 `/embed?key&parent&lang` 装进 iframe。`/embed` 是 Route Handler 而非页面，因为它存在的意义是一个响应头：`Content-Security-Policy: frame-ancestors <allowed_origins>`——浏览器据此拒绝在名单外的网站里渲染，这是公开密钥做不到的门。页面内的脚本通过 `postMessage` 把导航请求交给 loader，由 loader 决定同源替换当前页、异源新开标签；iframe 自己不碰 `top.location`。
- **问答流** `/api/embed/ask`：以所有者工作空间的身份调用 9.5 的生成链路（同一检索、同一逐句绑定、无模型时退化为引文列表），库由密钥钉死，不做路由。入口按顺序施加两道 fail-closed 限流：每访客窗口（哈希地址，与 11.2 同法）和密钥的滚动日上限；之后 Call 走 11.1 的正常预留与计量，入口记为 `web`。

## 14. 管理后台架构

每项管理员操作通过 Command Handler：

```text
authenticate admin
  -> require MFA freshness
  -> authorize permission
  -> validate target and reason
  -> execute domain command
  -> append audit record with before/after digest
  -> return redacted result
```

举报与下架的详情只暴露完成判断所需的来源和安全摘要。Reviewer 不得读取无关的不属于频道或私有频道里的资产正文；Support 默认只读用户元数据；Billing 不能修改管理员角色。专家审批、门槛配置与自检问题的后台页面已删除；频道层面的下架与恢复、频道收入的结算与出账、A2A `ask` 计量与频道目录排序的控制台配置按同一 Command Handler 模式实现。

Audit Log 采用只追加表，并保存前一条记录 Hash 形成链式校验。每日把审计链头部签名/摘要写入独立对象存储 Object，降低数据库管理员无痕修改风险。导出使用短期对象并审计下载。

存证**在管理后台没有界面**。它是 §8.5 的旁路系统：观测面是 Cron 每次触发时打到日志的 `anchor-alert <severity> <code> k=v` 行（见 §17.2）；失败批次的恢复是 `npm run anchor:release`，由持有数据库凭据的人执行，与 `admin:create` 同类，不经过控制台，也因此不进审计链。

**释放失败批次**把一个从未上链的批次标为 `superseded` 并删掉它的 Leaf，让其中的 Subject 回到待锚定队列。批次行保留、Leaf 删除这个不对称是有意的：行保住了「存在过这个批次」的记录，而 Leaf 必须走，因为 `anchor_leaf` 的唯一约束正是拦住 Workflow 重新拾取这些 Subject 的东西。**只允许 `failed`**：`confirmed` 的 Leaf 是第三方要校验的证据，`pending` 与 `submitted` 还在动，释放一个随后被链接受的批次会把同一批 Subject 锚两次。

注意这不是提案 §4.5.1 的「重锚」。那一条针对的是 **Leaf 构造本身有缺陷**：受影响的 Subject 以新的 `leaf_schema_version` 重新锚定，旧批次作为历史保留——那是一次发布，不是一个按钮。

存证**也没有暂停开关**。要让它停下来，把该环境的 `APTOS_*` 移除即可——Workflow 随即视自己为未配置，与前后台文案消失是同一个开关（§19.1）。

有一条边界即使没有界面也仍然成立，并且写在查询里而不是留给记忆：**任何读取锚定的代码一律停在 `anchor_leaf.leaf_hash`，不 join `library_version`、`revenue_period` 或任何 Subject 表**。批次行本身不泄露什么——链上公开的就只有 Root 和批次元数据——危险的是顺着 `subject_id` 一 join，私有资产的内容与创作者的结算金额就绕过了 requirement.md §6.4 的可见性规则。

## 15. 安全设计

### 15.1 来源安全

- 仅允许 HTTPS 和 GitHub（GitLab、Gitee 等不支持）；
- 每次请求和重定向都解析 DNS，拒绝私网、Loopback、Link-local 和 Metadata 地址；A2A 推送通知的回调 URL、文章导入的网址与 RSS 走同一套校验；
- 音频文件只校验类型、大小与哈希，不转写、不送往任何第三方；评论正文经过与上传内容相同的 PII 与恶意内容检查，命中时先隐藏；
- 固定最大重定向、页面、深度、字节、压缩比、文件数和执行时间；
- Connector Token 使用 Envelope Encryption，只通过 Secret Reference 访问；
- Parser 在隔离运行环境中处理不可信文件，不执行宏、脚本或仓库构建命令；
- Prompt Injection、恶意代码说明、凭证和 PII 分层检测，可疑内容进入 Quarantine。

### 15.2 查询安全

- Query 最大长度和字符策略统一；
- Query/私有 Chunk 不进入普通日志、Analytics、错误追踪 Breadcrumb；
- Library Rules 与来自其他 Agent 的 A2A Message 都是数据，不具备指令优先级，不能改变系统提示、工具权限或确认门；
- 所有召回先绑定资产 + Version（问频道时为一组），不属于频道的资产再绑定 Workspace；`paid` 正文只对订阅者返回；
- API Key 只在服务端使用，浏览器公开页面不得包含 Secret；
- A2A 端点 CORS 只开放需要的 Method/Header；A2A 任务正文与 Query 同等保密，30 天后删除正文；
- 待确认操作只能由资产所有者在 Dashboard 以会话身份确认，一次性、绑定参数、24 小时过期；
- Response 设置适合私有内容的 Cache-Control 和安全 Header。

### 15.3 应用与后台安全

- OAuth Callback 使用 State、PKCE、Nonce 和严格 Return URL；
- Session Cookie 为 Secure、HttpOnly、SameSite；
- 写操作校验 Origin/CSRF；
- 管理后台强制 MFA、重新认证、IP/设备异常检测；
- Payment/Connector Webhook 使用原始 Body 验签、时间窗和 Event ID 去重；
- Secret 通过平台环境变量与 Secret 管理注入，不写入仓库或日志；
- 例外是模型供应商凭据（§9.7）：它们保存在数据库，以 `CREDENTIAL_ENCRYPTION_KEY` 派生的 AES-256-GCM 密封。理由是这四类模型属于后台运营配置，换供应商不应当等于一次部署；代价是 `CREDENTIAL_ENCRYPTION_KEY` 成为它们的唯一保护，因此它本身仍只存在于环境变量中。密文不回传浏览器，不进审计链（审计只记录"是否轮换"），日志与导出同理。

## 16. 一致性、恢复与备份

- 权限、额度、发布指针和管理员暂停一律读主库，不接受副本延迟；
- 公共目录和非安全统计可使用 Read Replica，并显式标注可容忍的延迟上限；
- Postgres 事务用于发布、Plan Version 激活和需要多表一致的写入；
- 全文索引与向量同属 `chunk` 表，与发布指针同事务，不需要跨系统保序；只有对象存储写入必须先于事务提交，未被引用的对象由生命周期规则和 Recovery 清理；
- 数据库使用 Neon 的时间点恢复与分支能力，并定期导出业务表到私有备份位置；
- `search_vector`、`embedding`、`library_profile` 和 `usage_summary` 可从 Chunk 正文与 Usage Event 重建；
- 连接通过 Neon 连接池端点或 Serverless Driver 建立，禁止在函数内建立无池化的长连接；
- 每季度执行恢复演练，验证 Library、Policy、Usage 和 Audit 的恢复点。

## 17. 可观测性与错误处理

### 17.1 Trace 字段

```text
request_id
trace_id
actor_type
actor_hash
workspace_id
library_id
version_id
policy_version_id
workflow_operation_id
channel_id
a2a_tenant
a2a_task_id
entrypoint                 # web | a2a | rest
status_code
duration_ms
```

禁止记录 Query、Chunk Text、A2A Message 正文、Credential、完整 API Key、OAuth Token、推送 Token 或私有 Source URL。

### 17.2 指标与告警

- REST/A2A p50/p95/p99、错误率、429 和无结果率；A2A 任务各状态数量与 `INPUT_REQUIRED` 等待时长；
- 全文/向量候选数、融合增益、Citation 缺失和 Rerank 耗时；`ask` 的单问成本（`llm_cost_event`，上线一周后复核 10 Calls 的取值）；
- 频道级路由的候选频道数、命中率（最终裁决频道落在候选前 N 的比例）、scatter-gather 扇出与耗时；
- 待确认操作的积压与过期数；匿名限流的拒绝数；
- Workflow Step 时长、重试、Pending Age、Quarantine 和失败率；
- Postgres 写入冲突与锁等待、对象存储错误、ANN 索引查询退化、数据库冷启动次数；
- Usage Reservation 与 Summary 差异；
- Payment Webhook 延迟和失败（含频道订阅的退款与拒付）；
- 举报积压、管理员失败登录和高风险动作。

告警中只包含 ID 和稳定错误码，通过受控后台查看必要详情。

平台尚未选定告警投递通道。锚定侧的告警规则是 `lib/domain/anchor-alerts.ts` 里的纯函数，判定结果由 Cron 以 `anchor-alert <severity> <code> k=v` 的固定格式打到日志（严重走 `console.error`）。接一条真正的通道属于配置，不需要改这段判定。

锚定的告警条件**刻意很少，且都不依赖任何配置项**：监控不可达、余额为零或偏低、批次已放弃、积压超过 SLO 窗口。合约发布次数与签名账户交易数不产生告警——存证是可随时移除的旁路系统（§8.5），一条需要自带配置基线的规则会与那份基线脱节，届时告警反映的是配置而不是平台。要核对它们，`0x1::code::PackageRegistry.upgrade_number` 与公共节点即可，不必经过本平台。

## 18. 测试策略

### 18.1 Contract Tests

- OpenAPI 与 Route Schema 一致；Agent Card 与 Artifact `data` Part 符合 `contracts/a2a`；
- REST JSON/TXT、A2A `search_context`、SDK 与四个生成入口的检索对相同输入返回同一 Version/Citation；
- 用官方 A2A Inspector 跑通三层取卡、`SendMessage`、`GetTask`（P1）；
- 202/301/400/401/403/404/409/413/422/429/5xx 映射稳定。

### 18.2 Domain 与 Integration Tests

- 工作空间总容量 500 MB / 2 GB、20 个 Key 和 Calls 边界；任何用户购买 Additional Calls 后容量升到 2 GB；
- 并发 Call Reservation 不超额、不重复计量；匿名检索不产生 Usage Event；已认证调用方检索频道时 Call 计入调用方而不是所有者（P1）；
- Policy quality/select、Block/Except、频道 ID 名单与 requirement.md 6.2 可见性矩阵（不属于频道、私有频道、`free`、`paid` × 所有者、订阅者、其他人）；
- 不属于频道的资产对他人不可见、私有频道没有频道卡、owner 为保留名的 GitHub 资产被拒（P1）；模型或调用方 Agent 试图自行确认待确认操作被拒（P2）；非订阅者经 Web、A2A、REST 都取不到 `paid` 正文、订阅到期后下一次调用即被拒、评论不出现在任何检索结果里、拒付冲回已出账收入后余额为负且不能提现（P3a）；
- Version 发布原子性、刷新失败和 Alias Redirect；
- 全文、向量、RRF、Rerank、去重和 Citation Golden Tests；
- Workflow 每步重放、Provider 超时、Webhook 重放和乱序；
- 对象存储写入成功但事务回滚、以及 Workflow 中途失败后的 Recovery。

### 18.3 安全与 E2E Tests

- SSRF、DNS Rebinding、重定向绕过、恶意压缩和 Parser Payload；
- Prompt Injection、Secrets、PII 和隔离内容不返回；
- 跨 Workspace 对不属于频道的资产的枚举与 Vector Filter 绕过；A2A 推送回调的 SSRF；
- API Key 显示一次、撤销、Scope（含 `assets:write`）和过期；
- 普通 Session 无法访问 Admin，低权限 Admin 无法执行高权限命令；
- 删除后 API、全文、向量、对象存储、缓存和刷新均不可访问；
- GitHub/Google 登录、添加资产、频道、Pricing、用量和账单页面 E2E。

## 19. 部署与发布

### 19.1 必需环境变量与 Secrets

```text
DATABASE_URL               # Neon 连接池端点
DATABASE_URL_UNPOOLED      # 迁移与 Workflow 用的直连端点
BLOB_READ_WRITE_TOKEN      # Vercel Blob 读写 Token；设置后对象存储走 Blob
OBJECT_STORE_ENDPOINT      # 退路：S3 兼容端点，仅在未设置 BLOB_READ_WRITE_TOKEN 时使用
OBJECT_STORE_BUCKET
OBJECT_STORE_ACCESS_KEY_ID
OBJECT_STORE_SECRET_ACCESS_KEY
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN

GITHUB_OAUTH_CLIENT_ID
GITHUB_OAUTH_CLIENT_SECRET
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
NOTION_OAUTH_CLIENT_ID          # Notion public integration：向导「连接 Notion」导入页面，回调 /api/auth/notion/callback/connect
NOTION_OAUTH_CLIENT_SECRET
NOTION_INGESTION_TOKEN         # 可选，internal integration：仅平台 Notion 资产使用；工作空间的 Notion 资产用用户自己的授权
SESSION_SIGNING_SECRET
API_KEY_HASH_SECRET
CREDENTIAL_ENCRYPTION_KEY      # 密封后台保存的模型凭据，见 §9.7；轮换后所有已存密钥读不出来，需重新录入
EMBEDDING_PROVIDER_API_KEY     # 可选，升级兼容：后台从未保存过向量模型时的兜底（连同 EMBEDDING_PROVIDER_BASE_URL、EMBEDDING_MODEL），首次保存后不再读取
RERANK_PROVIDER_API_KEY        # 可选，同上，重排模型的兜底；需与 RERANK_PROVIDER_BASE_URL 同时设置（RERANK_MODEL 可选）
RENDER_PROVIDER                # 可选，升级兼容：firecrawl | anysearch | jina，网站来源被拒或返回 JS 空壳时的渲染兜底（§8.2）；后台首次保存渲染配置后不再读取
RENDER_PROVIDER_API_KEY        # 可选，同上；多个 Key 用逗号分隔，按顺序轮换
RENDER_PROVIDER_BASE_URL       # 可选，同上，自托管实例的地址（如 http://firecrawl:3002）；设了它 key 可省略，内网 http 允许但不允许重定向
OCR_PROVIDER                   # 可选，ocrspace：上传的 PDF 没有文本层（扫描件）时的 OCR 兜底，见 §8.2
OCR_PROVIDER_API_KEY
OCR_PROVIDER_BASE_URL          # 可选，付费套餐的区域端点（如 https://apipro1.ocr.space）；不设则用公共 API
OCR_PROVIDER_LANGUAGE          # 可选，按厂商约定透传（ocr.space 为三字母码，如 chs）；不设由厂商自动检测
PAYMENT_PROVIDER_SECRET
PAYMENT_WEBHOOK_SECRET
PADDLE_*                       # Paddle Billing，见 .env.example；只剩 Additional Calls 商品（PADDLE_ADDON_PRODUCT_ID），PADDLE_PRO_PRODUCT_ID 随 Pro 删除；频道订阅商品在 P3a 加入
APP_BASE_URL
API_BASE_URL
CRON_SECRET                    # Vercel Cron 调用 /api/cron/drain 时携带的 Bearer；队列兜底与上传清扫

APTOS_NETWORK                  # 生产固定 mainnet；开发与 CI 用 testnet 或 localnet，见提案 §4.7
APTOS_NODE_URL
APTOS_API_KEY                  # 写入路径凭据
APTOS_INDEXER_URL              # 事件监控
APTOS_INDEXER_API_KEY          # 必须与 APTOS_API_KEY 不同，见提案 §4.9
APTOS_ANCHOR_OBJECT_ADDRESS
APTOS_ANCHOR_ACCOUNT_ADDRESS
APTOS_ANCHOR_SIGNER_KEY        # Anchor Signer 的 Ed25519 私钥，十六进制；见下
ANCHOR_LEAF_SALT_SECRET
```

Secret 不得进入前端 Bundle，只允许在 Server Component、Route Handler 和 Workflow 中读取。默认三套环境各持一份，两类例外见 §3.2：Neon 与 Blob 的连接项（`DATABASE_URL`、`DATABASE_URL_UNPOOLED`、`BLOB_READ_WRITE_TOKEN` 及 Neon 集成注入的 `POSTGRES_*` / `PG*`）因为资源本身共享而三套环境同值；`SESSION_SIGNING_SECRET`、`API_KEY_HASH_SECRET` 和 `CREDENTIAL_ENCRYPTION_KEY` 则是必须同值——它们加密或哈希的是共享库里的行。

链相关项的三条硬约束：`APTOS_ANCHOR_SIGNER_KEY` 是上表**唯一一项真正的私钥材料**（[aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md) 1.1 版第 4.6 节的已决事项），三套环境各持一份、严禁共用，生产的那一份不得进入 preview 部署、CI 或任何本地文件；它与其余 Secret 不是同一量级——别的泄露了换一把 key 就行，它泄露要换 Aptos 账户、发布一个新的 Code Object 并重锚，因为签名地址在合约里编译期绑定而包不可变更。

### 19.2 发布顺序

1. 校验 Migration 可前向兼容；
2. 通过直连端点应用 Postgres Schema、全文与 ANN 索引变更；
3. 校验 `pgvector` 等所需扩展已启用且版本匹配；
4. 部署 Workflow；
5. 部署应用；
6. 执行 Contract、Smoke、权限和 A2A Probe（三层取卡与 `SendMessage`）；
7. 小流量观察指标后完成发布。

数据库变化使用 Expand/Contract：先加字段和双读写，再迁移数据，最后删除旧字段。Version、Policy 和 Plan Contract 不做原地语义变更。

## 20. 容量与演进门槛

MVP 不预先引入 Kubernetes、Kafka、自建搜索集群或外部 Vector DB。

Upstash Redis 不在此列：它替代的是上一版运行平台自带的限流与缓存能力，属于换栈后的能力补位，不是提前优化。其职责边界在 §1.2 已经写死，扩大用法需要新的架构评审。

外部 Vector DB 的否决按十万资产、上亿 chunk 的量级重新校验过，仍然成立：主负载是资产内与频道内的 scoped 检索（Postgres 精确扫描的主场），全局语义由画像层小索引承担（§9.6），全局关键词由 GIN 倒排承担——没有一条查询路径需要全局 chunk 级 ANN。若「全平台 chunk 级语义检索」未来成为真实产品需求，先质疑需求本身（用户要的通常是「找到对的频道」或「在对的资产里找段落」，两者都已有解），确认后现实路径是**二值量化粗召回 + 原始向量精排**（仍在单 Postgres 内，量化后上亿向量约数十 GB 可驻内存），或迁往 namespace-per-tenant、对象存储分层的专用引擎——不是通用托管向量服务。

出现以下证据时再评估演进：

- Postgres 主写延迟或写入容量连续越过 SLO；
- 全文检索在目标 Library 规模下无法达到 Search/Context p95；
- ANN 索引的构建时长、内存占用或召回率成为真实瓶颈，且调参无法解决；
- 数据库计算规格已达上限，或冷启动导致 p95 持续不达标；
- 频道级路由的候选命中率低于目标且画像层调参无法解决；
- 向量存储成本增速超出压缩手段（半精度、降维、冷资产置空，见 §9.1）可覆盖的范围；
- 单 Workflow 无法满足抓取吞吐或 Provider Rate Limit；
- 跨区域合规要求无法由当前数据位置满足；
- Usage 条件写入成为明显热点（解法是分区或物化，不是外置计数器，见 §11.1）。

迁移必须保持 REST/A2A 契约不变（P5 的接口改名除外）。数据库、全文、向量、对象存储和缓存都通过 Adapter 隔离，不能让 Provider 类型泄漏到 Domain 或 SDK。对象存储只使用 S3 兼容子集，不依赖任何单一供应商的专有 API。

## 21. 实现顺序

MVP 的 14 步（App Shell 与身份、Plan Version 与 Usage、Ingestion、混合检索与发布、Library Search 与在线试用、匿名限流、Dashboard、Payment 与 Add-on、平台资产与管理后台、认领、结算、Version/Audit Anchor 与 Verifier、Earning Anchor、SDK/CLI）已经实现。之后按 [agent-first-proposal.md](./agent-first-proposal.md) 第 13.1 节分阶段：

1. **P0 文案与清理**：slogan、`metadata`、OG 图；界面文案改为资产（页面路径不动）；删除 Pro、专家库、自检问题、按检索计的发布者分成、`llms.txt` 与 OpenAPI 来源；关闭网站插件、分享页、MCP 的开关；Additional Calls 对所有人开放；两级容量。退出条件：用户可见的界面里不再出现「知识库」、Pro、专家库、分成；任何用户都能购买 Additional Calls，购买后容量升到 2 GB；
2. **P1 资产、频道与 A2A**：`library.kind` 与数据重建（§6.5）；保留 owner 名单；页面路径改为 `/assets/*`、`/channels/*`；`channel`、`channel_asset`、频道主页、频道目录、用户主页；频道画像（§9.6）；三层 Agent Card；A2A `find_channels`、`search_context`，JSON-RPC 与 HTTP+JSON；Postgres `TaskStore`；首页改版；计量按「调用方付、匿名由平台承担」改。退出条件：先核对 `@a2a-js/sdk` v1.x 的能力；用官方 A2A Inspector 跑通三层取卡、`SendMessage`、`GetTask`；§18.2 标 P1 的集成测试通过；
3. **P2 工作台与写操作**：Agent 工作台、工具与确认门（`agent_conversation`、`agent_action`）；A2A `ask`、`ingest`、`refresh`、`publish`、扩展卡、推送通知；`assets:write`。退出条件：「模型或调用方 Agent 试图自行确认」被拒；`ask` 的 Call 数上线；
4. **P3a 文章、评论、问答与订阅**：开工前提是 Paddle 书面确认、手续费口径、税务与合规意见三项齐全（提案第 13.2 节）；频道订阅的 Paddle 商品与 Webhook 事件（§11.3）、频道收入记账与结算（§11.4）、`paid` 访问控制；
5. **P3b 音频**：上传、签名播放地址、节目说明进检索；
6. **P4 A2A 客户端**：re0 委托外部 Agent；四个场景落地页；
7. **P5 内部改名**：代码模块与标识符、REST 路径与字段、错误码、数据库表与列全部改为 asset，测试同步修改；除迁移历史外不再出现 library 标识符。

链上存证仍是 §8.5 的旁路能力：任何阶段的延后或失败都不影响其余交付。Anchor Signer 私钥由环境变量持有，不引入 KMS——提案 1.1 版撤销了 1.0 版的 KMS 决定，风险条目见其第 0.1 节；`earning_statement` 改为锚定创作者的频道收入结算单，在 P3a 之前没有新的结算单可锚。密钥轮换要发布一个新的 Code Object，见 [aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md) §4.11.1。

专家数据与评测赛道（§4.1）不在上述 14 步之内。它以 requirement.md §2.4 登记的阶段 0 门禁为前提，门禁未过时只允许专家预注册、资格测试与后台验证队列进入代码库；其后各阶段的顺序见 [expert-data-track-proposal.md](./expert-data-track-proposal.md) §17 与 §20。

## 22. 参考资料

### Context7 源码基线（历史，已不作为决策依据）

- [MCP Server](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/packages/mcp/src/index.ts)
- [MCP API Adapter](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/packages/mcp/src/lib/api.ts)
- [TypeScript SDK](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/packages/sdk/src/client.ts)
- [CLI](https://github.com/upstash/context7/tree/f3a818d69db694e24d58e3bf803454fb20fc66ea/packages/cli)
- [OpenAPI](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/docs/openapi.json)
- [Policies](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/docs/howto/policies.mdx)
- [Library Owners](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/docs/library-owners.mdx)
- [Library Updates](https://github.com/upstash/context7/blob/f3a818d69db694e24d58e3bf803454fb20fc66ea/docs/library-updates.mdx)

### 运行平台能力依据

- [Vercel Workflows](https://vercel.com/docs/workflows)
- [Vercel Functions 时长配置](https://vercel.com/docs/functions/configuring-functions/duration)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
- [Neon Serverless Driver](https://neon.com/docs/serverless/serverless-driver)
- [Neon 连接池](https://neon.com/docs/connect/connection-pooling)
- [Neon 读副本](https://neon.com/docs/introduction/read-replicas)
- [Neon pgvector 与 HNSW](https://neon.com/docs/extensions/pgvector)
- [Upstash Ratelimit](https://upstash.com/docs/redis/sdks/ratelimit-ts/overview)
- [Upstash Redis 全球复制](https://upstash.com/docs/redis/features/globaldatabase)

### 待验证事项

- ~~全文检索的中文分词方案~~ **已解决**：采用 ingestion 侧无词典 bigram 预切分（`lib/domain/cjk.ts`），Han 文本切成重叠二元组存 `chunk.body_segmented` 独立列，`search_vector_cjk` 生成列以 `simple` 配置索引预切分文本——`simple` 在这里是正确的，因为切分发生在 Postgres 之前。查询侧对含 Han 的问题走同一切分器并与主向量 OR 召回。选无词典方案是为了确定性（重建版本必须产出相同行，词典文件会漂移）与零原生依赖；`zhparser` 类词典分词器仍是记录在案的升级路径，切换方案必须随 `CHUNKER_VERSION` 升版触发重建；
- BM25 排序的实现路径：使用扩展提供的 BM25 还是在应用层实现，需比较可用性与成熟度；
- 画像层实体抽取与聚类质心的实现选型（统计 vs LLM）及其在 ingestion 流水线中的成本与时长；
- scatter-gather 确认层（10–20 个频道并行频道内召回）在 Vercel Functions 时长限制与 Neon 连接池下的 p95 表现；
- 向量压缩（halfvec + Matryoshka 降维）对检索 Golden Set 的召回影响，需在 §8.2 `evaluate` 步的基准上量化后再定默认维度；
- 对象存储从 Workflow 写入 100 MB 量级快照的实际表现，上线前须压测。
