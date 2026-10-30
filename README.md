# Re0

**Your data asset agent for life, work & business** / 为生活、工作与生意打理数据资产的 Agent。

**Every answer cites its source. Every version is verifiable.** / 每句话都有出处，每个版本都能验证。

re0 是一个**数据资产 Agent**：替用户收集、整理、使用、分发并变现数据资产。把网站、GitHub 库、上传文件、Notion 文章交给它，每个来源成为一项带不可变版本、可逐句引用的资产；用频道组织和公开资产，其他人和其他 Agent 通过频道、Agent Card 与 A2A 使用它们。按成功受理的 Call 计费，不按 Token 计费。

## 当前状态

2026-10-29 起按 [agent-first-proposal.md](./agent-first-proposal.md) 转向 Agent 优先，当前在 **P0（文案与清理）**：

- 已实现并在线：公共站点、用户 Dashboard、管理后台、REST API（`/v1`）、认领、链上存证；CLI、SDK 和独立 Verifier 在 `packages/` 下；
- **下线并放在开关之后**：网站插件（`/widget.js`、`/embed`）、分享页（`/s`）、远程 MCP（`/mcp`）；代码保留，入口与路由撤掉；
- **已删除**：Pro 套餐、专家库、自检问题（检索测试集）、按检索次数计算的发布者分成、`llms.txt` 与 OpenAPI 来源；
- **P1 起落地**：资产类型与数据重建、频道、频道目录、用户主页、三层 Agent Card 与 A2A（`find_channels`、`search_context`）；P2 Agent 工作台与 A2A 写操作；P3a 文章、评论、问答与频道订阅；P3b 音频；P5 内部改名（代码、REST、数据库里的 `library` 一律改为 `asset`，已完成）。

产品规则以 [requirement.md](./requirement.md) 为准，技术约束以 [architecture.md](./architecture.md) 为准；本地运行见下文「本地开发与登录」。尚未实现的还有专家数据与评测赛道（[expert-data-track-proposal.md](./expert-data-track-proposal.md)，只有设计）和端到端测试（`tests/e2e/` 为空，现有覆盖是 `tests/contract` 与 `tests/integration`）。

## 产品定义

三个入口共用同一套身份、工作空间、资产版本、访问规则、检索、额度和审计规则：

| 入口 | 职责 |
| --- | --- |
| Web | Agent 工作台（收集、整理、使用资产，管理频道）；频道与用户主页（浏览、阅读、收听、提问、评论、订阅）；在线试用 |
| A2A + Agent Card | 其他 Agent 发现（Agent Card）并调用（A2A）平台、用户、频道三个层级的 Agent（P1 / P2） |
| REST API（`/v1`） | 现有检索与管理接口，供网站内部、测试与脚本化管理使用，不对外宣传；CLI / SDK 只封装它 |

对外只宣传三个出口：**频道**（给人看）、**Agent Card**（给 Agent 发现）、**A2A**（给 Agent 调用）。

核心价值：**最新**（按来源变化创建不可变版本）、**可信**（公开频道里的来源型资产经过认领）、**可追溯**（每段上下文保留来源、文档、章节和版本）、**可独立验证**（版本摘要上链，第三方不调用本平台接口即可校验）、**可治理**（工作空间可限制可访问内容，名单可写频道 ID）、**可委托**（Agent 替用户操作资产与频道，有副作用的操作必须经人确认）、**可预测计费**（按 Call，谁发起谁付）。

术语：产品里只有「数据资产」（简称资产）这一个顶层概念，「知识库」不再出现；代码、表名、REST 路径里原来的 `library` / `libraryId` 已在 P5 统一改为 `asset` / `assetId`（迁移 0066 之前的迁移文件保留旧名）。

## 文档地图

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [agent-first-proposal.md](./agent-first-proposal.md) | 转向 Agent 优先：按来源分类型的数据资产、频道与 20% 管理费的订阅、三层 Agent Card 与 A2A；下线网站插件、分享页、MCP，取消 Pro、专家库与发布者分成 | 实施中（P0–P4 已完成，P5 未开始） |
| [requirement.md](./requirement.md) | 产品边界、用户行为、套餐、接口契约、验收标准 | 基线（4.0，已按提案改写） |
| [architecture.md](./architecture.md) | 运行基座、数据模型、检索、计量、A2A Server、部署与发布 | 基线（4.0，已按提案改写） |
| [aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md) | 链上版本、审计与结算单存证 | 基线 |
| [playground-agent-proposal.md](./playground-agent-proposal.md) | 在线试用的 Agent 模式：模型自行规划检索 | 基线 |
| [library-build-billing.md](./library-build-billing.md) | 构建计量 | 基线 |
| [publisher-revenue-share.md](./publisher-revenue-share.md) | 发布者调用分成的完整设计 | **废止**（2026-10-29，由频道订阅与频道收入结算取代） |
| [expert-library-prd.md](./expert-library-prd.md) | 专家库审批与分成资格 | **废止**（2026-10-29） |
| [expert-data-track-proposal.md](./expert-data-track-proposal.md) | 专家训练数据、授权交付与专业评测的集成方案 | MVP 后扩展，待评审 |
| [self-hosting-proposal.md](./self-hosting-proposal.md) | Docker 私有部署形态：镜像、编排、与托管版的差异 | 待评审 |
| [review-visibility-proposal.md](./review-visibility-proposal.md) | 公开审核的三层审核方案 | 待评审（发布前审核已取消，不再进入基线） |
| `knowleg-market.pen` | 设计稿，27 个画板（Pencil 格式，需用 Pencil 打开） | — |

冲突时的决策顺序以 [requirement.md](./requirement.md) 第 1 节为准：产品规则 → 设计稿 → 架构约束 → 旧文档与旧设计稿。本文只是索引，不是权威来源。

## 技术栈

| 关注点 | 选型 |
| --- | --- |
| Web 与 BFF | Next.js App Router（Vercel 原生） |
| 运行环境 | Vercel Functions |
| 业务数据库 | Neon Postgres + Drizzle |
| 关键词检索 | Postgres 全文检索 + BM25 |
| 向量检索 | 同库 pgvector，**与 Chunk 同事务** |
| 对象存储 | Vercel Blob 私有 Store，保留 S3 兼容实现作退路 |
| 长任务 | Vercel Workflows |
| 边缘态 | Upstash Redis，**只做**匿名限流与检索缓存 |
| 答案生成 | 外部 LLM Provider，只用于在线试用、Agent 工作台、频道 AI 分身和 A2A `ask`，不进入 REST 与 A2A `search_context` 链路 |
| Agent 协议 | A2A Protocol v1.0（`@a2a-js/sdk` v1.x），三层 Agent Card，任务存 Postgres（P1） |
| 链上存证 | Aptos 主网，签名密钥由环境变量持有，账户只留 Gas 余额 |

选型理由和被否决的替代方案记录在 [architecture.md](./architecture.md) 第 1.2 节。其中最关键的一条：Chunk 正文、全文索引和向量在同一个 Postgres 事务内，因此发布是真正的 ACID 事务，不存在跨系统的中间态。

## 套餐

以 USD 计价，只有一档加 Additional Calls，不设 Pro 与 Enterprise。

| 能力 | 规则 |
| --- | --- |
| 每月免费额度 | 1,000 Calls，当账期有效，期末清零 |
| Additional Calls | 任何用户都可以购买，$5 / 5,000 Calls，一次性，**不过期**，跨账期结转 |
| 工作空间总容量 | 默认 500 MB；订阅过任意频道或买过 Additional Calls 后永久提升到 2 GB |
| 资产数、频道数 | 不单独设上限，只受总容量约束 |
| 有效 API Key | 20 个 |

扣减顺序固定为「先免费额度、后 Additional Calls 余额」。公开频道里的免费资产全部可查，无需购买；谁发起谁付 Call，匿名访问由平台承担并走匿名限流，频道所有者不为访客付 Call。

## 频道订阅与结算

发布者按检索次数分成已取消。创作者的回报是**频道订阅**：为频道设月付、年付方案（任一笔交易不低于 $5），re0 用自己的 Paddle 账户收款，创作者拿不含税金额的 80%，平台收 20% 管理费并承担 Paddle 手续费；按月结算、120 天持有期、满 $20 可申请 PayPal 提现或不设门槛转为 Additional Calls；收益数据不进入检索与频道目录排序。P3a 落地，开工前提与完整规则见 [agent-first-proposal.md](./agent-first-proposal.md) 第 6.9 节和 [requirement.md](./requirement.md) 第 4.4 节。

## 所有权认领

把来源型资产（网站、GitHub 库）放进**公开频道**之前必须先认领。认领要回答的不是「你是谁」，而是「你是否控制这个来源」——OAuth 只建立身份，不代表发布权。不属于频道的资产不要求认领。

| 来源类型 | 验证方式 |
| --- | --- |
| GitHub 库 | 仓库权限校验（要求 `admin` 或 `maintain`），备选 DNS TXT |
| 网站 | DNS TXT 记录，备选 well-known 文件 |
| 上传文件、Notion 文章、文章、音频、问答 | 不适用，创建者即所有者 |

**在 `re0.json` 里放公钥不会授予任何权限**：配置文件的可写范围与来源的控制权不等价，Fork、PR、镜像站都能写那个文件。完整规则见 [requirement.md](./requirement.md) 第 7.3 节，授权链路约束见 [architecture.md](./architecture.md) 第 5.4 节。

## 链上存证

已发布 Version、每日审计链头和已关账的创作者结算单，摘要写入 Aptos 主网。链上**只有摘要**，没有资产正文、Query、用户标识或任何资金。

存证是旁路能力：链或签名账户不可用时，发布、刷新、检索、计量、下架和出账全部不受影响，存证状态停留在待存证。存证不消耗 Call 额度，所有用户包含。A2A 结果的 `data` Part 随每条引用附带版本锚点，调用方 Agent 用公开 Verifier 即可独立核对。

**存证只证明「某时刻的内容就是这一份」，不构成对内容正确性的保证**；对结算单只证明锚定后未被改写，不证明分配算得对。完整设计见 [aptos-anchoring-proposal.md](./aptos-anchoring-proposal.md)。

## 环境准备

`development` / `preview` / `production` 共用同一个 Neon Project，库按环境分支：**production 用主分支；每个预览部署自动建一个 `preview/<git 分支>` 子分支（主分支的写时复制，部署销毁时回收）；本地开发连常驻的 `dev` 子分支**（在 Neon Console 建子分支时 Auto-delete 要改成 Never）。预览分支上的新迁移由 `vercel.json` 的 `buildCommand` 在构建前执行，只在 `VERCEL_ENV=preview` 时触发；生产的迁移不在构建里跑。对象存储跟着一起分：`recall0-blob` 只连 Production，`recall0-blob-preview` 连 Preview，`recall0-blob-dev` 连 Development。其余外部依赖仍按环境隔离：

- Upstash Database 与 REST Token
- OAuth Client、Payment Environment 和 Provider Key
- LLM Provider Key
- Aptos 账户与 Anchor Signer 私钥（非生产使用 Testnet）
- Workflow 名称与 Webhook Secret

反过来，凡是加密或哈希落库内容的 Secret，三套环境必须取同一个值：`SESSION_SIGNING_SECRET`（GitHub / Notion 授权令牌的封装、管理员邀请哈希与落库 TOTP 种子的封装）、`API_KEY_HASH_SECRET`、`CREDENTIAL_ENCRYPTION_KEY`。各持一份的话，一个环境写下的行在另一个环境打不开。

**禁止把 Production 数据复制到 Preview**——不属于频道的资产里是用户授权的 Notion 页面与私密文件，测试数据必须脱敏或由 Fixture 生成。

对象存储用 Vercel Blob：每个环境一个私有 Store，各自连到对应环境，`BLOB_READ_WRITE_TOKEN` 会自动注入；本地用 `vercel env pull` 拉取。分开是必须的而不是讲究——预览分支是主分支的写时复制，行里的 Key 指向生产对象，共用一个 Store 时在预览里删掉一项资产就会删掉生产的文件。代价是预览里那些从生产复制来的行读不到对象（Store 里没有），这在预览分支换成 schema-only 之后自然消失。Dashboard 的 PDF 导入向导由浏览器直接上传到 Blob（服务端只签发限定路径、类型和大小的 Client Token），不经过应用，也就不受请求体大小限制，不需要额外的 CORS 配置。Blob 没有生命周期规则，向导中途放弃的上传会留在 `uploads/` 前缀下，由 drain 每次收尾时清理超过 24 小时且未被引用的对象，也可以用 `npm run uploads:purge` 手动跑。未设置 `BLOB_READ_WRITE_TOKEN` 时，代码退回 `OBJECT_STORE_*` 描述的 S3 兼容 Bucket，那时 Bucket 要允许来自应用 Origin 的跨域 `PUT`。

构建任务在创建资产、改文件、后台刷新等动作的响应返回后立即执行（`after(runOperation)`），所以本地开发不需要额外进程；`vercel.json` 里的 Cron 每 10 分钟调用一次 `/api/cron/drain`（需要 `CRON_SECRET`）作为兜底，负责重试失败任务和清扫废弃上传；每小时第 17 分钟调用一次 `/api/cron/retention`，清除超过 30 天的 A2A 任务正文（入站任务与出站委托，只留 ID、状态与计量），并按各工作空间设置的保留期删除过期的私有资产。这个 Cron 同时也是平台资产的自动刷新调度：每次先按各来源的刷新策略（每日 / 每周）把到期的来源排入队列，再执行队列。队列的实时状态、最近完成的记录和各来源的下次刷新时间在管理后台的「刷新队列」页（`/admin/refresh-queue`）查看。本地没有 Cron，可以用 `npx tsx` 调 `scheduleDueRefreshes()` 和 `drainOperations()`，或直接在后台按「排队刷新」。

上传文件资产可以在创建时就上传 PDF，也可以先建空资产、之后在列表页该资产的「管理 PDF 文件」页随时增删文件；保存后会排队重新构建，新版本发布前旧版本继续提供检索。没有文件的资产不排队构建。PDF 单文件上限 30 MB，每项资产最多 20 个文件。构建时用 pdf.js 抽取文本层；扫描件没有文本层，需要配置 OCR 服务才能索引：设置 `OCR_PROVIDER=ocrspace` 和 `OCR_PROVIDER_API_KEY`（[ocr.space](https://ocr.space/ocrapi)，免费 Key 限 1 MB、3 页，PDF 套餐才放开到 100 MB、999 页，付费套餐的区域端点填 `OCR_PROVIDER_BASE_URL`；中文扫描件设 `OCR_PROVIDER_LANGUAGE=chs`）。OCR 只在至多一半页面有文本层时触发，文件不经过应用之外的任何临时 URL，直接以 multipart 送给厂商。未配置时扫描件构建会以 `parse_failed` 结束。OCR 是 `lib/infrastructure/connectors/ocr.ts` 里的一个 Provider 接口，换厂商只改这一处。

平台资产也可以是上传文件类型：在管理后台「创建平台资产」里选 PDF，文件直传对象存储；创建后在详情页的「PDF 文件」面板增删，保存即排队重新构建。一项资产只对应一个来源，不再给已有的网站 / GitHub 资产追加 PDF 来源。平台上传文件资产不按时间刷新，引用链接走公开的 `/files/{fileId}`。

完整环境变量清单见 [architecture.md](./architecture.md) 第 19.1 节。Paddle 只需要 Additional Calls 一个商品（`PADDLE_ADDON_PRODUCT_ID`）；Pro 套餐已删除，**不再需要 `PADDLE_PRO_PRODUCT_ID`**，频道订阅的商品在 P3a 加入。网站插件、分享页、MCP 由开关控制，默认关闭。Secret 不得进入前端 Bundle，只允许在 Server Component、Route Handler 和 Workflow 中读取。Anchor Signer 私钥不出现在任何环境变量里。

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
| `CREDENTIAL_ENCRYPTION_KEY` | 至少 32 字符。加密落库的凭证：控制台保存的模型 Key、A2A 推送配置的 Token，以及用户在「外部 Agent」里为外部 A2A Agent 保存的 Bearer 令牌或 API Key（P4，用途标签与模型 Key 分开，两类密文互相打不开）。不设置时这些都无法保存；三套环境必须同值，轮换后已存凭证需重新录入 |
| `CRON_SECRET` | Vercel Cron 调用 `/api/cron/drain`、`/api/cron/anchor` 与每小时的 `/api/cron/retention`（A2A 任务正文 30 天清除、私有资产保留期）时携带的 Bearer；本地不跑 Cron 时可留空 |

两个 Provider 需要登记的回调地址：

```text
http://localhost:3000/api/auth/github/callback
http://localhost:3000/api/auth/google/callback
```

向导导入 GitHub 仓库时还有第二个回调，GitHub App 要求回调地址精确匹配，必须一并登记（Developer settings → 该应用 → Add callback URL）：

```text
http://localhost:3000/api/auth/github/callback/connect
```

向导导入 Notion 页面时同样先绑定账号：需要一个 Notion **public integration**（`NOTION_OAUTH_CLIENT_ID` / `_SECRET`），登记的 Redirect URI 为 `http://localhost:3000/api/auth/notion/callback/connect`。用户在 Notion 授权页选择共享给 re0 的页面，向导只列这些页面，之后的刷新也用同一份授权读取；令牌加密存于 `notion_connection` 表。管理后台的平台 Notion 资产仍用 `NOTION_INGESTION_TOKEN`（internal integration）。

`npm run db:migrate` 打的是 `.env.local` 里的那条串，也就是 `dev` 分支——本地迁移不再碰生产。主分支（production 与 preview 共用）的迁移要显式指向它：

```bash
DATABASE_URL_UNPOOLED='<主分支直连串>' npm run db:migrate
```

顺序按 [architecture.md](./architecture.md) 第 19.2 节排：主分支先迁移，再发布依赖新 Schema 的代码。

新增迁移时，`db/migrations/meta/_journal.json` 里新条目的 `when` 取上一条加 `100000000`，不用 `Date.now()`：0058 起的值是手工递增的，已经排到未来，而 `drizzle-kit migrate` 只执行 `when` 严格大于库里最后一条记录的迁移，戳小了会被静默跳过（CI 用 psql 逐个执行文件，测不出来）。两个分支各加一条迁移时，合并后重新编号。`tests/contract/migration-journal.test.ts` 校验这条规则以及条目与 SQL 文件一一对应。

`0002_seed_plans.sql` 会写入免费档的 Plan Version（Pro 档已在 P0 的迁移中删除）——首次登录要在同一个事务里创建免费订阅行，因此迁移必须先于任何流量执行。

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

MVP 的 14 步已经实现（见 [architecture.md](./architecture.md) 第 21 节）。之后按 [agent-first-proposal.md](./agent-first-proposal.md) 第 13.1 节分阶段：

1. **P0** 文案与清理：slogan、OG 图、界面文案改为资产；删除 Pro、专家库、自检问题、按检索计的分成、`llms.txt` 与 OpenAPI；关闭网站插件、分享页、MCP；Additional Calls 对所有人开放；两级容量
2. **P1** 资产类型与数据重建、频道、频道目录、用户主页、三层 Agent Card、A2A `find_channels` / `search_context`、Postgres 任务存储、首页改版
3. **P2** Agent 工作台、工具与确认门、A2A `ask` / `ingest` / `refresh` / `publish`、扩展卡、推送通知
4. **P3a** 文章、评论、问答、频道订阅与收入结算（开工前提：Paddle 书面确认、手续费口径、税务与合规意见）；**P3b** 音频
5. **P4** re0 作为 A2A 客户端；**P5** 内部改名（`library` → `asset`，已完成）

## 开发约定

这些约束在 [architecture.md](./architecture.md) 里是硬性的，实现时不要绕开：

- **Route Handler、Agent 工具和 A2A `AgentExecutor` 只能调用 `lib/application` 的 Use Case**，不直接碰数据库；
- **`contracts` 是 REST、A2A、SDK、CLI 和前端共同的权威类型来源**；
- **Provider SDK 只允许出现在 `lib/infrastructure` 和 Workflow 里**；Domain 不依赖 Next.js、Vercel、Neon、Payment、AI SDK 或链 SDK；
- **额度计数不得迁移到 Redis 或任何缓存层**——Reservation 与 Usage Event 是计费事实，必须与业务库同事务；谁发起谁付 Call，匿名不产生 Usage Event；
- **查询必须先按可见性授权并固定资产 Version 和 Policy Version**，再做任何召回；
- **Version 不可变**，刷新通过原子切换 `current_version_id` 发布；
- **`asset.owner_workspace_id` 只能由已验证的认领或管理员裁定写入**，Ingestion 和刷新一律不得触碰；来源型资产未认领不能放进公开频道；
- **REST 与 A2A `search_context` 不引入 LLM 依赖**——移除生成层后，两者行为必须完全不变；
- **四个生成入口零结果时不调用模型**，且答案中每条事实必须绑定到本次返回的 Chunk；
- **有副作用的 Agent 操作必须经人确认**，模型、Chunk 和其他 Agent 都不能代为确认；
- **新代码一律用 asset / channel 命名**，不再新增 `library` 标识符；
- **管理后台不能直连表**，必须经过 Admin Use Case 和 Audit Decorator。

## 待验证事项

开工前需要确认：

- 中文分词方案（Postgres 原生 FTS 需要 `zhparser`、`pg_bigm` 或退回 trigram，取决于 Neon 的扩展支持范围）；
- BM25 排序的实现路径；
- 从 Workflow 写入 100 MB 量级快照到对象存储的实际表现，需压测。

以上见 [architecture.md](./architecture.md) 第 22 节。
