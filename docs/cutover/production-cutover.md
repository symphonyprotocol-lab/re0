# 生产切换方案：旧应用（`main`）→ rebuild

2026-11-09 · 自动切换；D1、D10、D11、D12 已定，其余待确认

re0.io 从 `main` 上的旧应用切到 `rebuild`。**切换由合并 PR #87（`rebuild` → `main`）触发的那次 Production 构建自动完成**：不用去 Neon 建分支或改集成，不用手跑 SQL，也不用在 Vercel 上为数据库做任何操作。本文写清楚这次构建对生产库做什么、失败或重试时会怎样、合并后要验证什么、出问题时怎么回滚，以及还剩哪些事只能由你来做。

实现：`scripts/database-cutover.mts`（逻辑）、`scripts/database-cutover-cli.mts`（`npm run db:deploy` / `npm run db:cutover`）、`vercel.json` 的 `buildCommand`、`lib/services/admin.ts` 的首位管理员限制。所有结论都来自读代码、迁移和本地实验（附录 B）；**没有连接过生产库**。

---

## 0. 决定和待办

### 0.1 已定

| # | 决定 | 内容 |
|---|---|---|
| D1 | 数据（2026-11-09） | 用户表和用户相关记录不带进新应用，新库从空开始。旧数据不删，整体归档在同一个库的 `legacy_main` schema 里，回滚窗口结束后再删（§3） |
| D10 | 管理员（2026-11-09） | 不复制旧管理员行（旧 TOTP 密文无法在新应用里打开）。按原邮箱重建：原超级管理员第一个注册为 owner，其余由 owner 按原邮箱邀请，各自绑新 TOTP（§4） |
| D11 | 自动部署（2026-11-09） | 合并 #87 后由构建原地完成切换，不需要你去 Neon 或 Vercel 操作（§2） |
| D12 | 首位管理员的身份证明（2026-11-09） | 首位注册的 owner 必须用旧后台启用状态的超级管理员的邮箱 **和旧密码**（旧 Argon2id 哈希验证），TOTP 重新绑定；全新安装照旧开放（§4.2）。不只认邮箱，是因为知道或猜到邮箱的人能在部署上线后抢先注册。代价：owner 沿用旧密码，而新后台目前没有修改密码的入口 |

### 0.2 还要你决定

| # | 决定 | 选项 | 建议 |
|---|---|---|---|
| D2 | 旧 Paddle 订阅（旧 "Pro"） | 立即取消并按比例退款；到期取消；不处理 | **合并前立即取消并按比例退款**。不处理的话 Paddle 会继续按旧价格扣款，新应用对这些事件一律回 `ignored` |
| D3 | 旧余额（Additional Calls 剩余次数） | 不补偿只通知；切换后在 `/admin/users` 给重新注册的人手工补发 credits | 单位不同（调用次数 vs credits），补不补、按什么比例补由你定。名单可以在切换前从 `main` 查，也可以切换后从 `legacy_main` 查（附录 A） |
| D4 | 发布者分成欠款（`settlement` 中 `accrued` / `held` 的现金） | 合并前用旧后台人工打款结清；作废并通知 | 先看附录 A 第 5 段。旧后台只在合并前可用；合并后数据还在 `legacy_main`，但只能线下处理 |
| D5 | 对外通知 | 合并前通知旧 API key 用户和付费用户；不通知 | 由你定。旧 API、嵌入组件、展示页切换后全部 404 |
| D6 | 回滚窗口多长 | 7 / 14 / 30 天 | **30 天**。期间不执行 `drop-legacy`，不删旧 Blob 文件和旧环境变量 |
| D7 | 向量化走哪条路（§5.3） | 在 `/admin/models` 加一条经 AI Gateway 的向量化配置；或删掉 Production 的 `EMBEDDING_PROVIDER_API_KEY` | **在后台加配置**，不用碰 Vercel。都不做的话，向量化会直连 OpenAI，需要这条路由有单价，否则知识处理以 `pricing_unavailable` 失败 |
| D8 | 旧公开地址要不要重定向 | 不做；把 `/libraries/*`、`/s/*`、`/playground` 指到首页或 `/explore` | 不做，除非旧页面还有访问量 |
| D9 | 非技术前提 | — | Remotion 许可（`NEXT_PUBLIC_REMOTION_LICENSE_KEY`，默认 `free-license`）、法律页法务审阅、PayPal Business 账户。不挡切换，但要在对外宣布前确认 |

### 0.3 仍然只能由你做的事

1. 合并本 PR 进 `rebuild`，再合并 #87 进 `main`（两个都由你手工合并）。
2. 部署上线后**尽快**在 `https://re0.io/admin/login` 用原超级管理员的邮箱和旧密码注册 owner（§4）。在你注册之前，任何人都无法注册（需要旧密码），但后台也没人能用。
3. owner 在后台顶栏「管理员」里按原邮箱邀请其他管理员（§4.3）。
4. 后台配置：`/admin/models`（含 D7）、`/admin/firecrawl`（Firecrawl key）、`/admin/pricing`。这些在应用里做，不碰 Neon / Vercel。
5. 可选的 Vercel 环境变量（§5.2）：`GITHUB_APP_SLUG`、`FIRECRAWL_API_KEY`、`NEXT_PUBLIC_REMOTION_LICENSE_KEY`。都不挡切换。
6. Paddle 和 GitHub App 各核对一项设置（§6），都不需要改代码。
7. 真要回滚时：一条命令加一次点击（§8）。

---

## 1. 现状

**生产部署**：`recall0-fbuydbatm-virgil-zhaos-projects-cc544793.vercel.app`（`dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`，2026-10-29 构建），别名 `re0.io`、`www.re0.io`。Cron：`/api/cron/drain`（每 10 分钟）、`/api/cron/anchor`（每 15 分钟）。

**数据库**：Neon，经 Vercel 原生集成 `neon-recall0` 接到 `recall0`；Production 的 `DATABASE_URL` / `DATABASE_URL_UNPOOLED` 指向 Neon 的 `main` 分支。上面是 `main` 的 schema：迁移 `0000_init`–`0060_manual_payout`，66 张表、24 个枚举类型，`drizzle.__drizzle_migrations` 61 行，最后一行 `created_at` = `1793200000000`。

**rebuild**：迁移 `0001_init`–`0033_mcp_api_keys`，从零建 48 张表，33 条的 `when` 都比 `1793200000000` 大。两边重名的表有 8 张（`user`、`chunk`、`administrator`、`admin_session`、`api_key`、`github_connection`、`payout`、`subscription`），列全都不同。

**单靠 `drizzle-kit migrate` 会怎样**（本地实测）：33 条都比旧日志新，全部进入待执行；`0001_init` 建 `admin_session` 时报 `relation "admin_session" already exists`，整个事务回滚，旧库原样不动；drizzle-kit 退出码 1、不打印错误。所以旧的 `buildCommand` 会让第一次构建失败，生产不受影响，但也切不过去。

---

## 2. 构建里发生什么（D11）

### 2.1 `buildCommand`

之前：

```
if preview: db:prepare-preview;  if production or preview: db:migrate (drizzle-kit);  next build
```

现在（`vercel.json`）：

```
if [ "$VERCEL_ENV" = "preview" ]; then npm run db:prepare-preview && npm run db:migrate; fi \
 && npm run build \
 && if [ "$VERCEL_ENV" = "production" ]; then npm run db:deploy; fi
```

- **Preview**：和之前完全一样（重置脚本 + drizzle-kit），而且 Preview 部署本来就停用了。
- **本地开发**：不受影响，`npm run db:migrate` / `db:up` 照旧。
- **Production**：先 `next build`，再 `db:deploy`。`next build` 不读数据库（本地在没有任何 `DATABASE_URL` 的情况下构建成功，所有路由都是动态渲染），所以数据库放到最后：`next build` 失败时数据库完全没动。旧部署面对新 schema 的时间，也从"整个构建"缩短到"数据库提交到 Vercel 切换别名"之间的几十秒（§2.4）。

### 2.2 `db:deploy` 做什么

一个连接（`DATABASE_URL_UNPOOLED`，与 drizzle-kit 相同）、**一个事务**、事务级咨询锁 `re0:database-deploy`：

1. 看 `public` 里是什么，按下表决定。
2. 需要归档时：把旧应用在 `public` 里的**每张表、每个类型**（以及可能有的视图、独立序列、函数）移到新 schema `legacy_main`；索引、约束、自增序列随表一起走。把旧日志 `drizzle` 改名为 `legacy_drizzle`。移完再检查 `public` 里不属于扩展的对象是否为零，不为零就整个回滚。
3. 按 drizzle 迁移器的规则执行待执行的迁移：同样的文件、同样的 sha256、同样的 `drizzle.__drizzle_migrations`、同样的"`when` 大于最新一条才执行"。本地验证：之后再跑真正的 `drizzle-kit migrate` 是空操作（退出码 0、日志仍 33 行）。
4. 提交。任何一步出错就整体回滚：要么切换完成且新 schema 建好，要么什么都没变。

| `public` 里是 | 其他条件 | 构建做什么 |
|---|---|---|
| 旧应用（有 `workspace`、没有 `ree`） | 没有 `legacy_main`、没有 `rebuild_parked`，日志不晚于 `1793200000000` | **归档 + 迁移**（只会发生一次） |
| rebuild（有 `ree`） | — | 只执行新迁移（以后每次部署都是这样） |
| 空（没有表） | — | 只执行迁移（全新安装） |
| 旧应用 | 有 `rebuild_parked`（刚回滚过） | **拒绝，构建失败**：回滚后自动部署不能再把库从旧应用脚下抽走（§8.3） |
| 两者都有 / 都不是 / 已有 `legacy_main` / 日志更新 | — | 拒绝，构建失败，提示人工检查 |

**为什么不直接把 `public` 改名**：那样 `vector` 扩展（两边都不加 schema 前缀地使用它的类型和运算符）会跟着跑到别的 schema，得用 `ALTER EXTENSION vector SET SCHEMA` 搬回来，而这要求是扩展的属主。生产上 `vector` 由谁持有无法从这里确认；本地 pgvector 只允许超级用户创建，属主不是构建用的角色。只移表和类型，`public` 本身、它的属主和权限、`vector` 扩展都原地不动，构建用的角色只需要是这些表的属主（它就是建表的那个角色）。本地按这个权限布局实测通过（附录 B）。

### 2.3 失败、重试、并发

- **`next build` 失败**：数据库没动，旧站照常。
- **`db:deploy` 失败**（迁移报错、连接断开、构建被取消）：事务回滚，旧站照常，构建失败。下一次构建（重试、或再推一个修复）从头再来。本地用一条故意失败的迁移验证过：失败后 `public` 仍是旧应用、没有 `legacy_main`，修好后重试一次成功。
- **数据库已提交，但之后 Vercel 收尾失败**：极少见。此时库已是新 schema、旧部署仍在服务，旧站会报错，直到下一次构建上线（它看到 rebuild schema，只执行新迁移），或按 §8 回滚。
- **两个构建同时跑**：第二个在咨询锁上等，拿到锁时看到 rebuild schema，什么都不做。本地两个 `db:deploy` 同时启动实测：一个归档 + 33 条迁移，另一个"nothing pending"，都成功。

### 2.4 切换那一刻

从 `db:deploy` 提交（构建日志最后几行）到 Vercel 把 re0.io 指向新部署之间有几十秒，旧部署面对的是新 schema，请求会报错。本地这一步本身约 1 秒。这是原地切换的代价，也是本方案唯一的停机窗口。

构建日志里应看到：

```
before:  public=legacy journal_last=1793200000000 legacy_main=false rebuild_parked=false vector_in=public
plan:    public holds the old app's schema (journal ends at 1793200000000); archiving it to legacy_main
archived the old app: its tables and types moved from public to legacy_main, drizzle renamed to legacy_drizzle
applied: 0001_init, …, 0033_mcp_api_keys
after:   public=rebuild journal_last=1794149110765 legacy_main=true rebuild_parked=false vector_in=public (… ms, one transaction)
```

之后每次部署是 `plan: public already holds the rebuild schema` 加上新迁移（或 `nothing pending`）。

---

## 3. 数据（D1）

- **新应用**：48 张表全部为空。用户第一次用同一个 Google / GitHub 账号登录时按新用户注册，自动拿到新用户赠送的 credits（默认 100,000）。
- **旧数据**：66 张表、24 个枚举类型、所有行原样在 `legacy_main` 里，旧日志在 `legacy_drizzle`。新应用不读它们，唯一的例外是首位管理员的校验（§4.2）。旧表里的 `vector` 列照常可用（类型仍是 `public.vector`）。
- **回滚窗口结束后**：`npm run db:cutover -- drop-legacy --confirm=<endpoint>` 删掉 `legacy_main` 和 `legacy_drizzle`（§8.4）。在此之前什么都不会被删。

逐项影响：

- **登录态**：全部失效，所有人重新登录。OAuth 回调路径两边一样，Google / GitHub OAuth App 不用改。
- **API key**：旧 key 调的是旧 `/api/v1`，切换后全部失效；新 MCP key 在 `/settings?tab=api` 生成（`docs/mcp.md`）。
- **余额、订阅、分成**：新应用里查不到。要处理的在合并前处理（D2–D4）；之后只能从 `legacy_main` 查（附录 A）。
- **Paddle 订阅**：新 webhook 对旧产品的 `transaction.*` / `subscription.*` / `adjustment.*` 都回 `ignored`（`docs/handover/step3.md`），所以切换前后在 Paddle 里取消或退款都不会弄乱新库。
- **Blob 文件**（`recall0-blob`，私有存储）：两边路径前缀不重叠。旧：`sources/`、`uploads/`、`manifests/`、`normalized/`、`quarantine/`、`showcase/`；新：`avatars/`、`knowledge/`、`kyc/`、`ree-covers/`、`video/`、`videos/`、`video-narration/`。新应用不会读也不会删旧文件；回滚窗口结束后按旧前缀删除。
- **Cron**：跟着当前生产部署走。新部署上线那一刻，`drain` / `anchor` 停，新的六个开始：`purge-trash`（03:30）、`expire-plan`（00:15）、`rank`（每小时第 7 分）、`reembed`（每 10 分钟）、`purge-kyc-files`（03:45）、`abandon-exports`（每 15 分钟），都校验 `CRON_SECRET`。回滚时 Vercel 恢复旧部署的 cron。

---

## 4. 管理员（D10、D12）

### 4.1 为什么要改首位注册

rebuild 在空的 `administrator` 表上，让第一个打开 `/admin/login` 的访问者注册为 owner。原地自动切换后，部署一上线就是一个空表加一个公开的注册表单，陌生人可以抢先成为 owner。

### 4.2 现在的规则（`bootstrapAllowlist`，`lib/services/admin.ts`）

- 库里存在 `legacy_main.administrator`（即从旧应用切换过来的库）时，首位管理员只能用旧后台**启用状态的超级管理员**（`super` 角色）的邮箱注册，并且**密码必须与该账号的旧密码一致**（用 `legacy_main` 里的旧 Argon2id 哈希验证；两边哈希格式相同，本地实测可验证）。旧后台没有启用的超级管理员时，退而认任何启用的旧管理员。
- 邮箱不区分大小写。邮箱不对和密码不对给同一个错误（`bootstrap_email`，界面提示"首位管理员要用旧后台超级管理员的邮箱和密码创建"），并且两种情况都会算一次哈希，不暴露哪一项错了。
- TOTP 在注册表单上重新绑定（旧 TOTP 用不了）。
- 注册成功后表里有了 owner，注册入口照旧关闭。
- 全新安装（没有 `legacy_main`），或 `legacy_main` 里没有启用的管理员：照旧，第一个访问者注册。
- `drop-legacy` 之后表里早已有 owner，这条规则不再起作用。

本地验证（真实的 61 条旧迁移 + 用旧代码生成的管理员）：陌生邮箱、旧 operator 的邮箱都被拒；旧超级管理员的邮箱（大小写不同）加旧密码注册成功，角色 owner；之后任何人再注册都被拒。集成测试另覆盖了"邮箱对、密码错"被拒、没有超级管理员时的回退、全新安装照旧开放。

### 4.3 合并后

1. 原超级管理员打开 `https://re0.io/admin/login`，用原邮箱、旧密码、新的 TOTP 注册为 owner。
2. owner 在后台顶栏「管理员」对话框里，按旧名单（附录 A 第 7 段，或切换后查 `legacy_main.administrator`）用原名字、原邮箱逐个邀请，把链接发给本人（7 天内有效）。每人设新密码、绑新 TOTP。新后台只有 owner 和 administrator 两级，旧的 `operator` / `reviewer` / `support` 都成为 administrator。已停用和从没完成邀请的人，要不要再邀请由你决定。

---

## 5. Vercel Production 环境变量（只读核对）

2026-11-09 用 `vercel env ls production` 核对（只看变量名，没有读取任何值，也没有改动任何变量），与 2026-11-08 相比没有变化，共 50 个。

### 5.1 rebuild 读取的变量

| 变量 | Production 现有 | 处理 |
|---|---|---|
| `DATABASE_URL`, `DATABASE_URL_UNPOOLED` | 有（Neon 集成管理） | 不变。切换在同一个库里原地做，`db:deploy` 走 `DATABASE_URL_UNPOOLED` |
| `AUTH_SECRET` | 无 | 回退到 `SESSION_SIGNING_SECRET`（有，需 ≥ 32 字符）。可以不加。以后要加或轮换，代价是所有用户和管理员的会话失效、未用的管理员邀请链接作废 |
| `ADMIN_SECRET_KEY` | 无 | 回退到 `CREDENTIAL_ENCRYPTION_KEY`（有）。新库里的模型 key、Firecrawl key、管理员 TOTP 密钥都用它加密，**切换后不能再改它** |
| `APP_BASE_URL` | 有 | 确认值是 `https://re0.io`。OAuth 回调、Paddle checkout 地址、同源校验都从它来 |
| `BLOB_READ_WRITE_TOKEN` | 有 | 不变（`recall0-blob`，私有存储，两边都用 `access: 'private'`） |
| `CRON_SECRET` | 有 | 不变 |
| `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET`, `GITHUB_OAUTH_CLIENT_ID` / `_SECRET` | 有 | 不变，回调地址不变 |
| `GITHUB_APP_CLIENT_ID` / `_SECRET` | 有（6 天前加） | 确认这个 GitHub App 的 callback URL 包含 `https://re0.io/api/auth/github/callback/connect` |
| `GITHUB_APP_SLUG` | **无** | 建议加（值只有你有：GitHub App 设置页地址里的那一段，不是机密）。缺了"连接 GitHub"的安装链接会退回 `https://github.com/settings/installations`，功能照常，只是用户得自己找到这个 App |
| `PADDLE_API_KEY`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN` | 有 | 确认 API key 有 transaction、subscription、`price.read`、`price.write` 权限（`/admin/pricing` 会创建价格） |
| `PADDLE_PLAN_PRICE_ID`, `PADDLE_PACK_PRICE_ID` | 有（6 天前加） | 确认是**正式环境 catalogue** 里新建的 Plan / Pack 价格，不是 sandbox 的 `pri_01m6dd9…`。五项缺任何一项，整个计费就是"未配置" |
| `PADDLE_ENVIRONMENT` | 有 | 确认值不是 `sandbox` |
| `PADDLE_CHECKOUT_BASE_URL` | 无 | 不用加，回退到 `APP_BASE_URL` |
| `AI_GATEWAY_API_KEY` | 无 | 在 Vercel 上可以不加：代码在 `VERCEL=1` / 有 `VERCEL_OIDC_TOKEN` 时走 OIDC 认证。前提是团队已启用 AI Gateway 且有余额 |
| `GENERATION_MODEL` / `EMBEDDING_MODEL` / `TRANSCRIPTION_MODEL` / `SPEECH_MODEL`，`LLM_BASE_URL` / `LLM_API_KEY`，`SPEECH_API_KEY`，`OPENAI_API_KEY` | 无 | 都可以不加。后台 `/admin/models` 没有配置时用默认值 `openai/gpt-5-mini`、`openai/text-embedding-3-small`、`openai/whisper-1`、`openai/tts-1`，经 AI Gateway |
| `EMBEDDING_PROVIDER_API_KEY` | **有**（旧应用留下的） | 见 D7 和 §5.3：不想动 Vercel，就在 `/admin/models` 加一条经 AI Gateway 的向量化配置，后台配置优先于环境变量 |
| `EMBEDDING_PROVIDER_BASE_URL` | 无 | 有 key 没 base URL 时默认 `https://api.openai.com/v1` |
| `FIRECRAWL_API_KEY`, `FIRECRAWL_BASE_URL` | **无** | 二选一：加 `FIRECRAWL_API_KEY`（值只有你有，Firecrawl 控制台），或切换后在 `/admin/firecrawl` 录入 key（不用碰 Vercel，支持多 key 和备用 key）。生产用托管的 `https://api.firecrawl.dev`，不设 `FIRECRAWL_BASE_URL`。都没有的话 PDF / Word / 网页抓取不可用 |
| `PROVIDER_COST_RATES` | 无 | 不用加。内置默认价只覆盖 `api.firecrawl.dev` 的 `parse`；其他供应商单价在后台配置 |
| `CLAIM_DNS_RESOLVERS` | 无 | 不用加（域名认领的 DNS 解析器，可选） |
| `NEXT_PUBLIC_REMOTION_LICENSE_KEY` | 无 | 默认 `free-license`，见 D9。构建期变量：要用付费许可就得在合并前加 |
| `PRODUCTION_DATABASE_ENDPOINTS` | 有（只在 Production） | 不变。只有 Preview 构建里的重置脚本读它；Preview 部署已停用 |
| `E2E_LOGIN_SECRET`, `DATABASE_WS_PROXY` | 无 | **不要加**。前者只在 `next dev` 下生效，后者只给本地 Docker 库用 |
| `VERCEL`, `VERCEL_ENV`, `VERCEL_URL`, `VERCEL_OIDC_TOKEN`, `NODE_ENV` | 系统 | — |

### 5.2 缺的变量

**没有一个是切换必需的，也不需要生成任何新密钥**：`AUTH_SECRET` 回退到现有的 `SESSION_SIGNING_SECRET`，`ADMIN_SECRET_KEY` 回退到现有的 `CREDENTIAL_ENCRYPTION_KEY`，AI Gateway 在 Vercel 上走 OIDC。

| 变量 | 需要什么 | 不加会怎样 |
|---|---|---|
| `GITHUB_APP_SLUG` | 只有你有的值：GitHub App 设置页地址 `github.com/settings/apps/<slug>` 里的 `<slug>`，不是机密 | "连接 GitHub"的安装链接退回通用的安装页，功能照常 |
| `FIRECRAWL_API_KEY` | 只有你有的值：Firecrawl 控制台的 API key | 可以不加，改为切换后在 `/admin/firecrawl` 录入。两处都没有时 PDF / Word / 网页抓取不可用 |
| `NEXT_PUBLIC_REMOTION_LICENSE_KEY` | 只有你有的值：remotion.pro 的公钥（D9） | 用 `free-license`，符合免费条件就不用加 |

另外 `EMBEDDING_PROVIDER_API_KEY` 是多出来的（D7，§5.3）。

### 5.3 向量化路由（D7）

Production 里留着旧应用的 `EMBEDDING_PROVIDER_API_KEY`。没有后台配置时，rebuild 看到它，会把向量化从 AI Gateway 改成直连 `https://api.openai.com/v1`（`text-embedding-3-small`，1536 维，和新 `chunk.embedding` 一致）。直连端点要先找到这条路由的单价（后台或 `PROVIDER_COST_RATES` 里配置的价格，或者公开价格目录里查到的），否则抛 `pricing_unavailable`，知识处理失败。

- 建议（不碰 Vercel）：切换后在 `/admin/models` 加一条经 AI Gateway 的向量化配置并启用。后台配置优先于环境变量；这条配置不填 key 时也不会借用这个 OpenAI key（只在同一接入方式下借用），走 OIDC。新库里没有任何切块，启用时的重算是空操作。
- 或者：从 Production 删掉 `EMBEDDING_PROVIDER_API_KEY`（Vercel 操作）。旧部署不受影响。

### 5.4 只有旧应用读的变量

`API_KEY_HASH_SECRET`、`BUILD_BILLING_MODE`、`NOTION_OAUTH_CLIENT_ID` / `_SECRET`、`OCR_PROVIDER`、`OCR_PROVIDER_API_KEY`、`OCR_PROVIDER_BASE_URL`、`RENDER_PROVIDER`、`RENDER_PROVIDER_API_KEY`、`LLM_PROVIDER_API_KEY_AGNES`、`LLM_PROVIDER_API_KEY_MINIMAX`、`PADDLE_PRO_PRODUCT_ID`、`PADDLE_ADDON_PRODUCT_ID`。留着无害；回滚窗口结束前不要删（回滚后旧代码可能要重新构建）。`NEON_AUTH_BASE_URL`、`VITE_NEON_AUTH_URL`、`POSTGRES_*`、`PG*` 由 Neon 集成管理，不用动。

---

## 6. Neon、Vercel 之外

| 服务 | 要改吗 | 说明 |
|---|---|---|
| Neon | **不用** | 原地切换，同一个分支、同一组连接串，集成不动 |
| Vercel 数据库相关设置 | **不用** | 没有域名暂存、没有分支切换；`vercel.json` 随 #87 一起生效 |
| Paddle webhook | **不用改地址**，核对一项 | 两边都是 `https://re0.io/api/billing/paddle`，同一个 `PADDLE_WEBHOOK_SECRET`。核对正式环境的 notification destination 订阅了 `transaction.paid`、`transaction.completed`、`subscription.*`、`adjustment.created`、`adjustment.updated`。可以在 Paddle 后台看，也可以用 Paddle API 的 notification settings 接口查看或修改（需要有 notification 权限的 API key） |
| Paddle 产品 / 价格 | **不用** | 新应用用 Production 里已有的 `PADDLE_PLAN_PRICE_ID` / `PADDLE_PACK_PRICE_ID`（确认是正式 catalogue 的价格，不是 sandbox 的 `pri_01m6dd9…`），之后在 `/admin/pricing` 管理。旧 "Pro" / "Additional Calls" 留着不动。默认支付链接两边都是 `https://re0.io/checkout`。旧订阅的取消（D2）可以在 Paddle 后台做，也可以用 Paddle API 的 cancel subscription 接口按附录 A 第 3 段的名单批量做 |
| Google / GitHub OAuth App | **不用** | 回调路径两边一样：`/api/auth/google/callback`、`/api/auth/github/callback` |
| GitHub App（`GITHUB_APP_*`） | 核对一项 | 回调地址要包含 `https://re0.io/api/auth/github/callback/connect`。这个 App 是 6 天前为 rebuild 加的，大概率已配好；只能在 GitHub 的 App 设置页里看 |
| Vercel Blob | **不用** | 同一个 `recall0-blob`，前缀不重叠 |

---

## 7. 合并当天

### 7.1 合并前（建议，都可以不做）

1. 在 Neon SQL Editor 里对 `main` 跑附录 A（只读），定 D2–D4，处理旧订阅和分成欠款；名单导出留底（切换后也能从 `legacy_main` 查）。
2. 决定是否加 §5.2 的可选变量。

### 7.2 合并

3. 先合并本 PR 进 `rebuild`，再合并 #87 进 `main`。Vercel 自动开始 Production 构建：`next build` → `db:deploy`（归档 + 33 条迁移，一个事务）→ 上线，re0.io 指向新部署，cron 换成新的六个。
4. 看构建日志最后几行，应和 §2.4 一样。构建失败时 re0.io 仍是旧站、数据库没动，看日志里的 `refused:` 或错误，修好后再推一次。

### 7.3 上线后（越快越好）

5. 原超级管理员在 `https://re0.io/admin/login` 注册 owner（§4.3）。
6. `/admin/models`：确认四类模型都有可用条目（含 D7 的向量化），每条点一次"测试连通"。`/admin/firecrawl` 录入 Firecrawl key。`/admin/pricing` 确认 Plan / Pack 价格和新用户赠送 credits。
7. 邀请其他管理员（§4.3）。
8. 验证：
   - owner 能在 re0.io 登录后台；`/admin/login` 不再显示注册表单。
   - 用 Google、GitHub 各登录一次新账号：拿到欢迎 credits，`/dashboard` 正常。
   - 建一个 Ree，上传一份 PDF，状态 processing → ready；在 `/rees/[id]/chat` 提问，得到带引用的回答，`/settings?tab=balance` 的明细里有冻结和结算两条。
   - 用小额真钱买一次 Pack：credits 到账；Paddle 的 notification 日志里这条是 200；全额退款后 credits 被收回。（要不要用真钱测由你决定。）
   - Vercel → Cron Jobs 里只剩新的六个。
   - Vercel 日志里没有 `is not set` / `pricing_unavailable` / 5xx 的集中出现。
   - `https://re0.io/api/mcp` 用新生成的 MCP key 能连上（`docs/mcp.md`）。
   - 想看数据库状态：`vercel env run -e production -- npm run db:cutover -- status`（只读），应为 `public=rebuild … legacy_main=true`。

---

## 8. 回滚

### 8.1 什么时候回滚

上线后出现登录不可用、知识处理或问答整体失败、计费异常，且 30 分钟内修不好。

### 8.2 怎么回滚：一条命令 + 一次点击

旧部署和新部署用的是同一个库，所以光做 Vercel 回滚不够：旧应用会对着新 schema。先把库换回来，再切流量。

1. 在链接了 Vercel 项目的本地 checkout（比如主 checkout）里执行，Production 的连接串由 Vercel CLI 临时注入，不落盘：

   ```bash
   vercel env run -e production -- npm run db:cutover -- rollback --confirm=<endpoint>
   ```

   `<endpoint>` 是生产库的 Neon endpoint id（`ep-…`）。不带或带错时命令什么都不做，只打印正确的值，所以可以先不带跑一次看。它在一个事务里：把 rebuild 的表和类型移到 `rebuild_parked`、日志改名 `rebuild_parked_drizzle`，把 `legacy_main` 里的旧表和类型移回 `public`、`legacy_drizzle` 改回 `drizzle`。完成后旧应用的库与切换前一致（本地验证：66 张表、24 个类型、日志 61 行，旧查询和 `vector` 运算符正常，旧应用自己的 `drizzle-kit migrate` 是空操作）。

2. Vercel → Deployments → `recall0-fbuydbatm…`（`dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`）→ **Instant Rollback**，或命令行 `vercel rollback dpl_nmtkYDv3cKHbAPmzsHVQKQGKXwbJ`。旧部署带着它构建时的环境变量和 cron（`drain`、`anchor`）回来。

第 1 步到第 2 步之间，新部署对着旧 schema 会报错；两步紧接着做，停机就是这几十秒。

为什么回滚不能也自动：Instant Rollback 不重新构建，旧代码里没有换回 schema 的步骤，构建脚本也不知道什么时候发生了回滚。所以这一步只能由人触发，已经压到一条命令。

**不用 Vercel 的替代做法**：第 1 步之后，在 GitHub 上 revert #87 的合并。`main` 的构建会用旧代码和旧 `buildCommand`，它的 `drizzle-kit migrate` 看到旧日志是空操作，部署自动上线。比 Instant Rollback 慢（要等一次完整构建，期间站点报错），但全程不进 Vercel。

### 8.3 回滚后再切换

回滚后 `db:deploy` 会拒绝（构建失败），因为这时候构建出来的部署不一定会自动上线（Instant Rollback 之后 Vercel 会暂停自动分配生产域名），不能在旧站还在服务时把库换掉。修好问题后：

1. `vercel env run -e production -- npm run db:cutover -- resume --confirm=<endpoint>`：把旧表移回 `legacy_main`、把 `rebuild_parked` 移回 `public`，回滚期间写进新应用的数据（注册、Ree、owner 等）都还在。
2. 推送修复，或在 Vercel 上 Promote / Redeploy 新部署（`vercel promote <deployment>`）。构建看到 rebuild schema，只执行新迁移。

### 8.4 回滚窗口结束（D6）

```bash
vercel env run -e production -- npm run db:cutover -- drop-legacy --confirm=<endpoint>
```

只在 `public` 是 rebuild 时执行，删掉 `legacy_main` 和 `legacy_drizzle`；之后就不能再回滚到旧应用了。再按 §3 的旧前缀清理 Blob，按需删掉 §5.4 的变量。

### 8.5 回滚会丢什么

- 切换期间写进新应用的数据留在 `rebuild_parked` 里，旧应用看不到；`resume` 后它们回来。
- 切换期间在新应用里付过钱的用户：回滚后看不到余额。如果是永久回滚，按 `rebuild_parked.purchase` 在 Paddle 里逐笔退款。
- 期间在 Paddle 里取消的旧订阅不会自动恢复（D2 本来就要取消）。

---

## 附录 A：生产库只读核查 SQL

**合并前**：在 Neon SQL Editor 里选 `main` 分支原样执行。整段包在只读事务里，最后 `rollback`。第 1 段必须输出 `journal_rows = 61`、`old_schema = t`。

**合并后**：旧数据在同一个库的 `legacy_main` 里。把第一句改成 `begin transaction read only; set local search_path to legacy_main, public;`，第 1 段里的 `drizzle.` 改成 `legacy_drizzle.`、`public.workspace` 改成 `legacy_main.workspace`，其余照旧。

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

怎么读：第 3 段非空 → D2 必须处理；第 4 段非空 → D3；第 5 段里 `accrued` / `held` 的金额或 `requested` 的提现非零 → D4；第 6 段的 `used_30d` 决定要不要通知 API 用户；第 7 段是管理员名单：`active` 且角色含 `super` 的那位在上线后注册 owner（§4），其余 `active` 的按原邮箱邀请，`disabled` / `invited` 的要不要再邀请由你决定。新应用里查不到这些数据，合并后只能从 `legacy_main` 查。

## 附录 B：本地是怎么验证的

全部在一次性 Docker 容器里做（`pgvector/pgvector:pg18`，前面接 `tests/fixtures/wsproxy.mjs`，与生产同为 Neon WebSocket 驱动），做完即删。没有连接生产库，没有改 Vercel 或 Neon，没有触发任何部署。

**模拟生产的权限布局**：数据库属主是非超级用户 `neondb_owner`（对应 Neon 上构建用的角色），`public` 的属主是 `pg_database_owner`，`vector` 扩展由超级用户创建、属主不是 `neondb_owner`。旧应用的 61 条迁移以 `neondb_owner` 执行，得到 66 张表、24 个枚举、日志 61 行（最后 `1793200000000`）。再用 `origin/main` 自己的代码（`hashAdminPassword`、`seal`）生成 4 位管理员（super、operator、已停用、未完成邀请），加上用户、OAuth 账号、工作空间、会话。

1. `npm run db:cutover -- status`：识别为旧应用，计划归档。
2. `npm run db:deploy`（构建里执行的同一条命令）：归档 + 33 条迁移，约 1 秒，一个事务。之后 `public` 48 张表全空，`legacy_main` 66 张表、24 个枚举、所有行都在，`legacy_drizzle` 61 行；`public` 属主仍是 `pg_database_owner`，`vector` 仍在 `public`，旧表的向量列类型仍是 `public.vector`。
3. 再跑一次 `db:deploy`：`nothing pending`。再跑真正的 `drizzle-kit migrate`：退出码 0，日志仍 33 行。
4. 首位管理员（应用代码直连该库）：允许名单只有旧 super 的邮箱；陌生邮箱、旧 operator 被拒（`bootstrap_email`）；旧 super 的邮箱（大小写不同）+ 旧密码注册成功，角色 owner；之后再注册被拒。
5. `db:cutover -- rollback`：不带 `--confirm` 时拒绝并打印目标；带上后完成。`public` 回到 66 张表、24 个枚举、日志 61 行，旧查询（用户 ↔ 工作空间联表、`<=>` 向量运算）正常；`rebuild_parked` 48 张表，含第 4 步注册的 owner。
6. 回滚状态下 `db:deploy`：拒绝（`the cutover was rolled back …`），退出码 1。
7. `db:cutover -- resume`：rebuild 回到 `public`，owner 还在；再 `db:deploy`：`nothing pending`。
8. 新库副本上两个 `db:deploy` 同时启动：一个归档 + 33 条迁移，另一个等锁后 `nothing pending`，都退出码 0。之后回滚，再用**旧应用自己的** `drizzle-kit migrate`（`origin/main` 的迁移目录）：退出码 0，日志 61 行，表 66 张（即 revert #87 那条回滚路径可行）。
9. `db:cutover -- drop-legacy`：`legacy_main`、`legacy_drizzle` 被删，`public` 48 张表、`vector` 不受影响。
10. 在 Vercel Preview 环境变量下运行 `db:deploy`：连接之前就拒绝。
11. 在完全没有数据库变量的情况下 `next build`：成功，所有路由都是动态渲染，构建不读数据库。

**自动化测试**（随本 PR 提交）：

- `tests/unit/database-cutover.test.ts`：`planDeploy` 的每个分支。
- `tests/integration/database-cutover.test.ts`：在测试服务器上新建的一次性数据库里，用几张旧表、`vector` 扩展和旧日志代替完整旧 schema，覆盖：归档 + 迁移、日志与 drizzle 迁移器一致（hash 和 `created_at` 逐条相同）、旧数据保留且向量列可用、第二次空操作、迁移失败时整体回滚且重试成功、两个连接并发、回滚 → 拒绝部署 → 恢复 → 删除归档、全新空库。
- `tests/integration/admin-bootstrap-legacy.test.ts`：只认旧 super 的邮箱 + 旧密码；邮箱对密码错被拒；已停用的旧 super 被拒；没有 super 时回退到启用的管理员；全新安装和没有启用管理员的归档照旧开放。
- `npm run typecheck` 通过；`./scripts/test-integration.sh`（独立的 `PG_CONTAINER` / `PG_PORT` / `WS_PORT`）全量 78 个文件、599 个测试通过。
