# 生产切换方案：旧应用（`main`）→ rebuild

2026-11-09 · D1、D10 已定，其余待确认

把 re0.io 从 `main` 上的旧应用切到 `rebuild`。合并 PR #87（`rebuild` → `main`）会触发一次 Production 构建，构建命令先对生产库跑 `npm run db:migrate`。本文写清楚这一步在生产库上会发生什么、数据库怎么处理、Vercel 要补哪些配置、切换当天的步骤和回滚办法。

本文所有结论都来自读两条分支的代码、迁移和本地实验（附录 C）；**没有连接过生产库**。需要生产数据的地方，附录 A 给出只读 SQL，由你在 Neon SQL Editor 里执行。

---

## 0. 需要你决定的事

| # | 决定 | 选项 | 建议 |
|---|---|---|---|
| D1 | 数据库策略（§3） | **已定**（2026-11-09）：用户表和用户相关记录全部删除重建，管理员按原邮箱保留 | schema-only 新 Neon 分支 `production-rebuild`，清空后由构建重建，什么都不复制；`main` 原样冻结做存档和回滚（§3.1–3.2） |
| D10 | 管理员怎么保留（§3.3） | **已定**（2026-11-09）：按原邮箱重建，密码和 TOTP 换新，不改代码 | 清库前导出管理员名单；原 super 在暂存部署上用原邮箱注册为 owner（必须在 re0.io 切过来之前）；Promote 后由 owner 按原邮箱邀请其余的人 |
| D2 | 旧 Paddle 订阅（旧 "Pro"）怎么处理 | 切换前在 Paddle 里立即取消并按比例退款；或到期取消；或不处理 | **立即取消并按比例退款**，在切换前做，让旧应用把取消写进旧库。不处理的话，Paddle 会继续按旧价格扣款，而新应用对这些事件一律回 `ignored`，用户付了钱什么也得不到 |
| D3 | 旧余额（Additional Calls 剩余次数）和付费用户 | 不补偿只通知；清库前导出名单，切换后在 `/admin/users` 给重新注册的人手工补发 credits | 清库后新应用里查不到这些余额，所以要在**清库前**定下来：至少用附录 A 第 4 段导出名单（邮箱 + 剩余次数）留底。单位不同（调用次数 vs credits），补不补、按什么比例补由你定 |
| D4 | 发布者分成欠款（`settlement` 中 `accrued` / `held` 的现金） | 清库前用旧后台人工打款结清；作废并通知 | 先看附录 A 第 5 段的金额。非零就**在清库前结清或通知**：清库后新应用里没有这笔钱的任何记录，只剩 `main` 存档 |
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

### 2.2 三种库状态下的实际结果（本地 Postgres 18 + pgvector，附录 C）

| 库状态 | 结果 |
|---|---|
| **和现在的生产库一样**（按 `main` 的 61 条迁移用 drizzle-kit 建出来） | 33 条都比日志新，全部进入待执行。`0001_init` 在建 `admin_session` 时报 `relation "admin_session" already exists`，整个事务回滚：日志仍是 61 行，66 张表原样不动。`drizzle-kit migrate` 退出码 1，**终端只有转圈，不打印错误**。Vercel 构建失败，当前生产部署继续服务。也就是说，误合并 #87 不会破坏生产，只会得到一次失败的构建 |
| **空库**（新 Neon 分支清空后，或 `main` 清空后） | 33 条在一个事务里全部执行（本地约 1.7 秒），得到 48 张表和 `vector` 扩展，日志 33 行，最后 `1794149110765`。再跑一次是空操作。用 drizzle-kit CLI 本身跑也是退出码 0 |
| **只删了 `public`、留着 `drizzle` 日志** | 33 条都比旧日志新，照样会全部执行并成功，但日志里留着 61 行旧记录。不要这样做：清库时连 `drizzle` schema 一起删（附录 B） |

### 2.3 第一次 Production 构建要满足什么

构建开始时，Production 的 `DATABASE_URL_UNPOOLED` 必须指向一个 `public` 和 `drizzle` 都已清空的库（附录 B）。满足这一条，`vercel.json` 不用改。新库不从旧库带任何数据，迁移完就是一个全新安装。

---

## 3. 数据库策略（D1、D10 已定）

### 3.1 定下来的做法

你的决定：「不需要兼容用户表和用户记录相关，可以全部删除重建。但是，管理员用户不要动，其他的可以动」；管理员按原邮箱重新注册 / 邀请，密码和 TOTP 换新（D10）。

落到操作上：

1. 清库前，从 `main` 只读导出两份名单留底：管理员（附录 A 第 7 段，用来重新邀请），以及 D2–D4 要处理的订阅、余额、分成（附录 A 第 3–5 段）。
2. 在 Neon 里从 `main` 建 **schema-only** 分支 `production-rebuild`，在它上面清空 `public` 和 `drizzle`（附录 B）。
3. Neon 集成的 Production branch 改成 `production-rebuild`，合并 #87，构建在空库上跑 33 条迁移。
4. 在暂存部署上，原 super 管理员用原邮箱在 `/admin/login` 注册为 owner（新密码 + 新 TOTP），然后再把 re0.io 切过来。
5. 切过来之后，owner 按名单用原邮箱邀请其他管理员，每人设新密码、绑新 TOTP。

所有用户数据（用户、会话、余额、订阅、文档库、API key 等）都不带，管理员账号也不复制，只是人和邮箱不变。用户第一次用同一个 Google / GitHub 账号登录时按新用户注册，自动拿到新用户赠送的 credits（默认 100,000）。

### 3.2 为什么用 schema-only 新分支

- **用新分支，不在 `main` 上原地做**：原地清库的话，从清库到提升之间旧站对着空库会全站报错，必须停机；暂存期间旧部署的 `drain` / `anchor` cron 还会打到空库上；回滚要先用 Neon 的 branch restore 把 `main` 恢复到清库前（受 history retention 窗口限制）。新分支的做法下 `main` 一个字节都不改，Vercel Instant Rollback 用的是旧部署构建时的连接串，回滚后直接回到原来的库。
- **选 schema-only，不选"当前数据"**：既然什么都不复制，就没有理由让用户数据出现在新分支上。schema-only 分支只有旧表结构、没有行，清库前可以确认 `administrator` 和 `user` 都是 0 行（附录 B 第一句）。旧 schema 本身照样由附录 B 删掉，所以两种建法的后续步骤完全一样。如果 Neon 控制台里没有 schema-only 选项，用"当前数据"建也行，附录 B 一样会把数据删干净，只是第一句的行数检查不是 0。
- 管理员名单以附录 A 第 7 段导出的那一刻为准；准备阶段导一次，切换当天再导一次即可。

### 3.3 管理员（D10：按原邮箱重建）

新 `administrator` 表从空开始。rebuild 在空表上的规则是：第一个打开 `/admin/login` 的访问者注册为 owner（`bootstrapFirstAdministrator`，有咨询锁，表里有任何一行就关闭注册）。所以：

- **owner 必须在暂存部署上注册，而且必须在 re0.io 切过来之前。** 暂存部署只能通过它自己的生成地址访问，re0.io 仍在旧部署上，注册窗口只有你知道的那个地址；一旦 Promote，任何打开 `re0.io/admin/login` 的人都可能抢先成为 owner。构建完成后立刻注册，不要拖。
- 由附录 A 第 7 段里角色为 `super`、状态为 `active` 的那位，用**原邮箱**注册（名字 ≤ 40 字，密码 + 新 TOTP）。
- **其他管理员在 Promote 之后邀请**：后台顶栏的「管理员」对话框里按原名字、原邮箱逐个邀请，得到邀请链接发给本人。链接是 `APP_BASE_URL`（re0.io）下的 `/admin/login?invite=…`，有效 7 天，在 re0.io 切过来之前点开会落到旧站，所以邀请放在 Promote 之后做。新后台只有两级角色：owner 和 administrator，旧的 `operator` / `reviewer` / `support` 都成为 administrator。旧名单里已停用（`disabled`）和从没完成邀请（`invited`）的人，要不要再邀请由你决定。
- 旧 `admin_session`、`audit_log` 不带；审计历史留在 `main` 存档。

为什么不原样复制旧管理员行（供以后参考）：密码哈希两边通用（同为 `hash-wasm` Argon2id 的 encoded 格式），但旧 TOTP 密钥是用 `SESSION_SIGNING_SECRET` 派生的 cookie 密钥加密的 JSON，rebuild 登录时用 `ADMIN_SECRET_KEY` / `CREDENTIAL_ENCRYPTION_KEY` 派生的另一把密钥打开，原样复制后无法登录；要复制就得在 rebuild 登录代码里加旧格式回退。D10 选择了不改代码，按邮箱重建。

### 3.4 旧表的去向

全部删除，新库从空开始。删掉的数据仍完整保存在 `main` 分支里，作为存档和回滚目标，保留到回滚窗口结束（D6）。

| 旧表（`main`） | 处理 | 说明 |
|---|---|---|
| `administrator`, `administrator_role`, `admin_role`, `admin_permission`, `admin_session`, `audit_log` | 删；先导出名单 | 管理员按原邮箱重建（§3.3）；审计历史留在 `main` |
| `user`, `oauth_account`, `user_session` | 删 | 所有人重新登录，首次登录按新用户注册 |
| `github_connection`, `notion_connection` | 删 | 新应用里重新连接 GitHub（走 GitHub App）；Notion 导入在 rebuild 里没有 |
| `workspace`, `workspace_member` | 删 | 新模型按用户，没有工作空间 |
| `api_key`, `request_log` | 删 | 旧 key 调的是旧 `/api/v1`，切换后全部失效；新 MCP key 在 `/settings?tab=api` 生成 |
| `plan`, `plan_version`, `subscription`, `addon_grant`, `payment_event`, `billing_document`, `payment_checkout` | 删 | 订阅和余额见 D2、D3 |
| `usage_reservation`, `usage_event`, `usage_summary`, `llm_cost_event` | 删 | |
| `publisher_account`, `earning_event`, `revenue_period`, `settlement`, `payout` | 删 | 未结清的现金分成见 D4 |
| `library`, `library_alias`, `source`, `library_version`, `document`, `chunk`, `library_profile`, `library_profile_vector`, `library_score`, `library_eval_question`, `library_faq`, `library_review`, `report`, `library_claim`, `domain_verification`, `expert_application`, `policy_version`, `policy_library_entry`, `review_config` | 删 | 和 Ree 不是同一种对象。作者可以在新应用里用 URL / GitHub / 文件重新导入知识 |
| `site_key`, `site_key_origin`, `widget_exchange`, `library_showcase`, `library_showcase_daily`, `showcase_lead`, `showcase_domain` | 删 | 嵌入组件和展示页在 rebuild 里没有；装在客户网站上的组件切换后失效 |
| `llm_config`, `provider_model_config`, `llm_audience_assignment`, `retrieval_config`, `render_config`, `render_provider_key` | 删 | 在新后台重新配置（§5 步骤 9） |
| `anchor_batch`, `anchor_leaf`, `workflow_operation` | 删 | Aptos 存证和 `drain` 任务队列已去掉；已上链的记录还在链上 |

### 3.5 逐项影响

- **管理员**：见 §3.3。
- **登录态**：全部失效，所有人重新登录。OAuth 回调路径两边一样（`/api/auth/{google,github}/callback`），Google / GitHub OAuth App 不用改。
- **API key**：旧 key 全部失效。附录 A 第 6 段能查出 30 天内还在用的 key 数，决定要不要提前通知（D5）。
- **余额、订阅、分成**：清库后新应用里没有任何旧数据可查，所以 D2–D4 都要在**清库之前**决定并处理完：结清、退款或通知。旧数据只剩 `main` 分支这份存档。
- **Paddle 订阅**：新 webhook 对旧产品的 `transaction.*` / `subscription.*` / `adjustment.*` 都回 `ignored`（`docs/handover/step3.md`），所以切换前后在 Paddle 里取消或退款都不会弄乱新库；切换前做，旧库里也有记录。
- **Blob 文件**（`recall0-blob`，私有存储）：两边路径前缀不重叠。旧的是 `sources/`、`uploads/`、`manifests/`、`normalized/`、`quarantine/`、`showcase/`；新的是 `avatars/`、`knowledge/`、`kyc/`、`ree-covers/`、`video/`、`videos/`、`video-narration/`。新应用不会读也不会删旧文件（`purge-kyc-files` 只扫 `kyc/`）。回滚窗口结束后按旧前缀删除即可。
- **Cron**：Vercel 的 cron 跟着"当前生产部署"走。提升 rebuild 的那一刻，`drain` / `anchor` 停，新的六个开始：`purge-trash`（03:30）、`expire-plan`（00:15）、`rank`（每小时第 7 分）、`reembed`（每 10 分钟）、`purge-kyc-files`（03:45）、`abandon-exports`（每 15 分钟），都校验 `CRON_SECRET`。回滚时 Vercel 恢复旧部署的 cron 定义。

---

## 4. Vercel Production 环境变量

下面的"Production 现有"来自 `vercel env ls production`（只看变量名，没有读取值）。"rebuild 读取"来自对 `rebuild` 上 `app/`、`lib/`、`scripts/`、`components/`、`video/` 中 `process.env` / `env.X` 的 grep，以及代码里用变量名查的回退链（`lib/infra/crypto/secrets.ts`、`lib/infra/ai/models.ts`、`lib/infra/paddle.ts`）。

### 4.1 rebuild 读取的变量

| 变量 | Production 现有 | 处理 |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | 有（Neon 集成管理） | 改 Neon 集成的 Production branch 后自动换成新分支的连接串（§5 步骤 6）。只对之后的新部署生效 |
| `AUTH_SECRET` | 无 | 回退到 `SESSION_SIGNING_SECRET`（有，需 ≥ 32 字符）。可以不加。以后要加或轮换，代价是所有用户和管理员的会话失效、未用的管理员邀请链接作废 |
| `ADMIN_SECRET_KEY` | 无 | 回退到 `CREDENTIAL_ENCRYPTION_KEY`（有）。新库里的模型 key、Firecrawl key、管理员 TOTP 密钥都用它加密，**切换后不能再改它** |
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

## 5. 切换当天的步骤

思路：先让 Production 构建在新分支上建好表、停在**暂存**状态（不挂 re0.io），在暂存地址上注册 owner、把后台配好，再一键把域名切过去。旧站一直服务到切换那一刻。

### 准备（可以提前几天做，不影响线上）

1. **在 `main` 上跑附录 A**（只读），确定 D2–D4，并把第 3、4、5、7 段的结果导出保存。第 7 段是管理员名单（邮箱、名字、状态、角色），切换后按它重新邀请。清库后这些数据在新应用里就查不到了。
2. **处理 Paddle 旧订阅（D2）和发布者欠款（D4）**，在旧后台和 Paddle 里完成。
3. **Paddle 正式环境**：按 §4.4 检查 notification destination、checkout 域名、默认支付链接，以及 `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID` 是否为正式 catalogue 的价格。
4. **Vercel 环境变量**（Production）：加 `GITHUB_APP_SLUG`；按 D7 删 `EMBEDDING_PROVIDER_API_KEY`；按需加 `FIRECRAWL_API_KEY`、`NEXT_PUBLIC_REMOTION_LICENSE_KEY`。确认 `APP_BASE_URL`、`PADDLE_ENVIRONMENT`。确认团队已启用 AI Gateway 且有余额。

### 切换

5. **Neon：建分支并清库。** 从 `main` 建 schema-only 分支 `production-rebuild`（§3.2）。给它一个读写 compute，规格和自动暂停设置与 `main` 相同；不要设过期时间。在 SQL Editor 里**选中新分支**执行附录 B；第一句会打印分支上的旧表和行数，`main` 上永远不要执行。
6. **Neon 控制台 → Integrations → Vercel → Manage → Branches**：Production branch 改成 `production-rebuild`，保存。现在的生产部署不受影响（变量是构建时固定的）。用 `vercel env ls production` 看 `DATABASE_URL` / `DATABASE_URL_UNPOOLED` 的更新时间变了即可（不要 pull 值）。顺手把新 endpoint id 加进 `PRODUCTION_DATABASE_ENDPOINTS`。
7. **Vercel → Settings → Environments → Production → Branch Tracking**：关掉 **Auto-assign Custom Production Domains**。之后 `main` 的构建只生成暂存部署，不会自动接管 re0.io。
8. **合并 PR #87**。Production 构建在 `production-rebuild` 上跑 33 条迁移（一个事务），再 `next build`。构建日志里应看到 `migrations applied successfully!`。若构建失败，re0.io 不受影响，修好后重新部署即可。
   - 核对迁移落在了哪：在 Neon 上查 `select count(*), max(created_at) from drizzle.__drizzle_migrations`，`production-rebuild` 应为 `33 | 1794149110765`，`main` 仍为 `61 | 1793200000000`。
9. **构建一完成，就在暂存部署的生成地址上**（`recall0-xxxx-….vercel.app`，同源校验接受这个地址）：
   - 打开 `/admin/login`，由原 super 管理员用**原邮箱**注册为 owner（新密码 + 新 TOTP）。新表为空时第一个访问者就会成为 owner，所以这一步必须先于一切、且必须在 re0.io 切过来之前完成（§3.3）。注册后再打开一次 `/admin/login`，应该只剩登录、没有注册表单。
   - `/admin/models`：确认生成、向量化、转写、语音四类都有可用条目（或接受环境默认值），每条点一次"测试连通"。
   - `/admin/firecrawl`：录入 Firecrawl key（若没用 `FIRECRAWL_API_KEY`）。
   - `/admin/pricing`：确认 Plan / Pack 价格和新用户赠送 credits。
   - OAuth 登录和管理员邀请链接在这里测不了（都走 `APP_BASE_URL`，会落到旧站），放到提升之后。
10. **提升**：Vercel 部署页对暂存部署点 Promote，或 `vercel promote <暂存部署地址>`。re0.io 立即切到 rebuild，cron 换成新的六个。
11. **打开 Auto-assign Custom Production Domains**，否则之后合进 `main` 的修复都会停在暂存状态。
12. **重新邀请管理员**：owner 在 re0.io 上登录后台，在顶栏「管理员」对话框里按附录 A 第 7 段的名单，用原名字、原邮箱逐个邀请，把链接发给本人（7 天内有效）。每人打开链接设新密码、绑新 TOTP。

### 切换后验证（提升后 30 分钟内）

13. 逐项检查：
    - owner 在 re0.io 上登录 `/admin/login` 成功；被邀请的人至少一位完成注册并能登录。
    - 用 Google、GitHub 各登录一次新账号：拿到欢迎 credits，`/dashboard` 正常。
    - 建一个 Ree，上传一份 PDF，状态 processing → ready；在 `/rees/[id]/chat` 提问，得到带引用的回答，`/settings?tab=balance` 的明细里有冻结和结算两条。
    - 用小额真钱买一次 Pack：credits 到账；Paddle 的 notification 日志里这条是 200；在 Paddle 里全额退款后 credits 被收回。（要不要用真钱测由你决定。）
    - Vercel → Cron Jobs 里只剩新的六个；手动触发一次 `rank`，返回 200。
    - Vercel 日志里没有 `is not set` / `pricing_unavailable` / 5xx 的集中出现。
    - `https://re0.io/api/mcp` 用新生成的 MCP key 能连上（`docs/mcp.md`）。

### 收尾（回滚窗口结束后，D6）

14. 删掉 §4.2 列的变量；按 §3.5 的旧前缀清理 Blob；在 Neon 里把项目的 default branch 改成 `production-rebuild`。`main` 留作旧数据存档；要删的话先 `pg_dump` 一份离线备份，并留意 Neon 不允许删除还有子分支的分支。

---

## 6. 回滚

### 6.1 什么时候回滚

提升后出现登录不可用、知识处理或问答整体失败、计费异常，且 30 分钟内修不好。

### 6.2 怎么回滚

1. **Vercel**：Deployments → `recall0-fbuydbatm…`（`dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`）→ Instant Rollback，或 `vercel rollback dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`。这一步不重新构建：旧部署用的是它构建时的环境变量（`DATABASE_URL` → `main`、旧 Paddle 变量、旧 `CRON_SECRET`），Vercel 也会恢复它的 cron 定义（`drain`、`anchor`）。
2. **数据库：什么都不用做。** 整个过程从来没有写过 `main`，清库和迁移都发生在 `production-rebuild` 上。旧应用回到的就是切换前的旧库，旧管理员账号、密码、TOTP 原样可用。新分支原样保留，修好后可以直接再用。
3. 回滚后 Vercel 会关闭自动分配生产域名，之后 `main` 的新构建都停在暂存状态，修好后手动 Promote。这正好是再次切换需要的状态。
4. 回滚只回滚流量，不回滚 `main` 的代码。回滚期间合进 `main` 的修复仍按 rebuild 构建（迁移在 `production-rebuild` 上跑），不会碰旧库。决定**永久放弃**切换时，才需要在 GitHub 上 revert #87 的合并，并把 Neon 集成的 Production branch 改回 `main`。revert 后那次构建会在 `main` 上跑旧的 61 条迁移，日志里都已存在，是空操作。

### 6.3 回滚会丢什么

- 切换期间写进 `production-rebuild` 的数据（新注册、Ree、对话、购买、新后台的管理员和操作）留在新分支里，旧应用看不到。再次切换时它们还在。
- 切换期间在新应用里付过钱的用户：回滚后看不到余额。如果是永久回滚，按 `purchase` 表在 Paddle 里逐笔退款。
- 期间在 Paddle 里取消的旧订阅不会自动恢复（D2 本来就要取消）。

### 6.4 再次切换

新分支已经迁移过，owner 和已接受邀请的管理员也还在里面，再次切换只需要修好代码、合进 `main`、在暂存部署上验证、Promote。不要再执行附录 B：它的第一句会显示 `new_schema = t`，说明已经处理过。

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

-- 7. Administrators to re-invite after the cutover. Export this result before the wipe.
select a.email, a.username, a.status,
       coalesce(string_agg(r.role_id, ', ' order by r.role_id), '-') as roles,
       a.created_at, a.last_active_at
from administrator a
left join administrator_role r on r.administrator_id = a.id
group by a.id
order by (a.status = 'active') desc, bool_or(r.role_id = 'super') desc nulls last, a.email;

rollback;
```

怎么读：第 3 段非空 → D2 必须处理；第 4 段非空 → D3；第 5 段里 `accrued` / `held` 的金额或 `requested` 的提现非零 → D4；第 6 段的 `used_30d` 决定要不要通知 API 用户；第 7 段是管理员名单：`active` 且角色含 `super` 的那位在暂存部署上注册 owner，其余 `active` 的切换后按原邮箱邀请，`disabled` / `invited` 的要不要再邀请由你决定。第 3、4、5、7 段的结果请导出保存：清库后新应用里查不到这些数据。

## 附录 B：清空新分支（只在 `production-rebuild` 上执行）

§5 步骤 5，合并 #87 之前。在 Neon SQL Editor 里**选中 `production-rebuild` 分支**执行，`main` 上永远不要执行。第一句必须显示 `old_schema = t`、`new_schema = f`；schema-only 分支上 `administrators` 和 `users` 应为 0（用"当前数据"建的分支这里不是 0，没关系，下面会删掉）。显示 `new_schema = t` 说明这个分支已经处理过，停下。

```sql
-- Run on the NEW branch only (production-rebuild), never on main.
-- Must show old_schema = t, new_schema = f and administrators = 0 (schema-only: no rows came over).
select current_database(), inet_server_addr(),
       to_regclass('public.workspace') is not null as old_schema,
       to_regclass('public.ree') is not null as new_schema,
       (select count(*) from public.administrator) as administrators,
       (select count(*) from public."user") as users;

begin;
drop schema if exists drizzle cascade;
drop schema public cascade;   -- also drops the vector extension; 0001_init recreates it
create schema public;
grant all on schema public to public;
commit;

select count(*) as public_tables from pg_tables where schemaname = 'public';  -- expect 0
```

Neon 托管的其他 schema（如 `neon_auth`）不动。

## 附录 C：本地是怎么验证的

全部在一次性容器里做（`pgvector/pgvector:pg18`，独立端口，前面接 `tests/fixtures/wsproxy.mjs`，与生产同为 Neon WebSocket 驱动路径），做完即删；没有连接生产库，没有改 Vercel 或 Neon。

1. 用 `origin/main` 的 `db/migrations` 和 drizzle-kit 0.31.10 建库：日志 61 行、最后 `1793200000000`、66 张表，与生产状态一致。
2. 在这个库上用 rebuild 的 `db/migrations` 跑 `drizzle-kit migrate`：退出码 1、无错误输出；直接调 drizzle-orm 的 neon-serverless migrator 得到错误 `relation "admin_session" already exists`；之后日志仍 61 行、表仍 66 张。
3. 空库上跑 rebuild 迁移：33 行日志、48 张表、`vector` 0.8.7，约 1.7 秒；再跑一次是空操作；drizzle-kit CLI 退出码 0。
4. 复制第 1 步的库执行清库 SQL，再跑 rebuild 迁移：成功，结果同第 3 步。用 `pg_dump --schema-only` 造一个只有旧表结构的库（相当于 schema-only 分支），执行附录 B：第一句 `old_schema = t`、`new_schema = f`、`administrators = 0`、`users = 0`，清完 `public` 为 0 张表。
5. 用 `origin/main` 自己的代码（`hashAdminPassword`、`seal`）造了 4 位管理员（super、operator、已停用、未完成邀请）。附录 A 全部段落（含第 7 段的名单导出）在这个库上执行无错误，第 7 段按"启用、super 在前"列出邮箱、名字、状态、角色。
6. 同一批管理员行复制进 rebuild 的新表后，旧密码哈希能通过 rebuild 的 `argon2Verify`，但旧 TOTP 密文用 rebuild 的 `openCredential(…, 'totp')` 打不开，登录被拒（`invalid_credentials`）。这就是 §3.3 说的"不能原样复制"；D10 选择按邮箱重建后，这条路不再使用。
7. 表与列对照：两库 `information_schema.columns` 导出后比对。
