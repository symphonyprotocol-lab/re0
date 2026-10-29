# Re0

把公开文档和用户有权使用的私有资料，转换为 AI Agent 可搜索、可检索、可引用的**版本化知识库**。

按成功受理的 API/MCP Call 计费，不按 Token 计费。

## 当前状态

公共站点、用户 Dashboard、管理后台、REST API（`/v1`）和远程 MCP（`/mcp`）都已在本仓库实现，CLI、SDK 和独立 Verifier 在 `packages/` 下。产品规则以 [requirement.md](./requirement.md) 为准，技术约束以 [architecture.md](./architecture.md) 为准；本地运行见下文「本地开发与登录」。

尚未实现的部分：专家数据与评测赛道（[expert-data-track-proposal.md](./expert-data-track-proposal.md)，只有设计）、发布者分成的实际出账（阶段 3），以及端到端测试（`tests/e2e/` 为空，现有覆盖是 `tests/contract` 与 `tests/integration`）。

## 产品定义

四个入口共用同一套身份、工作空间、知识版本、访问规则、检索、额度和审计规则：

| 入口 | 职责 |
| --- | --- |
| Web | 发现知识库、在线试用、管理知识库和账户 |
| REST API | 稳定、结构化的知识检索与管理接口 |
| MCP | 让 Claude、Codex、Cursor 等 Agent 用两项只读工具取得上下文 |
| CLI / SDK | 安装、配置与 API 封装，不复制服务端业务逻辑 |

核心价值：**最新**（按来源变化创建不可变版本）、**可信**（公开库经来源与安全审核）、**可追溯**（每段上下文保留来源、文档、章节和版本）、**可独立验证**（版本摘要上链，第三方不调用本平台接口即可校验）、**可治理**（工作空间可限制可访问内容）、**可预测计费**（按 Call）。

查询是两阶段的：`resolve-library-id` → `query-docs`。

## 文档地图

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [requirement.md](./requirement.md) | 产品边界、用户行为、套餐、接口契约、验收标准 | MVP 基线 |
| [architecture.md](./architecture.md) | 运行基座、数据模型、检索、计量、部署与发布 | MVP 基线 |
| [publisher-revenue-share.md](./publisher-revenue-share.md) | 发布者调用分成的完整设计 | MVP 基线 |
| [aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md) | 链上版本、审计与结算单存证 | MVP 基线 |
| [expert-data-track-proposal.md](./expert-data-track-proposal.md) | 专家训练数据、授权交付与专业评测的集成方案 | MVP 后扩展，待评审 |
| [self-hosting-proposal.md](./self-hosting-proposal.md) | Docker 私有部署形态：镜像、编排、与托管版的差异 | 待评审 |
| [review-visibility-proposal.md](./review-visibility-proposal.md) | 公开审核与专家审批：审核员可见内容、提交材料、规则/模型/人工三层审核 | 待评审 |
| `knowleg-market.pen` | 设计稿，27 个画板（Pencil 格式，需用 Pencil 打开） | — |

冲突时的决策顺序以 [requirement.md](./requirement.md) 第 1 节为准：产品规则 → 设计稿 → 架构约束 → Context7 接入模式 → 旧文档与旧设计稿。本文只是索引，不是权威来源。

## 技术栈

| 关注点 | 选型 |
| --- | --- |
| Web 与 BFF | Next.js App Router（Vercel 原生） |
| 运行环境 | Vercel Functions |
| 业务数据库 | Neon Postgres + Drizzle |
| 关键词检索 | Postgres 全文检索 + BM25 |
| 向量检索 | 同库 pgvector，**与 Chunk 同事务** |
| 对象存储 | S3 兼容私有 Bucket，首发 Cloudflare R2 |
| 长任务 | Vercel Workflows |
| 边缘态 | Upstash Redis，**只做**匿名限流与检索缓存 |
| 答案生成 | 外部 LLM Provider，**只用于 Web 在线试用**，不进入 REST/MCP 链路 |
| 链上存证 | Aptos 主网，签名密钥由环境变量持有，账户只留 Gas 余额 |

选型理由和被否决的替代方案记录在 [architecture.md](./architecture.md) 第 1.2 节。其中最关键的一条：Chunk 正文、全文索引和向量在同一个 Postgres 事务内，因此发布是真正的 ACID 事务，不存在跨系统的中间态。

## 套餐

以 USD 计价，只有一档免费额度和一个加购包，不设 Pro 或 Enterprise（agent-first-proposal.md 8.1）。

| | Free | Additional Calls |
| --- | --- | --- |
| 价格 | $0 | $5 / 包，一次性，所有人可购买 |
| API Calls | 1,000 / 月 | +5,000 Calls |
| Calls 有效期 | 当账期，期末清零 | **不过期**，跨账期结转 |
| 自建知识库 | 不限数量 | 同 Free |
| 工作空间总容量 | 500 MB；买过调用包后永久 2 GB（`user.storage_tier`） | 首次购买即提升 |
| 有效 API Key | 20 个 | 同 Free |

扣减顺序固定为「先套餐额度、后调用包余额」。公开知识库全部可查，无需逐库购买。

## 发布者分成

通过审核并**完成认领**的用户公开知识库，按被成功检索的次数从平台收入中分成。要点：

- 只有 `query-docs` 计分成，`resolve-library-id` 和匿名试用不计；
- 未认领的公开库不产生收益，它的调用也不摊薄其他发布者的分配；收益不追溯到认领之前；
- 按可计分成 Call 数线性分配，**不按 Trust Score 加权**——分数只决定资格，不决定金额；
- 收益数据不得进入检索、召回或排序的任何环节；
- 出账由外部支付服务完成，Re0 不保存银行账号、不持有用户资金。

完整设计见 [publisher-revenue-share.md](./publisher-revenue-share.md)。

## 所有权认领

提交一个公开知识库**不等于拥有它**。所有权只能通过认领取得，认领要回答的不是「你是谁」，而是「你是否控制这个来源」——OAuth 只建立身份，不代表发布权。

| 来源类型 | 验证方式 |
| --- | --- |
| GitHub 仓库 | 仓库权限校验（要求 `admin` 或 `maintain`），备选 DNS TXT |
| Website、`llms.txt` | DNS TXT 记录，备选 well-known 文件 |
| 上传文档、OpenAPI、Notion | 不适用，创建者即所有者 |

**在 `re0.json` 里放公钥不会授予任何权限**：配置文件的可写范围与来源的控制权不等价，Fork、PR、镜像站都能写那个文件。完整规则见 [requirement.md](./requirement.md) 第 7.3 节，授权链路约束见 [architecture.md](./architecture.md) 第 5.4 节。

## 链上存证

已发布 Version、每日审计链头和已关账的发布者结算单，摘要写入 Aptos 主网。链上**只有摘要**，没有知识正文、Query、用户标识或任何资产。

存证是旁路能力：链或签名账户不可用时，发布、刷新、检索、计量、审核和出账全部不受影响，存证状态停留在待存证。存证不消耗 Call 额度，Free 与 Pro 均包含。

**存证只证明「某时刻的内容就是这一份」，不构成对内容正确性的保证**；对结算单只证明锚定后未被改写，不证明分配算得对。完整设计见 [aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md)。

## 环境准备

`development` / `preview` / `production` 共用同一个 Neon Project，库按环境分支：**production 用主分支；每个预览部署自动建一个 `preview/<git 分支>` 子分支（主分支的写时复制，部署销毁时回收）；本地开发连常驻的 `dev` 子分支**（在 Neon Console 建子分支时 Auto-delete 要改成 Never）。预览分支上的新迁移由 `vercel.json` 的 `buildCommand` 在构建前执行，只在 `VERCEL_ENV=preview` 时触发；生产的迁移不在构建里跑。对象存储跟着一起分：`recall0-blob` 只连 Production，`recall0-blob-preview` 连 Preview，`recall0-blob-dev` 连 Development。其余外部依赖仍按环境隔离：

- Upstash Database 与 REST Token
- OAuth Client、Payment Environment 和 Provider Key
- LLM Provider Key
- Aptos 账户与 Anchor Signer 私钥（非生产使用 Testnet）
- Workflow 名称与 Webhook Secret

反过来，凡是加密或哈希落库内容的 Secret，三套环境必须取同一个值：`SESSION_SIGNING_SECRET`（GitHub / Notion 授权令牌的封装、管理员邀请哈希与落库 TOTP 种子的封装）、`API_KEY_HASH_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`。各持一份的话，一个环境写下的行在另一个环境打不开。

**禁止把 Production 数据复制到 Preview**——私有知识库里是用户授权的 Notion 页面与私有仓库内容，测试数据必须脱敏或由 Fixture 生成。

对象存储用 Vercel Blob：每个环境一个私有 Store，各自连到对应环境，`BLOB_READ_WRITE_TOKEN` 会自动注入；本地用 `vercel env pull` 拉取。分开是必须的而不是讲究——预览分支是主分支的写时复制，行里的 Key 指向生产对象，共用一个 Store 时在预览里删掉一个知识库就会删掉生产的文件。代价是预览里那些从生产复制来的行读不到对象（Store 里没有），这在预览分支换成 schema-only 之后自然消失。Dashboard 的 PDF 导入向导由浏览器直接上传到 Blob（服务端只签发限定路径、类型和大小的 Client Token），不经过应用，也就不受请求体大小限制，不需要额外的 CORS 配置。Blob 没有生命周期规则，向导中途放弃的上传会留在 `uploads/` 前缀下，由 drain 每次收尾时清理超过 24 小时且未被引用的对象，也可以用 `npm run uploads:purge` 手动跑。未设置 `BLOB_READ_WRITE_TOKEN` 时，代码退回 `OBJECT_STORE_*` 描述的 S3 兼容 Bucket，那时 Bucket 要允许来自应用 Origin 的跨域 `PUT`。

构建任务在建库、改文件、后台刷新等动作的响应返回后立即执行（`after(runOperation)`），所以本地开发不需要额外进程；`vercel.json` 里的 Cron 每 10 分钟调用一次 `/api/cron/drain`（需要 `CRON_SECRET`）作为兜底，负责重试失败任务和清扫废弃上传。这个 Cron 同时也是平台知识库的自动刷新调度：每次先按各来源的刷新策略（每日 / 每周）把到期的来源排入队列，再执行队列。队列的实时状态、最近完成的记录和各来源的下次刷新时间在管理后台的「刷新队列」页（`/admin/refresh-queue`）查看。本地没有 Cron，可以用 `npx tsx` 调 `scheduleDueRefreshes()` 和 `drainOperations()`，或直接在后台按「排队刷新」。

PDF 知识库可以在建库时就上传文件，也可以先建空库、之后在列表页该库的「管理 PDF 文件」页随时增删文件；保存后会排队重新构建，新版本发布前旧版本继续提供检索。空库不排队构建。PDF 单文件上限 30 MB，每个知识库最多 20 个文件。构建时用 pdf.js 抽取文本层；扫描件没有文本层，需要配置 OCR 服务才能索引：设置 `OCR_PROVIDER=ocrspace` 和 `OCR_PROVIDER_API_KEY`（[ocr.space](https://ocr.space/ocrapi)，免费 Key 限 1 MB、3 页，PDF 套餐才放开到 100 MB、999 页，付费套餐的区域端点填 `OCR_PROVIDER_BASE_URL`；中文扫描件设 `OCR_PROVIDER_LANGUAGE=chs`）。OCR 只在至多一半页面有文本层时触发，文件不经过应用之外的任何临时 URL，直接以 multipart 送给厂商。未配置时扫描件构建会以 `parse_failed` 结束。OCR 是 `lib/infrastructure/connectors/ocr.ts` 里的一个 Provider 接口，换厂商只改这一处。

平台知识库也可以是 PDF 类型：在管理后台「创建平台知识库」里选 PDF，文件直传对象存储；建库后在详情页的「PDF 文件」面板增删，保存即排队重新构建；已有的网站 / GitHub 等库也可以在「添加来源」里加一个 PDF 来源（每库一个）。平台 PDF 库不按时间刷新，引用链接走公开的 `/files/{fileId}`。

完整环境变量清单见 [architecture.md](./architecture.md) 第 19.1 节。Secret 不得进入前端 Bundle，只允许在 Server Component、Route Handler 和 Workflow 中读取。Anchor Signer 私钥不出现在任何环境变量里。

## 本地开发与登录

```bash
npm install
cp .env.example .env.local   # 填入下面几项，其余可留空
npm run db:migrate           # 需要 DATABASE_URL_UNPOOLED
npm run dev
```

跑通登录最少需要这几个变量：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | 共享 Neon Project 的连接池端点与直连端点，后者用于迁移 |
| `APP_BASE_URL` | 本地固定 `http://localhost:3000`，回调 URL 由它拼出 |
| `SESSION_SIGNING_SECRET` | 至少 32 字符，用于会话摘要和 OAuth 状态 Cookie 的加密 |
| `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | GitHub OAuth App |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google OAuth Client |

两个 Provider 需要登记的回调地址：

```text
http://localhost:3000/api/auth/github/callback
http://localhost:3000/api/auth/google/callback
```

向导导入 GitHub 仓库时还有第二个回调，GitHub App 要求回调地址精确匹配，必须一并登记（Developer settings → 该应用 → Add callback URL）：

```text
http://localhost:3000/api/auth/github/callback/connect
```

向导导入 Notion 页面时同样先绑定账号：需要一个 Notion **public integration**（`NOTION_OAUTH_CLIENT_ID` / `_SECRET`），登记的 Redirect URI 为 `http://localhost:3000/api/auth/notion/callback/connect`。用户在 Notion 授权页选择共享给 re0 的页面，向导只列这些页面，之后的刷新也用同一份授权读取；令牌加密存于 `notion_connection` 表。管理后台的平台 Notion 知识库仍用 `NOTION_INGESTION_TOKEN`（internal integration）。

`npm run db:migrate` 打的是 `.env.local` 里的那条串，也就是 `dev` 分支——本地迁移不再碰生产。主分支（production 与 preview 共用）的迁移要显式指向它：

```bash
DATABASE_URL_UNPOOLED='<主分支直连串>' npm run db:migrate
```

顺序按 [architecture.md](./architecture.md) 第 19.2 节排：主分支先迁移，再发布依赖新 Schema 的代码。

`0002_seed_plans.sql` 会写入 Free 的 Plan Version（Pro 已在后续迁移中删除）——首次登录要在同一个事务里创建 Free 订阅，因此迁移必须先于任何流量执行。

### 后台的首位管理员

环境里一个管理员都没有时，`/admin/login` 显示的不是登录表单，而是首位超级管理员的注册表单：填邮箱和显示名、设密码、扫码绑定两步验证并输入当前验证码。注册成功后这个表单就消失，之后管理员只能由现有管理员邀请（requirement.md 3.2）。

开放与否由写入时的数据库状态判定，不由页面判定——插入语句自带 `where not exists (select 1 from administrator)`，并用 advisory lock 串行化并发请求，所以绕过页面直接调 Server Action 得到的是同一个拒绝。

**新环境上线后要第一时间完成这一步**：在它完成之前，任何能打开那个页面的人都能成为超级管理员。不希望这个页面对外出现过哪怕一次，就在放流量之前用脚本在数据库侧建好第一个管理员：

```bash
ADMIN_PASSWORD='...' npm run admin:create -- --email admin@re0.io --username Yuzhao --role super
```

测试：

```bash
npm test                                                   # 域与安全用例，不需要数据库
TEST_DATABASE_URL='postgres://...' npx vitest run tests/integration   # 会写库，只指向可丢弃的库，绝不是共享的那个
```

### 本地 Firecrawl（网站源的渲染回退）

拒绝普通抓取或只返回 JavaScript 壳的网站源，构建时会交给 Firecrawl 渲染成 Markdown（`lib/infrastructure/connectors/render.ts`）。本地开发不用买托管 API，用 Docker 跑一套自建实例：

```bash
docker compose -f docker/firecrawl/docker-compose.yaml up -d
curl -s http://localhost:3002/v2/scrape -H 'content-type: application/json' \
  -d '{"url":"https://example.com","formats":["markdown"]}'
```

然后在后台「模型配置 → 网页渲染」里选 Firecrawl、自托管地址填 `http://localhost:3002`（不需要 Key，自建实例关闭了鉴权）。后台从未保存过渲染配置时，也可以在 `.env.local` 里指向它：

```text
RENDER_PROVIDER=firecrawl
RENDER_PROVIDER_BASE_URL=http://localhost:3002
```

同一页还能切换到 AnySearch（`POST https://api.anysearch.com/v1/extract`）或 Jina Reader，并为每家维护一组按顺序使用的 API Key：一个 Key 额度用完（402）或失效（401）就自动换下一个。

镜像来自 `ghcr.io/firecrawl`（`nuq-postgres` 未公开，`docker/firecrawl/nuq-postgres` 里保存了一份构建文件本地构建）。若本机 Docker 守护进程拉 ghcr.io 报 `denied`，用 `docker/firecrawl/pull-ghcr-image.py` 在主机上下载后 `docker load`。队列数据不做持久化，`docker compose ... down` 即清空。

## 界面语言

站点、Dashboard 和演示数据都有中英两套文案，URL 不变，语言由请求决定：

1. `r0_locale` Cookie —— 用户在页眉切换过语言时写入，优先级最高；
2. 浏览器的 `Accept-Language` —— `zh-*` 归中文，其余归英文（`DEFAULT_LOCALE`）。

规则集中在 `lib/i18n/locale.ts`（纯函数，可单测），Server Component 用
`lib/i18n/server.ts` 的 `getMessages()`，Client Component 用
`lib/i18n/client.tsx` 的 `useI18n()` —— 后者由 `app/(public)/layout.tsx` 和
`app/dashboard/layout.tsx` 各自注入本次请求解析出的字典。

**`lib/i18n/messages/zh.ts` 是字典形状的权威来源**：`Dictionary = typeof zh`，
所以 `en.ts` 少一个键、拼错一个键都会编译失败。带运行时值的文案写成 `{name}`
占位符，用 `fill()` 填充——整份字典要跨 Server/Client 边界序列化，不能放函数。

约定：

- **新增文案先写进 `zh.ts`，再补 `en.ts`**，不要在组件里硬编码字符串；
- **筛选器、图标映射一律按 id 或下标匹配，不要按显示文案匹配**——文案会随语言变；
- **存下来的文本（如首次登录生成的工作空间名）在写入时定语言**，见
  `personalWorkspaceName` 与 `CompleteOAuthInput.workspaceNaming`；
- `tests/contract/locale.test.ts` 会检查协商规则、英文文案里的漏译，以及两份字典的占位符是否一致。

`content/docs/**` 的 MDX 正文还只有中文，需要按 Fumadocs 的 i18n 单独接。

## 实现顺序

见 [architecture.md](./architecture.md) 第 21 节，共 14 步。前四步是地基：

1. App Shell、Contracts、Postgres Schema、身份与工作空间
2. Plan Version、API Key、Usage Reservation 和统一错误
3. 对象存储上传、GitHub/Website/Markdown/PDF/OpenAPI Ingestion
4. 全文检索、pgvector、混合检索、Citation 和版本发布

后段有两处顺序是有依赖的，不能调换：**认领（第 10 步）必须早于分成（第 11 步）**，否则会产生一批无主的收益记录；**Earning Anchor（第 13 步）**要等分成跑出可独立复算的真实数据。

## 开发约定

这些约束在 [architecture.md](./architecture.md) 里是硬性的，实现时不要绕开：

- **Route Handler 和 MCP Tool 只能调用 `lib/application` 的 Use Case**，不直接碰数据库；
- **`contracts` 是 REST、MCP、SDK、CLI 和前端共同的权威类型来源**；
- **Provider SDK 只允许出现在 `lib/infrastructure` 和 Workflow 里**；Domain 不依赖 Next.js、Vercel、Neon、Payment、AI SDK 或链 SDK；
- **额度计数不得迁移到 Redis 或任何缓存层**——Reservation 与 Usage Event 是计费事实，必须与业务库同事务；
- **查询必须先授权并固定 Library Version 和 Policy Version**，再做任何召回；
- **Version 不可变**，刷新通过原子切换 `current_version_id` 发布；
- **`library.owner_workspace_id` 只能由已验证的认领或管理员裁定写入**，Ingestion、审核和刷新一律不得触碰；
- **REST 与 MCP 不引入 LLM 依赖**——移除在线试用的生成层后，两者行为必须完全不变；
- **在线试用零结果时不调用模型**，且答案中每条事实必须绑定到本次返回的 Chunk；
- **管理后台不能直连表**，必须经过 Admin Use Case 和 Audit Decorator。

## 待验证事项

开工前需要确认：

- 中文分词方案（Postgres 原生 FTS 需要 `zhparser`、`pg_bigm` 或退回 trigram，取决于 Neon 的扩展支持范围）；
- BM25 排序的实现路径；
- 从 Workflow 写入 100 MB 量级快照到对象存储的实际表现，需压测。

以上见 [architecture.md](./architecture.md) 第 22 节。
