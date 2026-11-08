# 生产切换方案：旧应用（`main`）→ rebuild

2026-11-08 · 待确认

把 re0.io 从 `main` 上的旧应用切到 `rebuild`。合并 PR #87（`rebuild` → `main`）会触发一次 Production 构建，构建命令先对生产库跑 `npm run db:migrate`。本文写清楚这一步在生产库上会发生什么、数据库怎么处理、Vercel 要补哪些配置、切换当天的步骤和回滚办法。

本文所有结论都来自读两条分支的代码、迁移和本地实验（附录 D）；**没有连接过生产库**。需要生产数据的地方，附录 A 给出只读 SQL，由你在 Neon SQL Editor 里执行。

---

## 0. 需要你决定的事

| # | 决定 | 选项 | 建议 |
|---|---|---|---|
| D1 | 数据库策略（§3） | (a) 新 Neon 分支、空库起步；(b) 全量数据迁移；(c) 混合：只带用户 | **(a)**。旧库原样冻结在 `main` 分支做存档和回滚。若附录 A 显示有一批值得保留的活跃用户，再在 (a) 之上加 (c) 的用户导入（附录 C，已在本地验证） |
| D2 | 旧 Paddle 订阅（旧 "Pro"）怎么处理 | 切换前在 Paddle 里立即取消并按比例退款；或到期取消；或不处理 | **立即取消并按比例退款**，在切换前做，让旧应用把取消写进旧库。不处理的话，Paddle 会继续按旧价格扣款，而新应用对这些事件一律回 `ignored`，用户付了钱什么也得不到 |
| D3 | 旧余额（Additional Calls 剩余次数）和付费用户的补偿 | 不补偿；切换后在 `/admin/users` 手工补发 credits；按某个比例批量换算 | **手工补发**。单位不同（旧是"调用次数"，新是 credits），换算比例只能由你定。名单来自附录 A 第 4 段 |
| D4 | 发布者分成欠款（`settlement` 中 `accrued` / `held` 的现金） | 切换前用旧后台人工打款结清；作废并通知；切换后线下处理 | 先看附录 A 第 5 段的金额。非零就**切换前结清**，新应用没有任何地方能看到或支付这笔钱 |
| D5 | 切换时间窗和对外通知 | 无停机分阶段切换（§5）；或挂维护页 | **无停机**。旧站一直服务到"提升"那一刻。是否提前通知旧 API key 用户和付费用户（旧 API、组件、展示页切换后全部 404）由你决定 |
| D6 | 回滚窗口多长 | 7 / 14 / 30 天 | **30 天**。期间不删旧 Neon 分支、旧 Blob 文件、旧部署，也不删旧环境变量 |
| D7 | 向量化走哪条路 | 保留 Production 的 `EMBEDDING_PROVIDER_API_KEY`（直连 OpenAI）；或删掉它改走 AI Gateway | **删掉，走 AI Gateway**，和生成、转写同一条计费路径。保留也能用，但这条路由要有供应商单价，否则知识处理会以 `pricing_unavailable` 失败（§4.3） |
| D8 | 旧公开地址要不要重定向 | 不做；把 `/libraries/*`、`/s/*`、`/playground` 等指到首页或 `/explore` | 不做，除非旧页面还有可观的访问量 |
| D9 | 上线前的非技术前提（rebuild-proposal 已列） | — | Remotion 许可（`NEXT_PUBLIC_REMOTION_LICENSE_KEY`，默认 `free-license`）、法律页法务审阅、PayPal Business 账户。不挡技术切换，但要在对外宣布前确认 |

---

## 1. 现状

**生产部署**：`recall0-fbuydbatm-virgil-zhaos-projects-cc544793.vercel.app`（`dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`，2026-10-29 构建），别名 `re0.io`、`www.re0.io`。Cron：`/api/cron/drain`（每 10 分钟）、`/api/cron/anchor`（每 15 分钟）。

**数据库**：Neon，经 Vercel 原生集成 `neon-recall0` 接到 `recall0`。Production 的 `DATABASE_URL` / `DATABASE_URL_UNPOOLED`（以及 `PG*`、`POSTGRES_*`）指向 Neon 的 `main` 分支。上面是 `main` 的 schema：迁移 `0000_init`–`0060_manual_payout`，66 张表，`drizzle.__drizzle_migrations` 61 行，最后一行 `created_at` = `1793200000000`。

**rebuild**：迁移 `0001_init`–`0033_mcp_api_keys`，从零建 48 张表。33 条的 `when` 都比 `1793200000000` 大（最小是 `0001_init` 的 `1793578769330`）。

两边重名的表只有 8 张：`user`、`chunk`、`administrator`、`admin_session`、`api_key`、`github_connection`、`payout`、`subscription`，列全都不同（附录 D 有对照方法）。两边是不同的产品模型：旧的是"工作空间 + 文档库 + 按调用计费 + 发布者现金分成"，新的是"用户 + Ree + 知识 + credits 账本"。

---

## 2. 迁移日志：`drizzle-kit migrate` 在生产构建里会怎么跑

`vercel.json`（rebuild）的 `buildCommand`：

```
if [ "$VERCEL_ENV" = "preview" ]; then npm run db:prepare-preview; fi \
 && if [ "$VERCEL_ENV" = "production" ] || [ "$VERCEL_ENV" = "preview" ]; then npm run db:migrate; fi \
 && npm run build
```

Production 构建只跑 `drizzle-kit migrate`（经 `DATABASE_URL_UNPOOLED`），`db:prepare-preview` 的重置脚本不会在 Production 里运行。

### 2.1 迁移器的规则（drizzle-orm 0.45.2 `pg-core/dialect.js` `migrate()`，drizzle-kit 0.31.10 走 `@neondatabase/serverless`）

1. 在事务外执行 `CREATE SCHEMA IF NOT EXISTS drizzle` 和 `CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations`。
2. 读日志里 `created_at` 最大的**一行**。
3. 打开**一个事务**，对 `db/migrations/meta/_journal.json` 的每一项：只要 `when` 大于第 2 步的值，就执行它的全部语句，再插一行日志。
4. 不比对 hash，也不看文件名或 tag。判断"跑没跑过"只看时间戳。

所以所有待执行的迁移在**同一个事务**里：任何一条失败，全部回滚，日志不变。rebuild 的迁移里没有 `CREATE INDEX CONCURRENTLY` 或事务语句，可以整体放进一个事务；`0001_init` 第一句是 `CREATE EXTENSION IF NOT EXISTS vector`。

### 2.2 三种库状态下的实际结果（本地 Postgres 18 + pgvector，附录 D）

| 库状态 | 结果 |
|---|---|
| **和现在的生产库一样**（按 `main` 的 61 条迁移用 drizzle-kit 建出来） | 33 条都比日志新，全部进入待执行。`0001_init` 在建 `admin_session` 时报 `relation "admin_session" already exists`，整个事务回滚：日志仍是 61 行，66 张表原样不动。`drizzle-kit migrate` 退出码 1，**终端只有转圈，不打印错误**。Vercel 构建失败，当前生产部署继续服务。也就是说，误合并 #87 不会破坏生产，只会得到一次失败的构建 |
| **空库**（新 Neon 分支清空后，或 `main` 清空后） | 33 条在一个事务里全部执行（本地约 1.7 秒），得到 48 张表和 `vector` 扩展，日志 33 行，最后 `1794149110765`。再跑一次是空操作。用 drizzle-kit CLI 本身跑也是退出码 0 |
| **只删了 `public`、留着 `drizzle` 日志** | 33 条都比旧日志新，照样会全部执行并成功，但日志里留着 61 行旧记录。不要这样做：清库时连 `drizzle` schema 一起删（附录 B） |

### 2.3 各数据库方案下，第一次 Production 构建要满足什么

- **(a) / (c)**：构建开始时，Production 的 `DATABASE_URL_UNPOOLED` 必须已经指向一个**空**库（没有 `public` 里的旧表，没有 `drizzle` schema）。满足这一条，`vercel.json` 不用改。
- **(b) 全量迁移**：不能让构建去迁旧库。只能先在别处建好新 schema、导入数据，再让 Production 指过去，届时构建看到的是"已迁移到 0033"的库，`migrate` 是空操作。
- (c) 的用户导入必须在新 schema 建好**之后**、站点切过去**之前**做。下面 §5 的"暂存部署"（staged production deployment）正好提供这个间隙：构建已经在新库上建好表，但 re0.io 还在旧部署上。

---

## 3. 数据库策略

### 3.1 三个选项

**(a) 新 Neon 分支，空库起步（建议）**

- 在 Neon 里从 `main` 建一个新分支（例如 `production-rebuild`），在新分支上清空 `public` 和 `drizzle`（附录 B），然后在 Neon 控制台 → Integrations → Vercel → Branches 把 **Production branch** 改成它。
- `main` 分支从此不再被写入，作为旧数据的完整存档。
- 回滚最干净：Vercel 的 Instant Rollback 不重新构建，旧部署用的是它构建时的环境变量，也就是指向 `main` 的那组连接串。回滚后旧应用直接回到原封不动的旧库。
- 代价：所有人重新登录；旧用户第一次用同一个 Google / GitHub 账号登录时会被当成新用户，自动拿到新用户赠送的 credits（默认 100,000）；旧的库、余额、订阅、API key 都不带过来。

**(b) 全量数据迁移：不建议，也基本做不到**

两边的核心对象不对应（§3.2）：旧的"文档库 / 版本 / 文档 / 切块"是公共文档索引，按工作空间归属；新的 Ree 是某个用户的、带个性和定价的对话角色。硬把文档库转成 Ree，得到的是没有个性、没有定价、需要全部重新向量化的空壳；旧的按调用计费和现金分成在新账本里没有对应的语义。工作量大、正确性无法验收，收益接近零。

**(c) 混合：只带用户（可选，加在 (a) 上）**

只把旧的 `user` + `oauth_account` 转成新的 `user` 行，并照新用户注册的方式发欢迎 credits，其余都不带。效果：

- 用户第一次登录时进入一个"已存在"的账号，`created_at`、显示名、头像沿用旧的；被封禁的旧账号保持封禁。
- 能做的也就这些。登录后的体验和 (a) 几乎一样，(a) 下用户同样会在第一次登录时自动建号并拿到欢迎 credits。
- 新模型一个账号只对应一个登录方式（`user` 上的 `provider` + `provider_subject` 唯一）。旧库里同时绑了 Google 和 GitHub 的用户会变成**两个**新账号。
- 只有在你想保留"注册时间"或旧的封禁名单时才值得做。附录 C 有导出 / 导入脚本，已在本地验证。

### 3.2 旧表 → 新表，逐表对照

"(c)" 一列说混合方案带不带。没有标 "带" 的，在 (a) / (c) 下都留在旧 `main` 分支里存档，不进新库。

| 旧表（`main`） | 新 schema 里的去处 | (c) | 说明 |
|---|---|---|---|
| `user` | `user` | 带 | `display_name` → `name`（空时取邮箱 @ 前部分，截到 40 字）；`avatar_url` → `avatar_blob`（新列在用户上传头像前本来就存 provider 的头像 URL）；`status <> 'active'` → `disabled_at`；`created_at` 沿用。旧 `id` 不保留，新库生成新 uuid |
| `oauth_account` | 合并进 `user.provider` / `provider_subject` | 带 | 每个 `oauth_account` 一行新 `user`；`last_login_at` 沿用 |
| `user_session` | `session` | 不带 | 新 `session.id` 是 cookie token 的摘要，格式和 cookie 都不同。所有人重新登录 |
| `github_connection` | `github_connection` | 不带 | 旧的是 OAuth App token，用旧 cookie key 封装；新的走 GitHub App（`GITHUB_APP_*`）。用户在新应用里重新连接 |
| `notion_connection` | 无 | — | Notion 导入在 rebuild 里没有 |
| `workspace`, `workspace_member` | 无 | — | 新模型按用户，没有工作空间和团队成员 |
| `api_key` | 无（新 `api_key` 是 MCP key） | 不带 | 旧 key 属于工作空间、调旧的 `/api/v1`；新 key 属于用户、调 `/api/mcp`，摘要算法也不同。旧 key 切换后全部失效 |
| `request_log` | 无 | — | |
| `plan`, `plan_version` | 无（`billing_price` + `lib/constants.ts`） | — | |
| `subscription` | `subscription`（列不同） | 不带 | 旧订阅是旧 "Pro" 产品的 Paddle 订阅，新 webhook 认不出它的价格，一律 `ignored`。见 D2 |
| `addon_grant` | 无（新的是 `credit_grant`） | 不带 | 余额单位是调用次数，见 D3 |
| `payment_event` | `billing_event` | 不带 | 历史留在旧库 |
| `billing_document`, `payment_checkout` | 无 / `paddle_checkout` | 不带 | |
| `usage_reservation`, `usage_event`, `usage_summary`, `llm_cost_event` | 无（新的是 `credit_hold` / `credit_entry` / `model_call`） | — | |
| `publisher_account`, `earning_event`, `revenue_period`, `settlement`, `payout` | 无（新 `payout` 是 credits 提现，要求 `kyc_record` 通过） | — | 旧的是现金分成。未结清的钱见 D4 |
| `library`, `library_alias`, `source`, `library_version`, `document`, `chunk`, `library_profile`, `library_profile_vector`, `library_score`, `library_eval_question`, `library_faq`, `library_review`, `report` | 无（概念最接近的是 `ree` / `knowledge` / `chunk`，但不能转换） | — | 见 (b)。作者可以在新应用里用 URL / GitHub / 文件重新导入知识 |
| `library_claim`, `domain_verification`, `expert_application` | 无（最接近的是 `domain_claim` / `verification_request`） | — | 认领对象（文档库）不存在了 |
| `policy_version`, `policy_library_entry`, `review_config` | 无 | — | |
| `site_key`, `site_key_origin`, `widget_exchange`, `library_showcase`, `library_showcase_daily`, `showcase_lead`, `showcase_domain` | 无 | — | 嵌入组件和展示页在 rebuild 里没有；装在客户网站上的组件切换后失效 |
| `llm_config`, `provider_model_config`, `llm_audience_assignment`, `retrieval_config`, `render_config`, `render_provider_key` | `model_config` / `firecrawl_key` / `provider_pricing`（结构不同） | — | 在新后台重新配置（§5 步骤 9） |
| `anchor_batch`, `anchor_leaf` | 无 | — | Aptos 存证已去掉；已上链的记录还在链上，库里的对应行留在旧库 |
| `workflow_operation` | 无 | — | 旧 `drain` cron 处理的任务队列。切换时还在排队的构建任务直接作废 |
| `administrator`, `admin_session`, `admin_role`, `admin_permission`, `administrator_role`, `audit_log` | `administrator` / `admin_session` / `admin_audit`（结构不同） | 不带 | 新后台在空库上由第一个访问 `/admin/login` 的人注册（密码 + TOTP），见 §5 步骤 9 |

新库里没有旧来源、从空开始的表：`ree*`、`knowledge*`、`conversation*`、`message`、`answer_check`、`synthesis*`、`credit_*`、`purchase`、`paddle_checkout`、`billing_event`、`billing_price`、`signup_reward`、`video_*`、`kyc_record`、`notice`、`rate_bucket`、`reembed_job`、`model_call`、`knowledge_cost_run`、`provider_pricing`、`firecrawl_key`、`model_config`、`verification_request`、`domain_claim`。

### 3.3 逐项影响

- **登录态**：全部失效，所有人重新登录。OAuth 回调路径两边一样（`/api/auth/{google,github}/callback`），Google / GitHub OAuth App 不用改。
- **API key**：旧 key 全部失效（旧 `/api/v1` 不存在了）。新 MCP key 在 `/settings?tab=api` 里重新生成，接入方式见 `docs/mcp.md`。附录 A 第 6 段能查出 30 天内还在用的 key 数。
- **余额**：旧 Additional Calls 余额和 Pro 当期额度都不带。每个新账号首次登录得到欢迎 credits；需要额外补偿的，切换后在 `/admin/users` 用"调整 credits"补发（有审计、有站内通知），名单见附录 A 第 4 段。
- **Paddle 订阅**：见 D2。新 webhook 对旧产品的 `transaction.*` / `subscription.*` / `adjustment.*` 都回 `ignored`（`docs/handover/step3.md`），所以切换前后在 Paddle 里取消或退款都不会弄乱新库；切换前做，旧库里也有记录。
- **Blob 文件**（`recall0-blob`，私有存储）：两边路径前缀不重叠。旧的是 `sources/`、`uploads/`、`manifests/`、`normalized/`、`quarantine/`、`showcase/`；新的是 `avatars/`、`knowledge/`、`kyc/`、`ree-covers/`、`video/`、`videos/`、`video-narration/`。新应用不会读也不会删旧文件（`purge-kyc-files` 只扫 `kyc/`）。回滚窗口结束后按旧前缀删除即可。
- **Cron**：Vercel 的 cron 跟着"当前生产部署"走。提升 rebuild 的那一刻，`drain` / `anchor` 停，新的六个开始：`purge-trash`（03:30）、`expire-plan`（00:15）、`rank`（每小时第 7 分）、`reembed`（每 10 分钟）、`purge-kyc-files`（03:45）、`abandon-exports`（每 15 分钟），都校验 `CRON_SECRET`。回滚时 Vercel 恢复旧部署的 cron 定义。

---

## 4. Vercel Production 环境变量

下面的"Production 现有"来自 `vercel env ls production`（只看变量名，没有读取值）。"rebuild 读取"来自对 `rebuild` 上 `app/`、`lib/`、`scripts/`、`components/`、`video/` 中 `process.env` / `env.X` 的 grep，以及代码里用变量名查的回退链（`lib/infra/crypto/secrets.ts`、`lib/infra/ai/models.ts`、`lib/infra/paddle.ts`）。

### 4.1 rebuild 读取的变量

| 变量 | Production 现有 | 处理 |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | 有（Neon 集成管理） | 改 Neon 集成的 Production branch 后自动换成新分支的连接串（§5 步骤 6）。只对之后的新部署生效 |
| `AUTH_SECRET` | 无 | 回退到 `SESSION_SIGNING_SECRET`（有，需 ≥ 32 字符）。可以不加 |
| `ADMIN_SECRET_KEY` | 无 | 回退到 `CREDENTIAL_ENCRYPTION_KEY`（有）。新库里的模型 key、Firecrawl key、TOTP 密钥都用它加密，**切换后不能再改它** |
| `APP_BASE_URL` | 有 | 确认值是 `https://re0.io`。OAuth 回调、Paddle checkout 地址、同源校验都从它来 |
| `BLOB_READ_WRITE_TOKEN` | 有 | 不变（`recall0-blob`，私有存储，两边都用 `access: 'private'`） |
| `CRON_SECRET` | 有 | 不变 |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`, `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | 有 | 不变，回调地址不变 |
| `GITHUB_APP_CLIENT_ID` / `_SECRET` | 有（6 天前加） | 确认这个 GitHub App 的 callback URL 包含 `https://re0.io/api/auth/github/callback/connect` |
| `GITHUB_APP_SLUG` | **无** | 建议加上。缺了"连接 GitHub"的安装链接会退回 `https://github.com/settings/installations`，用户得自己找到这个 App |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN` | 有 | 确认 API key 有 transaction、subscription、`price.read`、`price.write` 权限（`/admin/pricing` 会创建价格） |
| `PADDLE_PLAN_PRICE_ID`, `PADDLE_PACK_PRICE_ID` | 有（6 天前加） | 确认是**正式环境 catalogue** 里新建的 Plan / Pack 价格，不是 sandbox 的 `pri_01m6dd9…`。五项缺任何一项，整个计费就是"未配置" |
| `PADDLE_ENVIRONMENT` | 有 | 确认值不是 `sandbox` |
| `PADDLE_CHECKOUT_BASE_URL` | 无 | 不用加，回退到 `APP_BASE_URL` |
| `AI_GATEWAY_API_KEY` | 无 | 在 Vercel 上可以不加：代码在 `VERCEL=1` / 有 `VERCEL_OIDC_TOKEN` 时走 OIDC 认证。前提是团队已启用 AI Gateway 且有余额 |
| `GENERATION_MODEL` / `EMBEDDING_MODEL` / `TRANSCRIPTION_MODEL` / `SPEECH_MODEL`，`LLM_BASE_URL` / `LLM_API_KEY`，`SPEECH_API_KEY`，`OPENAI_API_KEY` | 无 | 都可以不加。后台 `/admin/models` 没有配置时用默认值 `openai/gpt-5-mini`、`openai/text-embedding-3-small`、`openai/whisper-1`、`openai/tts-1`，经 AI Gateway |
| `EMBEDDING_PROVIDER_API_KEY` | **有**（旧应用留下的） | 见 D7 和 §4.3 |
| `EMBEDDING_PROVIDER_BASE_URL` | 无 | 有 key 没 base URL 时默认 `https://api.openai.com/v1` |
| `FIRECRAWL_API_KEY`, `FIRECRAWL_BASE_URL` | **无** | 二选一：加 `FIRECRAWL_API_KEY`，或切换后在 `/admin/firecrawl` 录入 key（推荐，支持多 key 和备用 key）。生产用托管的 `https://api.firecrawl.dev`，不设 `FIRECRAWL_BASE_URL`。都没有的话 PDF / Word / 网页抓取不可用 |
| `PROVIDER_COST_RATES` | 无 | 不用加。内置默认价只覆盖 `api.firecrawl.dev` 的 `parse`；其他供应商单价在后台配置 |
| `CLAIM_DNS_RESOLVERS` | 无 | 不用加（域名认领的 DNS 解析器，可选） |
| `NEXT_PUBLIC_REMOTION_LICENSE_KEY` | 无 | 默认 `free-license`，见 D9。这是构建期变量，要在合并前加 |
| `PRODUCTION_DATABASE_ENDPOINTS` | 有（6 天前加，只在 Production） | 把新分支的 endpoint id 加进去（保留 `main` 的）。它只被 Preview 构建里的重置脚本读，用来拒绝清空生产库；Preview 部署已停用，这里只是保持准确 |
| `E2E_LOGIN_SECRET`, `DATABASE_WS_PROXY` | 无 | **不要加**。前者只在 `next dev` 下生效，后者只给本地 Docker 库用 |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_OIDC_TOKEN`, `NODE_ENV` | 系统 | — |

### 4.2 只有旧应用读的变量（切换后无用）

`API_KEY_HASH_SECRET`、`BUILD_BILLING_MODE`、`NOTION_OAUTH_CLIENT_ID` / `_SECRET`、`OCR_PROVIDER`、`OCR_PROVIDER_API_KEY`、`OCR_PROVIDER_BASE_URL`、`RENDER_PROVIDER`、`RENDER_PROVIDER_API_KEY`、`LLM_PROVIDER_API_KEY_AGNES`、`LLM_PROVIDER_API_KEY_MINIMAX`、`PADDLE_PRO_PRODUCT_ID`、`PADDLE_ADDON_PRODUCT_ID`。

`NEON_AUTH_BASE_URL`、`VITE_NEON_AUTH_URL` 两边都不读，由 Neon 集成管理，不用动。`POSTGRES_*`、`PG*` rebuild 不读（重置脚本只用它们识别生产库），由集成管理。

**回滚窗口结束前一个都不要删。** 删除不影响已构建的旧部署（它带着构建时的变量），但万一要重新构建旧代码就需要它们。

### 4.3 向量化路由（D7）

Production 里留着旧应用的 `EMBEDDING_PROVIDER_API_KEY`。rebuild 看到它，会把向量化从 AI Gateway 改成直连 `https://api.openai.com/v1`（`text-embedding-3-small`，1536 维，和新 `chunk.embedding` 一致）。直连端点没有 Gateway 报回的实际费用，计费要先找到这条路由的单价：后台或 `PROVIDER_COST_RATES` 里配置的价格，或者公开价格目录里查到的价格。都没有就抛 `pricing_unavailable`，知识处理失败（`lib/infra/ai/provider-meter.ts`、`docs/handover/knowledge-billing.md`）。

- 建议：合并前从 Production 删掉 `EMBEDDING_PROVIDER_API_KEY`，向量化走 Gateway。旧部署不受影响。
- 如果保留：切换当天在暂存部署上传一份文档（§5 步骤 9），确认能处理到 ready；不行就在 `/admin/models` 配好向量化条目和单价。

### 4.4 Paddle

- Webhook 路径两边一样：`https://re0.io/api/billing/paddle`。现有的正式环境 notification destination 可以继续用，同一个 `PADDLE_WEBHOOK_SECRET`。确认它订阅了 `transaction.paid`、`transaction.completed`、`subscription.*`、`adjustment.created`、`adjustment.updated`。
- Checkout：确认 `re0.io` 是已批准的 checkout 域名，默认支付链接是 `https://re0.io/checkout`（两边都有这个页面）。
- 产品：新应用只认 `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID` 和 `/admin/pricing` 之后创建的价格。旧的 "Pro" / "Additional Calls" 产品留着不动，也不再使用。
- 暂存部署上没法测购买：checkout 地址取自 `APP_BASE_URL`，会落到还在旧部署上的 re0.io。购买放到提升之后验证（§5 步骤 12）。

---

## 5. 切换当天的步骤（按方案 (a)，(c) 的额外步骤已标出）

思路：先让 Production 构建在新分支上建好表、停在**暂存**状态（不挂 re0.io），在暂存地址上把后台配好，再一键把域名切过去。旧站一直服务到切换那一刻。

### 准备（可以提前几天做，不影响线上）

1. **在生产库上跑附录 A**（只读），确定 D1–D4。
2. **处理 Paddle 旧订阅（D2）和发布者欠款（D4）**，在旧后台和 Paddle 里完成。
3. **Paddle 正式环境**：按 §4.4 检查 notification destination、checkout 域名、默认支付链接，以及 `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID` 是否为正式 catalogue 的价格。
4. **Vercel 环境变量**（Production）：加 `GITHUB_APP_SLUG`；按 D7 删 `EMBEDDING_PROVIDER_API_KEY`；按需加 `FIRECRAWL_API_KEY`、`NEXT_PUBLIC_REMOTION_LICENSE_KEY`。确认 `APP_BASE_URL`、`PADDLE_ENVIRONMENT`。确认团队已启用 AI Gateway 且有余额。
5. **Neon**：从 `main` 建分支 `production-rebuild`（含当前数据或 schema-only 都行，反正要清空）；给它一个读写 compute，规格和自动暂停设置与 `main` 相同；不要设过期时间。在它上面执行附录 B。**动手前核对 SQL Editor 里选中的是新分支**，附录 B 第一句会打印分支上的旧表情况，`main` 上永远不要执行。

### 切换

6. **Neon 控制台 → Integrations → Vercel → Manage → Branches**：Production branch 改成 `production-rebuild`，保存。现在的生产部署不受影响（变量是构建时固定的）。用 `vercel env ls production` 看 `DATABASE_URL` / `DATABASE_URL_UNPOOLED` 的更新时间变了即可（不要 pull 值）。顺手把新 endpoint id 加进 `PRODUCTION_DATABASE_ENDPOINTS`。
7. **Vercel → Settings → Environments → Production → Branch Tracking**：关掉 **Auto-assign Custom Production Domains**。之后 `main` 的构建只生成暂存部署，不会自动接管 re0.io。
8. **合并 PR #87**。Production 构建在 `production-rebuild` 上跑 33 条迁移（一个事务），再 `next build`。构建日志里应看到 `migrations applied successfully!`。若构建失败，re0.io 不受影响，修好后重新部署即可。
   - 核对迁移落在了哪：在 Neon 上查 `select count(*), max(created_at) from drizzle.__drizzle_migrations`，`production-rebuild` 应为 `33 | 1794149110765`，`main` 仍为 `61 | 1793200000000`。
9. **在暂存部署的生成地址上**（`recall0-xxxx-….vercel.app`，同源校验接受这个地址）：
   - 打开 `/admin/login`，**马上**注册第一个管理员（密码 + TOTP）。空库上第一个访问者就会成为管理员，所以这一步必须在 re0.io 切过来之前完成。
   - `/admin/models`：确认生成、向量化、转写、语音四类都有可用条目（或接受环境默认值），每条点一次"测试连通"。
   - `/admin/firecrawl`：录入 Firecrawl key（若没用 `FIRECRAWL_API_KEY`）。
   - `/admin/pricing`：确认 Plan / Pack 价格和新用户赠送 credits。
   - OAuth 登录在这里测不了（回调走 `APP_BASE_URL`，会落到旧站），放到提升之后。
   - **(c) 才做**：此时从 `main` 导出用户、导入到 `production-rebuild`（附录 C）。导入可以重复执行，提升前可以再跑一次补上最后几分钟的新注册。
10. **提升**：Vercel 部署页对暂存部署点 Promote，或 `vercel promote <暂存部署地址>`。re0.io 立即切到 rebuild，cron 换成新的六个。
11. **打开 Auto-assign Custom Production Domains**，否则之后合进 `main` 的修复都会停在暂存状态。

### 切换后验证（提升后 30 分钟内）

12. 逐项检查：
    - 用 Google、GitHub 各登录一次新账号：拿到欢迎 credits，`/dashboard` 正常。
    - 建一个 Ree，上传一份 PDF，状态 processing → ready；在 `/rees/[id]/chat` 提问，得到带引用的回答，`/settings?tab=balance` 的明细里有冻结和结算两条。
    - 用小额真钱买一次 Pack：credits 到账；Paddle 的 notification 日志里这条是 200；在 Paddle 里全额退款后 credits 被收回。（要不要用真钱测由你决定。）
    - Vercel → Cron Jobs 里只剩新的六个；手动触发一次 `rank`，返回 200。
    - Vercel 日志里没有 `is not set` / `pricing_unavailable` / 5xx 的集中出现。
    - `https://re0.io/api/mcp` 用新生成的 MCP key 能连上（`docs/mcp.md`）。

### 收尾（回滚窗口结束后，D6）

13. 删掉 §4.2 列的变量；按 §3.3 的旧前缀清理 Blob；在 Neon 里把项目的 default branch 改成 `production-rebuild`。`main` 留作旧数据存档：它是 `production-rebuild` 的父分支，Neon 不允许删除有子分支的分支，所以它本来也删不掉；需要的话先 `pg_dump` 一份离线备份。

---

## 6. 回滚

### 6.1 什么时候回滚

提升后出现登录不可用、知识处理或问答整体失败、计费异常，且 30 分钟内修不好。

### 6.2 怎么回滚

1. **Vercel**：Deployments → `recall0-fbuydbatm…`（`dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`）→ Instant Rollback，或 `vercel rollback dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`。这一步不重新构建：旧部署用的是它构建时的环境变量（`DATABASE_URL` → `main`、旧 Paddle 变量、旧 `CRON_SECRET`），Vercel 也会恢复它的 cron 定义（`drain`、`anchor`）。
2. **数据库：什么都不用做。** 方案 (a) / (c) 从来没有写过 `main`，旧应用回到的就是切换前的旧库。新分支 `production-rebuild` 原样保留，修好后可以直接再用。
3. 回滚后 Vercel 会关闭自动分配生产域名，之后 `main` 的新构建都停在暂存状态，修好后手动 Promote。这正好是再次切换需要的状态。
4. 回滚只回滚流量，不回滚 `main` 的代码。回滚期间合进 `main` 的修复仍按 rebuild 构建（迁移在 `production-rebuild` 上跑），不会碰旧库。决定**永久放弃**切换时，才需要在 GitHub 上 revert #87 的合并，并把 Neon 集成的 Production branch 改回 `main`。注意：revert 后那次构建会在 `main` 上跑旧的 61 条迁移，日志里都已存在，是空操作。

### 6.3 回滚会丢什么

- 切换期间写进 `production-rebuild` 的数据（新注册、Ree、对话、购买）留在新分支里，旧应用看不到。再次切换时它们还在。
- 切换期间在新应用里付过钱的用户：回滚后看不到余额。如果是永久回滚，按 `purchase` 表在 Paddle 里逐笔退款。
- 期间在 Paddle 里取消的旧订阅不会自动恢复（D2 本来就要取消）。

### 6.4 不建议的做法：原地清空 `main`

把 `main` 直接清空、让构建在上面迁移，可以免掉改 Neon 集成这一步，但：从清空到提升之间旧站对着空库会全站报错（必须停机）；回滚要先用 Neon 的 branch restore 把 `main` 恢复到清空前的时间点（受 history retention 窗口限制），再做 Vercel 回滚；暂存期间旧部署的 `drain` / `anchor` cron 还会打到空库上。只有在 Neon 集成无法改 Production branch 时才考虑，届时必须先建一个 `main` 的完整备份分支。

---

## 附录 A：生产库只读核查 SQL

在 Neon SQL Editor 里选 **`main`** 分支执行。整段包在只读事务里，最后 `rollback`。第 1 段必须输出 `journal_rows = 61`、`old_schema = t`。

```sql
begin transaction read only;

-- 1. Where am I? Must print the production main endpoint and the old schema.
select current_database(), inet_server_addr(),
       (select count(*) from drizzle.__drizzle_migrations) as journal_rows,
       (select max(created_at) from drizzle.__drizzle_migrations) as journal_last_when,
       to_regclass('public.workspace') is not null as old_schema;

-- 2. People.
select count(*) as users,
       count(*) filter (where status = 'active') as active_status,
       count(*) filter (where created_at > now() - interval '30 days') as new_30d
from "user";
select provider, count(*) as accounts,
       count(*) filter (where last_login_at > now() - interval '30 days') as login_30d
from oauth_account group by provider order by provider;
select count(*) as users_with_two_providers
from (select user_id from oauth_account group by user_id having count(*) > 1) t;
select count(*) as live_sessions from user_session where revoked_at is null and expires_at > now();

-- 3. Money still running through Paddle.
select pv.plan_id, s.status, (s.cancel_at is not null) as cancelling, count(*) as subscriptions
from subscription s join plan_version pv on pv.id = s.plan_version_id
where s.provider_subscription_id is not null
group by 1, 2, 3 order by 1, 2, 3;
select s.provider_subscription_id, s.status, s.period_end, s.cancel_at, u.email
from subscription s
join workspace_member m on m.workspace_id = s.workspace_id and m.role = 'owner'
join "user" u on u.id = m.user_id
where s.provider_subscription_id is not null and s.status in ('active', 'trialing', 'past_due', 'paused')
order by s.period_end;
select count(*) as payment_events_30d from payment_event where processed_at > now() - interval '30 days';

-- 4. Balances users would lose (unit: calls, not credits).
select u.email, sum(g.calls_granted - g.calls_consumed) as calls_left,
       sum(g.price_minor) filter (where g.redeemed_by is null) as paid_minor
from addon_grant g
join workspace_member m on m.workspace_id = g.workspace_id and m.role = 'owner'
join "user" u on u.id = m.user_id
group by u.email having sum(g.calls_granted - g.calls_consumed) > 0
order by calls_left desc;

-- 5. Cash owed to publishers (revenue share).
select st.status, st.currency, count(*) as statements, sum(st.amount_minor) as amount_minor
from settlement st group by 1, 2 order by 1, 2;
select p.status, count(*) as payouts, sum(p.amount_minor) as amount_minor from payout p group by 1 order by 1;

-- 6. Content and keys that have no home in the rebuild.
select count(*) filter (where deleted_at is null) as libraries,
       count(*) filter (where deleted_at is null and owner_workspace_id is not null and not is_platform_library) as user_libraries
from library;
select (select count(*) from document) as documents, (select count(*) from chunk) as chunks;
select count(*) filter (where revoked_at is null) as live_api_keys,
       count(*) filter (where revoked_at is null and last_used_at > now() - interval '30 days') as used_30d
from api_key;
select count(*) as request_log_30d from request_log where created_at > now() - interval '30 days';
select status, count(*) from workflow_operation group by 1 order by 1;
select count(*) as administrators from administrator where status = 'active';

rollback;
```

怎么读：第 3 段非空 → D2 必须处理；第 4 段非空 → D3；第 5 段里 `accrued` / `held` 的金额或 `requested` 的提现非零 → D4；第 2 段的 30 天登录数决定 (c) 值不值得做；第 6 段的 `used_30d` 决定要不要通知 API 用户。

## 附录 B：清空新分支（只在 `production-rebuild` 上执行）

```sql
-- Run on the NEW branch only. The first query must show the copied old schema;
-- if it shows new_schema = t, the branch was already prepared: stop.
select current_database(), inet_server_addr(),
       to_regclass('public.workspace') is not null as old_schema,
       to_regclass('public.ree') is not null as new_schema,
       (select count(*) from drizzle.__drizzle_migrations) as journal_rows;

drop schema if exists drizzle cascade;
drop schema public cascade;   -- also drops the vector extension; 0001_init recreates it
create schema public;
grant all on schema public to public;

select count(*) as tables_left from pg_tables where schemaname = 'public';  -- expect 0
```

Neon 托管的其他 schema（如 `neon_auth`）不动。

## 附录 C：方案 (c) 的用户导入（可选）

两步，都用 `psql`，连接串分别取 `main` 和 `production-rebuild` 分支的**直连**（unpooled）地址，从 Neon 控制台复制。不要用 `.env.local` 里的 `POSTGRES_*` / `PGHOST`。

**第一步：在 `main` 上导出**（只读）：

```sql
\copy (select o.provider, o.provider_subject, u.email, coalesce(nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1), 'Ree user') as name, u.avatar_url, (u.status <> 'active') as disabled, u.created_at, o.last_login_at from oauth_account o join "user" u on u.id = o.user_id where o.provider in ('google', 'github') order by o.provider, o.provider_subject) to 'legacy_users.csv' with (format csv, header)
```

**第二步：在 `production-rebuild` 上导入**（§5 步骤 8 之后，表已存在）。和 `lib/services/auth.ts` 的首次登录一样，为每个新建账号写一条 `welcome` grant 和对应的账本记录；已存在的 `(provider, provider_subject)` 跳过，所以可以重复执行：

```sql
\set ON_ERROR_STOP on
begin;
create temp table legacy_users (
  provider text, provider_subject text, email text, name text, avatar_url text,
  disabled boolean, created_at timestamptz, last_login_at timestamptz
);
\copy legacy_users from 'legacy_users.csv' with (format csv, header)
with inserted as (
  insert into "user" (email, name, avatar_blob, provider, provider_subject, last_login_at, disabled_at, created_at)
  select email, left(name, 40), avatar_url, provider, provider_subject, last_login_at,
         case when disabled then now() end, created_at
  from legacy_users
  on conflict (provider, provider_subject) do nothing
  returning id, disabled_at
), welcome as (
  select coalesce((select credits from signup_reward where id = 1), 100000)::bigint as credits
), grants as (
  insert into credit_grant (user_id, source, amount, remaining)
  select i.id, 'welcome', w.credits, w.credits from inserted i, welcome w where w.credits > 0
  returning id, user_id, amount
)
insert into credit_entry (user_id, delta, reason, ref_id, allocations)
select g.user_id, g.amount, 'welcome', g.id,
       jsonb_build_array(jsonb_build_object('grantId', g.id, 'source', 'welcome', 'amount', g.amount))
from grants g;
select count(*) as users from "user";
commit;
```

本地验证：4 个旧 `oauth_account`（其中一个用户绑了两个登录方式、一个已封禁）导入为 4 个新账号，各带 100,000 welcome credits 和一条 `welcome` 账本记录，封禁状态保留。

## 附录 D：本地是怎么验证的

全部在一次性容器里做（`pgvector/pgvector:pg18`，独立端口，前面接 `tests/fixtures/wsproxy.mjs`，与生产同为 Neon WebSocket 驱动路径），做完即删；没有连接生产库，没有改 Vercel 或 Neon。

1. 用 `origin/main` 的 `db/migrations` 和 drizzle-kit 0.31.10 建库：日志 61 行、最后 `1793200000000`、66 张表，与生产状态一致。
2. 在这个库上用 rebuild 的 `db/migrations` 跑 `drizzle-kit migrate`：退出码 1、无错误输出；直接调 drizzle-orm 的 neon-serverless migrator 得到错误 `relation "admin_session" already exists`；之后日志仍 61 行、表仍 66 张。
3. 空库上跑 rebuild 迁移：33 行日志、48 张表、`vector` 0.8.7，约 1.7 秒；再跑一次是空操作；drizzle-kit CLI 退出码 0。
4. 复制第 1 步的库，执行附录 B，再跑 rebuild 迁移：成功，结果同第 3 步。
5. 附录 A 的 SQL 在第 1 步的库上完整执行无错误。
6. 附录 C 的导出 / 导入在第 1 步的库（造了测试数据）和第 3 步的库之间执行，结果如上。
7. 表与列对照：两库 `information_schema.columns` 导出后比对。
