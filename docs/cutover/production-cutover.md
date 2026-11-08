# 生产切换方案：旧应用（`main`）→ rebuild

2026-11-09 · D1 已定，其余待确认

把 re0.io 从 `main` 上的旧应用切到 `rebuild`。合并 PR #87（`rebuild` → `main`）会触发一次 Production 构建，构建命令先对生产库跑 `npm run db:migrate`。本文写清楚这一步在生产库上会发生什么、数据库怎么处理、Vercel 要补哪些配置、切换当天的步骤和回滚办法。

本文所有结论都来自读两条分支的代码、迁移和本地实验（附录 D）；**没有连接过生产库**。需要生产数据的地方，附录 A 给出只读 SQL，由你在 Neon SQL Editor 里执行。

---

## 0. 需要你决定的事

| # | 决定 | 选项 | 建议 |
|---|---|---|---|
| D1 | 数据库策略（§3） | **已定**（2026-11-09）：用户表和用户相关记录全部删除重建，**管理员不动** | 新 Neon 分支 `production-rebuild`：只把管理员挪进新表，其余清空重建；`main` 原样冻结做存档和回滚（§3.1–3.2） |
| D10 | 管理员的 TOTP 怎么带过来（§3.3） | rebuild 先加一处旧格式回退（附录 C），管理员用现有密码 + 现有 TOTP 登录；或不改代码，按原邮箱重建管理员，密码和 TOTP 换新 | **加回退**。密码哈希两边通用，只有 TOTP 密文的加密方式不同；回退约 10 行，本地已验证 |
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

### 2.2 三种库状态下的实际结果（本地 Postgres 18 + pgvector，附录 D）

| 库状态 | 结果 |
|---|---|
| **和现在的生产库一样**（按 `main` 的 61 条迁移用 drizzle-kit 建出来） | 33 条都比日志新，全部进入待执行。`0001_init` 在建 `admin_session` 时报 `relation "admin_session" already exists`，整个事务回滚：日志仍是 61 行，66 张表原样不动。`drizzle-kit migrate` 退出码 1，**终端只有转圈，不打印错误**。Vercel 构建失败，当前生产部署继续服务。也就是说，误合并 #87 不会破坏生产，只会得到一次失败的构建 |
| **空库**（新 Neon 分支清空后，或 `main` 清空后） | 33 条在一个事务里全部执行（本地约 1.7 秒），得到 48 张表和 `vector` 扩展，日志 33 行，最后 `1794149110765`。再跑一次是空操作。用 drizzle-kit CLI 本身跑也是退出码 0 |
| **只删了 `public`、留着 `drizzle` 日志** | 33 条都比旧日志新，照样会全部执行并成功，但日志里留着 61 行旧记录。不要这样做：清库时连 `drizzle` schema 一起删（附录 B） |

### 2.3 第一次 Production 构建要满足什么

- 构建开始时，Production 的 `DATABASE_URL_UNPOOLED` 必须指向一个 `public` 和 `drizzle` 都已清空的库。管理员数据事先存放在另一个 schema（`cutover`），迁移只动 `drizzle` 和 `public`，不会碰它（附录 D 实测）。满足这一条，`vercel.json` 不用改。
- 管理员复制要在新 schema 建好**之后**、站点切过去**之前**完成。§5 的"暂存部署"（staged production deployment）正好提供这个间隙：构建已经在新库上建好表，re0.io 还在旧部署上。

---

## 3. 数据库策略（D1 已定）

### 3.1 定下来的做法

你的决定：「不需要兼容用户表和用户记录相关，可以全部删除重建。但是，管理员用户不要动，其他的可以动」。

落到操作上：

1. 在 Neon 里从 `main` 建新分支 `production-rebuild`（**带当前数据**，因为管理员要从里面取）。
2. 在新分支上先把 `administrator` 和 `administrator_role` 两张表复制到 `cutover` schema，再删掉整个 `public` 和 `drizzle`（附录 B 第一段）。
3. Neon 集成的 Production branch 改成 `production-rebuild`，合并 #87，构建在空的 `public` 上跑 33 条迁移。
4. 把管理员从 `cutover` 转换后写进新的 `administrator` 表，删掉 `cutover`（附录 B 第二段）。
5. 管理员用**现有邮箱、现有密码、手机上现有的 TOTP** 登录。前提是 rebuild 先合入一处很小的兼容改动（§3.3、附录 C）；不做这处改动的退路见 §3.3。

用户、会话、余额、订阅、文档库、API key 等全部不带，新库从空开始。用户第一次用同一个 Google / GitHub 账号登录时按新用户注册，自动拿到新用户赠送的 credits（默认 100,000）。

### 3.2 为什么还是用新分支，而不是在 `main` 上原地做

原地做（在 `main` 上把管理员挪到旁边、删掉其余、再迁移）也能实现，但：

- 从清库到提升之间，旧站对着空库会全站报错，必须停机；暂存期间旧部署的 `drain` / `anchor` cron 还会打到空库上。
- 回滚要先用 Neon 的 branch restore 把 `main` 恢复到清库前（受 history retention 窗口限制），再做 Vercel 回滚。

新分支的做法下，`main` 一个字节都不改，旧部署回滚后直接回到原来的库（Vercel Instant Rollback 用的是旧部署构建时的连接串）。复制管理员也不用跨库导出导入：新分支建出来时就带着 `administrator` 表，在同一个分支里挪一下就行，不需要导出文件，也不需要任何密钥。

唯一的代价：新分支是建分支那一刻的快照。建分支之后在旧后台里新增的管理员、改过的密码不会带过来。所以建分支后就不要再动旧后台的管理员，或者干脆在切换当天再建分支。

### 3.3 管理员能不能原样带过来

逐列对照（旧：`origin/main` 的 `db/schema.ts`、`lib/application/administration/*`；新：`rebuild` 的 `db/schema.ts`、`lib/services/admin.ts`、`lib/infra/crypto/*`）：

| 旧列 | 新列 | 能否原样复制 |
|---|---|---|
| `id` uuid | `id` uuid | 能，沿用旧 id |
| `username` | `name`（必填，后台限 40 字） | 改名：`left(username, 40)` |
| `email`（唯一） | `email`（唯一） | 加 `lower(btrim(...))`。两边登录时都把输入转小写后精确比较，旧代码写入时也转了小写，这里只是保险 |
| `password_hash`（可空，invited 时为空） | `password_hash`（必填） | **能**。两边都是 `hash-wasm` 的 Argon2id，参数相同（m=19456, t=2, p=1，32 字节），存的都是 encoded 字符串 `$argon2id$v=19$m=19456,t=2,p=1$…`，新代码用 `argon2Verify` 直接验证（本地实测通过） |
| `mfa_secret`（可空） | `totp_secret_cipher`（必填） | **不能直接用**，见下文 |
| `mfa_last_counter` | `totp_last_counter` | 能，保留防重放 |
| `failed_attempts`, `locked_until` | 同名 | 复制时清零 |
| `status`（`invited` / `active` / `disabled`） | `disabled_at` | `disabled` → `disabled_at = now()`；`active` 照常；`invited`（从没设过密码和 TOTP）**不带**，切换后在新后台重新邀请 |
| `invited_by` | `created_by` | 能（新列没有外键） |
| `created_at` | `created_at` | 能 |
| `mfa_enrolled_at`, `last_active_at`, `invite_token_hash`, `invite_expires_at` | 无 | 丢弃 |
| `administrator_role` → `admin_role`（`super` / `operator` / `reviewer` / `support`） | `role`（`owner` / `administrator`） | `super` → `owner`，其余 → `administrator`。新后台只分两级：owner 不能被停用。复制后至少要有一个启用的 owner（附录 B 会检查） |
| 恢复码 | — | 两边都没有恢复码 |
| `admin_session` | `admin_session`（`id` 是 token 摘要，结构不同） | 不带，管理员重新登录一次 |
| `audit_log`, `admin_permission` | `admin_audit` / 无 | 不带，留在 `main` 存档 |

**TOTP 密钥的问题。** 旧库的 `mfa_secret` 是用 `lib/infrastructure/crypto/sealed.ts` 的 `seal()` 加密的：AES-256-GCM，密钥是 HKDF(`SESSION_SIGNING_SECRET`, salt `re0/cookie-seal/v1`)，明文是 `JSON.stringify(secret)`。旧 schema 注释说用的是 `CREDENTIAL_ENCRYPTION_KEY`，与代码不符，以代码为准。rebuild 登录时用 `openCredential(..., 'totp')` 打开：密钥是 HKDF(`ADMIN_SECRET_KEY` ?? `CREDENTIAL_ENCRYPTION_KEY`, salt `re0/admin-totp/v1`)，明文是裸字符串。密钥和格式都不同，原样复制过去，`openCredential` 返回 null，登录被拒（本地实测：`invalid_credentials`）。

但 rebuild 自己的 `lib/infra/crypto/sealed.ts` 的 `unseal()` 与旧 `seal()` **完全同一套推导**：HKDF(`AUTH_SECRET` ?? `SESSION_SIGNING_SECRET`, `re0/cookie-seal/v1`)，JSON 明文。Production 没有设 `AUTH_SECRET`，所以 rebuild 用 `unseal<string>()` 就能打开旧密文（本地实测返回原 TOTP 密钥）。

所以有两条路：

- **推荐：rebuild 加一个旧格式回退（附录 C，约 10 行）。** 登录时 `openCredential` 打不开，就用 `unseal<string>()` 再试一次；验证通过后用 `sealCredential(secret, 'totp')` 重新加密写回。管理员用现有密码和现有 TOTP 登录，第一次登录后密文自动换成新格式。本地实测：重新加密后旧密码 + 当前 TOTP 码登录成功，同一个码重放被拒。这处改动要在合并 #87 **之前**合进 `rebuild`。
  - 约束：所有管理员都登录过一次之前，不要在 Production 设一个与 `SESSION_SIGNING_SECRET` 不同的 `AUTH_SECRET`，也不要轮换 `SESSION_SIGNING_SECRET`，否则旧密文再也打不开。
- **退路：不改代码，按邮箱重建管理员。** rebuild 没有 `admin:create` 命令行，只能走后台：附录 B 第二段**不执行**，新 `administrator` 表保持为空；暂存部署上由原来的 super 管理员用**原邮箱**在 `/admin/login` 注册为 owner（新密码 + 新 TOTP），再在后台用原邮箱逐个邀请其他人，各自设新密码、重新绑 TOTP。邮箱和人不变，密码和 TOTP 换新。

### 3.4 旧表的去向

用户相关的全部删除，只有管理员两张表经 `cutover` 转进新表。删掉的数据仍完整保存在 `main` 分支里，作为存档和回滚目标，保留到回滚窗口结束（D6）。

| 旧表（`main`） | 处理 | 说明 |
|---|---|---|
| `administrator`, `administrator_role` | **带**，转换后写入新 `administrator` | 见 §3.3 |
| `admin_session`, `admin_role`, `admin_permission`, `audit_log` | 删 | 管理员重新登录；审计历史留在 `main` |
| `user`, `oauth_account`, `user_session` | 删 | 所有人重新登录，首次登录按新用户注册 |
| `github_connection`, `notion_connection` | 删 | 新应用里重新连接 GitHub（走 GitHub App）；Notion 导入在 rebuild 里没有 |
| `workspace`, `workspace_member` | 删 | 新模型按用户，没有工作空间 |
| `api_key`, `request_log` | 删 | 旧 key 调的是旧 `/api/v1`，切换后全部失效；新 MCP key 在 `/settings?tab=api` 生成 |
| `plan`, `plan_version`, `subscription`, `addon_grant`, `payment_event`, `billing_document`, `payment_checkout` | 删 | 订阅和余额见 D2、D3 |
| `usage_reservation`, `usage_event`, `usage_summary`, `llm_cost_event` | 删 | |
| `publisher_account`, `earning_event`, `revenue_period`, `settlement`, `payout` | 删 | 未结清的现金分成见 D4 |
| `library`, `library_alias`, `source`, `library_version`, `document`, `chunk`, `library_profile`, `library_profile_vector`, `library_score`, `library_eval_question`, `library_faq`, `library_review`, `report`, `library_claim`, `domain_verification`, `expert_application`, `policy_version`, `policy_library_entry`, `review_config` | 删 | 和 Ree 不是同一种对象。作者可以在新应用里用 URL / GitHub / 文件重新导入知识 |
| `site_key`, `site_key_origin`, `widget_exchange`, `library_showcase`, `library_showcase_daily`, `showcase_lead`, `showcase_domain` | 删 | 嵌入组件和展示页在 rebuild 里没有；装在客户网站上的组件切换后失效 |
| `llm_config`, `provider_model_config`, `llm_audience_assignment`, `retrieval_config`, `render_config`, `render_provider_key` | 删 | 在新后台重新配置（§5 步骤 10） |
| `anchor_batch`, `anchor_leaf`, `workflow_operation` | 删 | Aptos 存证和 `drain` 任务队列已去掉；已上链的记录还在链上 |

### 3.5 逐项影响

- **管理员**：见 §3.3。新库里有了管理员，`/admin/login` 的"空库首个访问者注册"自动关闭，暂存期间也就不存在被别人抢先注册的问题。走退路时新表为空，要在 re0.io 切过来之前完成 owner 注册（§5 步骤 10）。
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
| `AUTH_SECRET` | 无 | 回退到 `SESSION_SIGNING_SECRET`（有，需 ≥ 32 字符）。**不要加**：带过来的管理员 TOTP 密文要靠这把钥匙打开，所有管理员都登录过一次之前，`AUTH_SECRET` 不能是别的值，`SESSION_SIGNING_SECRET` 也不能轮换（§3.3） |
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
- 如果保留：切换当天在暂存部署上传一份文档（§5 步骤 10），确认能处理到 ready；不行就在 `/admin/models` 配好向量化条目和单价。

### 4.4 Paddle

- Webhook 路径两边一样：`https://re0.io/api/billing/paddle`。现有的正式环境 notification destination 可以继续用，同一个 `PADDLE_WEBHOOK_SECRET`。确认它订阅了 `transaction.paid`、`transaction.completed`、`subscription.*`、`adjustment.created`、`adjustment.updated`。
- Checkout：确认 `re0.io` 是已批准的 checkout 域名，默认支付链接是 `https://re0.io/checkout`（两边都有这个页面）。
- 产品：新应用只认 `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID` 和 `/admin/pricing` 之后创建的价格。旧的 "Pro" / "Additional Calls" 产品留着不动，也不再使用。
- 暂存部署上没法测购买：checkout 地址取自 `APP_BASE_URL`，会落到还在旧部署上的 re0.io。购买放到提升之后验证（§5 步骤 12）。

---

## 5. 切换当天的步骤

思路：先让 Production 构建在新分支上建好表、停在**暂存**状态（不挂 re0.io），把管理员写进去、在暂存地址上把后台配好，再一键把域名切过去。旧站一直服务到切换那一刻。

### 准备（可以提前几天做，不影响线上）

1. **在生产库上跑附录 A**（只读），确定 D2–D4。清库后这些数据在新应用里就没了，名单（附录 A 第 3、4、5 段）要在这一步导出留底。
2. **处理 Paddle 旧订阅（D2）和发布者欠款（D4）**，在旧后台和 Paddle 里完成。
3. **管理员 TOTP 回退（D10）**：把附录 C 的改动合进 `rebuild`，必须在合并 #87 之前。走退路的话跳过这一步。
4. **Paddle 正式环境**：按 §4.4 检查 notification destination、checkout 域名、默认支付链接，以及 `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID` 是否为正式 catalogue 的价格。
5. **Vercel 环境变量**（Production）：加 `GITHUB_APP_SLUG`；按 D7 删 `EMBEDDING_PROVIDER_API_KEY`；按需加 `FIRECRAWL_API_KEY`、`NEXT_PUBLIC_REMOTION_LICENSE_KEY`。确认 `APP_BASE_URL`、`PADDLE_ENVIRONMENT`。确认团队已启用 AI Gateway 且有余额。**不要加 `AUTH_SECRET`**（§3.3 约束）。

### 切换

6. **Neon：建分支并清库。** 从 `main` 建分支 `production-rebuild`，**选"当前数据"（current data），不要选 schema-only**，管理员要从里面取。给它一个读写 compute，规格和自动暂停设置与 `main` 相同；不要设过期时间。在 SQL Editor 里**选中新分支**，执行附录 B 第一段：先打印分支上的旧表和管理员数，再把管理员挪进 `cutover`，删掉 `public` 和 `drizzle`。`main` 上永远不要执行。从这一刻起不要再在旧后台改管理员（§3.2）。
7. **Neon 控制台 → Integrations → Vercel → Manage → Branches**：Production branch 改成 `production-rebuild`，保存。现在的生产部署不受影响（变量是构建时固定的）。用 `vercel env ls production` 看 `DATABASE_URL` / `DATABASE_URL_UNPOOLED` 的更新时间变了即可（不要 pull 值）。顺手把新 endpoint id 加进 `PRODUCTION_DATABASE_ENDPOINTS`。
8. **Vercel → Settings → Environments → Production → Branch Tracking**：关掉 **Auto-assign Custom Production Domains**。之后 `main` 的构建只生成暂存部署，不会自动接管 re0.io。
9. **合并 PR #87**。Production 构建在 `production-rebuild` 上跑 33 条迁移（一个事务），再 `next build`。构建日志里应看到 `migrations applied successfully!`。若构建失败，re0.io 不受影响，修好后重新部署即可。
   - 核对迁移落在了哪：在 Neon 上查 `select count(*), max(created_at) from drizzle.__drizzle_migrations`，`production-rebuild` 应为 `33 | 1794149110765`，`main` 仍为 `61 | 1793200000000`。
10. **在新分支上执行附录 B 第二段**（复制管理员），然后在暂存部署的生成地址上（`recall0-xxxx-….vercel.app`，同源校验接受这个地址）：
    - 打开 `/admin/login`，每位管理员用**原邮箱 + 原密码 + 手机上原来的 TOTP** 登录一次（这一次会把 TOTP 密文换成新格式）。附录 B 列出的"未完成邀请"的人，由 owner 在后台重新邀请。
    - 走退路（没做附录 C）：**不执行**附录 B 第二段，改为由原 super 管理员**马上**在 `/admin/login` 用原邮箱注册为 owner，再在后台用原邮箱邀请其他人。新表为空时第一个访问者就会成为管理员，所以这一步必须在 re0.io 切过来之前完成。
    - `/admin/models`：确认生成、向量化、转写、语音四类都有可用条目（或接受环境默认值），每条点一次"测试连通"。
    - `/admin/firecrawl`：录入 Firecrawl key（若没用 `FIRECRAWL_API_KEY`）。
    - `/admin/pricing`：确认 Plan / Pack 价格和新用户赠送 credits。
    - OAuth 登录在这里测不了（回调走 `APP_BASE_URL`，会落到旧站），放到提升之后。
11. **提升**：Vercel 部署页对暂存部署点 Promote，或 `vercel promote <暂存部署地址>`。re0.io 立即切到 rebuild，cron 换成新的六个。
12. **打开 Auto-assign Custom Production Domains**，否则之后合进 `main` 的修复都会停在暂存状态。

### 切换后验证（提升后 30 分钟内）

13. 逐项检查：
    - 在 re0.io 上用一位管理员的原账号登录 `/admin/login`；`/admin/administrators` 里列出的人、角色、停用状态和附录 B 第二段的输出一致。
    - 用 Google、GitHub 各登录一次新账号：拿到欢迎 credits，`/dashboard` 正常。
    - 建一个 Ree，上传一份 PDF，状态 processing → ready；在 `/rees/[id]/chat` 提问，得到带引用的回答，`/settings?tab=balance` 的明细里有冻结和结算两条。
    - 用小额真钱买一次 Pack：credits 到账；Paddle 的 notification 日志里这条是 200；在 Paddle 里全额退款后 credits 被收回。（要不要用真钱测由你决定。）
    - Vercel → Cron Jobs 里只剩新的六个；手动触发一次 `rank`，返回 200。
    - Vercel 日志里没有 `is not set` / `pricing_unavailable` / 5xx 的集中出现。
    - `https://re0.io/api/mcp` 用新生成的 MCP key 能连上（`docs/mcp.md`）。

### 收尾（回滚窗口结束后，D6）

14. 删掉 §4.2 列的变量；按 §3.5 的旧前缀清理 Blob；在 Neon 里把项目的 default branch 改成 `production-rebuild`。`main` 留作旧数据存档：它是 `production-rebuild` 的父分支，Neon 不允许删除有子分支的分支，所以它本来也删不掉；需要的话先 `pg_dump` 一份离线备份。所有管理员都登录过一次之后，§3.3 对 `AUTH_SECRET` / `SESSION_SIGNING_SECRET` 的约束解除。

---

## 6. 回滚

### 6.1 什么时候回滚

提升后出现登录不可用、知识处理或问答整体失败、计费异常，且 30 分钟内修不好。

### 6.2 怎么回滚

1. **Vercel**：Deployments → `recall0-fbuydbatm…`（`dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`）→ Instant Rollback，或 `vercel rollback dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`。这一步不重新构建：旧部署用的是它构建时的环境变量（`DATABASE_URL` → `main`、旧 Paddle 变量、旧 `CRON_SECRET`），Vercel 也会恢复它的 cron 定义（`drain`、`anchor`）。
2. **数据库：什么都不用做。** 整个过程从来没有写过 `main`：清库、迁移、复制管理员都发生在 `production-rebuild` 上。旧应用回到的就是切换前的旧库，旧管理员账号、密码、TOTP 原样可用。新分支原样保留，修好后可以直接再用。
3. 回滚后 Vercel 会关闭自动分配生产域名，之后 `main` 的新构建都停在暂存状态，修好后手动 Promote。这正好是再次切换需要的状态。
4. 回滚只回滚流量，不回滚 `main` 的代码。回滚期间合进 `main` 的修复仍按 rebuild 构建（迁移在 `production-rebuild` 上跑），不会碰旧库。决定**永久放弃**切换时，才需要在 GitHub 上 revert #87 的合并，并把 Neon 集成的 Production branch 改回 `main`。revert 后那次构建会在 `main` 上跑旧的 61 条迁移，日志里都已存在，是空操作。

### 6.3 回滚会丢什么

- 切换期间写进 `production-rebuild` 的数据（新注册、Ree、对话、购买）留在新分支里，旧应用看不到。再次切换时它们还在。
- 切换期间在新后台新增的管理员、做过的管理操作，旧后台看不到。
- 切换期间在新应用里付过钱的用户：回滚后看不到余额。如果是永久回滚，按 `purchase` 表在 Paddle 里逐笔退款。
- 期间在 Paddle 里取消的旧订阅不会自动恢复（D2 本来就要取消）。

### 6.4 再次切换

新分支已经迁移过、管理员也在里面，再次切换只需要修好代码、合进 `main`、在暂存部署上验证、Promote。不要再执行附录 B：第一段会发现 `new_schema = t` 并要求停下。

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

-- 7. Administrators: what appendix B will carry (an administrator with two roles counts twice).
select a.status, coalesce(r.role_id, '-') as role, count(*) as administrators,
       count(*) filter (where a.password_hash is not null and a.mfa_secret is not null) as enrolled
from administrator a left join administrator_role r on r.administrator_id = a.id
group by 1, 2 order by 1, 2;

rollback;
```

怎么读：第 3 段非空 → D2 必须处理；第 4 段非空 → D3；第 5 段里 `accrued` / `held` 的金额或 `requested` 的提现非零 → D4；第 6 段的 `used_30d` 决定要不要通知 API 用户；第 7 段是附录 B 会带过去的管理员（`active` / `disabled` 且 `enrolled` 的），`invited` 的切换后要重新邀请，`super` 至少要有一位 `active`。第 3、4、5 段的结果请导出保存：清库后新应用里查不到这些数据。

## 附录 B：清库与复制管理员（只在 `production-rebuild` 上执行）

两段都在 Neon SQL Editor 里、**选中 `production-rebuild` 分支**执行，`main` 上永远不要执行。本地按原样跑过（附录 D）。

**第一段：把管理员挪到一边，清空其余**（§5 步骤 6，合并 #87 之前）。第一句必须显示 `old_schema = t`、`new_schema = f`、`journal_rows = 61`，管理员数和附录 A 第 7 段一致；显示 `new_schema = t` 说明这个分支已经处理过，停下。

```sql
-- Run on the NEW branch only (production-rebuild), never on main.
select current_database(), inet_server_addr(),
       to_regclass('public.workspace') is not null as old_schema,
       to_regclass('public.ree') is not null as new_schema,
       (select count(*) from drizzle.__drizzle_migrations) as journal_rows,
       (select count(*) from public.administrator) as administrators;

begin;
-- 1. Set the administrators aside, outside the schemas about to be dropped.
create schema cutover;
create table cutover.administrator as select * from public.administrator;
create table cutover.administrator_role as select * from public.administrator_role;

-- 2. Everything else goes: every user table, user record and the old journal.
drop schema drizzle cascade;
drop schema public cascade;   -- also drops the vector extension; 0001_init recreates it
create schema public;
grant all on schema public to public;
commit;

select (select count(*) from pg_tables where schemaname = 'public') as public_tables,  -- expect 0
       (select count(*) from cutover.administrator) as saved_administrators;
```

**第二段：把管理员写进新表**（§5 步骤 10，构建迁移完之后、Promote 之前）。第一句必须是 33。旧 super 成为 owner，其余成为 administrator；停用的保持停用；从没完成邀请的不带，会被列出来，切换后重新邀请。最后一句必须至少为 1。走退路（不做附录 C）时**不执行**这一段。

```sql
-- Run on the NEW branch after the production build has migrated it (journal = 33 rows).
begin;
select count(*) as journal_rows from drizzle.__drizzle_migrations;  -- expect 33

insert into public.administrator
  (id, name, email, role, password_hash, totp_secret_cipher, totp_last_counter,
   failed_attempts, locked_until, disabled_at, created_by, created_at)
select a.id,
       left(coalesce(nullif(btrim(a.username), ''), split_part(a.email, '@', 1)), 40),
       lower(btrim(a.email)),
       case when exists (select 1 from cutover.administrator_role r
                         where r.administrator_id = a.id and r.role_id = 'super')
            then 'owner' else 'administrator' end,
       a.password_hash,        -- Argon2id, encoded: the rebuild verifies it as is
       a.mfa_secret,           -- legacy seal: opens only with the legacy TOTP fallback (appendix C)
       a.mfa_last_counter,     -- keeps replay protection
       0, null,
       case when a.status = 'disabled' then now() end,
       a.invited_by,
       a.created_at
from cutover.administrator a
where a.status in ('active', 'disabled')
  and a.password_hash is not null
  and a.mfa_secret is not null;

-- Invited-but-never-enrolled administrators are not carried; list them to re-invite.
select username, email from cutover.administrator
where not (status in ('active', 'disabled') and password_hash is not null and mfa_secret is not null);

select name, email, role, disabled_at is not null as disabled from public.administrator order by created_at;
select count(*) filter (where role = 'owner' and disabled_at is null) as active_owners from public.administrator;  -- expect >= 1

drop schema cutover cascade;
commit;
```

`totp_secret_cipher` 里放的是旧密文，只有合入附录 C 的回退后才能用于登录；第一次登录成功后它会被换成新格式。

## 附录 C：管理员 TOTP 的旧格式回退（D10）

改 `lib/services/admin.ts` 的 `signInAdministrator`，`unseal` 和 `sealCredential` 在这个文件里都已经 import 了。在合并 #87 之前，单独开一个 PR 合进 `rebuild`：

```diff
@@ -175,7 +175,14 @@ export async function signInAdministrator(input: { email: string; password: stri
     throw new AdminInputError('invalid_credentials');
   }
   const passwordOk = await verifyPassword(input.password, account.passwordHash);
-  const secret = await openCredential(account.totpSecretCipher, 'totp');
+  /*
+   * Administrators carried over from the old console keep its TOTP seal: the
+   * cookie key (AUTH_SECRET, falling back to SESSION_SIGNING_SECRET) over a
+   * JSON string. Open it once, and re-seal it under the TOTP key on success.
+   */
+  const current = await openCredential(account.totpSecretCipher, 'totp');
+  const legacy = current ? null : await unseal<string>(account.totpSecretCipher);
+  const secret = current ?? (typeof legacy === 'string' ? legacy : null);
   const counter = secret ? await verifyTotpCounter(secret, input.code, now, { minCounter: account.totpLastCounter }) : null;
   if (!passwordOk || counter === null) {
     await database
@@ -191,7 +198,12 @@ export async function signInAdministrator(input: { email: string; password: stri
   /* Spend the step atomically: a second sign-in with the same code loses this race. */
   const [burned] = await database
     .update(schema.administrator)
-    .set({ failedAttempts: 0, lockedUntil: null, totpLastCounter: counter })
+    .set({
+      failedAttempts: 0,
+      lockedUntil: null,
+      totpLastCounter: counter,
+      ...(legacy && secret ? { totpSecretCipher: await sealCredential(secret, 'totp') } : {}),
+    })
     .where(
       and(
         eq(schema.administrator.id, account.id),
```

行为：

- 新格式的密文照常走 `openCredential`，回退分支不执行。
- 旧密文用 `unseal<string>()`（与旧 `seal()` 同一把钥匙、同样是 JSON）打开；密码和 TOTP 都通过、这一步 TOTP 成功"烧掉"时，同一条 `update` 里把密文换成 `sealCredential(secret, 'totp')`。失败的登录不改密文。
- 回退分支打不开（钥匙不对、密文损坏）时 `secret` 为 null，和现在一样回 `invalid_credentials`。

这个 PR 应该附一个集成测试：用 `seal(secret)` 造一个旧格式的管理员行，登录成功后断言 `openCredential(row.totpSecretCipher, 'totp')` 能打开，同一个码重放被拒。本次只在本地临时打上这个补丁验证过（附录 D 第 6 步），没有提交代码。

## 附录 D：本地是怎么验证的

全部在一次性容器里做（`pgvector/pgvector:pg18`，独立端口，前面接 `tests/fixtures/wsproxy.mjs`，与生产同为 Neon WebSocket 驱动路径），做完即删；没有连接生产库，没有改 Vercel 或 Neon。测试用的 `SESSION_SIGNING_SECRET` / `CREDENTIAL_ENCRYPTION_KEY` 是随手写的测试值。

1. 用 `origin/main` 的 `db/migrations` 和 drizzle-kit 0.31.10 建库：日志 61 行、最后 `1793200000000`、66 张表，与生产状态一致。
2. 在这个库上用 rebuild 的 `db/migrations` 跑 `drizzle-kit migrate`：退出码 1、无错误输出；直接调 drizzle-orm 的 neon-serverless migrator 得到错误 `relation "admin_session" already exists`；之后日志仍 61 行、表仍 66 张。
3. 空库上跑 rebuild 迁移：33 行日志、48 张表、`vector` 0.8.7，约 1.7 秒；再跑一次是空操作；drizzle-kit CLI 退出码 0。
4. **用 `origin/main` 自己的代码**（`hashAdminPassword`、`seal`）生成管理员：一个 super（邮箱带大写）、一个 operator、一个已停用的 support、一个从没完成邀请的，各带 `admin_session`。附录 A（含第 7 段）在这个库上完整执行无错误。
5. 复制这个库当作新分支，执行附录 B 第一段 → drizzle-kit 迁移（`cutover` schema 不受影响）→ 附录 B 第二段：3 位管理员写入（super → owner，邮箱转成小写，停用的带 `disabled_at`），未完成邀请的 1 位被列出、没有写入，`active_owners = 1`，`cutover` 被删除。
6. 用 rebuild 的代码登录：
   - 不打补丁：旧哈希 `argon2Verify` 通过；`openCredential(旧密文, 'totp')` 为 null；`unseal<string>(旧密文)` 返回原 TOTP 密钥；登录被拒（`invalid_credentials`）。
   - 打上附录 C 的补丁：owner 和 operator 用原密码 + 原 TOTP 登录成功；之后 `openCredential` 能打开新密文；同一个码重放被拒；下一个 30 秒步的码用新格式登录成功；密码错误被拒且密文不变；停用和未完成邀请的被拒。
   - 打补丁但设一个不同的 `AUTH_SECRET`：登录被拒，与 §3.3 的约束一致。
   补丁验证完已撤回，本 PR 只改文档。
7. 表与列对照：两库 `information_schema.columns` 导出后比对。
