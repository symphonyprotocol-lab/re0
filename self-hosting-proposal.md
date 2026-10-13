# Re0 私有部署方案（Docker 自托管）

- 版本：0.1
- 日期：2026-09-17
- 状态：待评审实施方案
- 冻结范围：第 0–4 节、第 10 节为本轮评审对象；第 5–9 节是实现细节草案，实施期间允许按落地情况调整
- 依赖基线：[requirement.md](./requirement.md)、[architecture.md](./architecture.md)（§3.1 运行边界、§7 对象存储布局、§9.1 向量布局、§19.1 环境变量）、[README.md](./README.md) 技术栈一节

## 0. 执行摘要

Re0 目前只有一种部署形态：Vercel Functions + Neon Postgres + Vercel Blob + Upstash + Vercel Cron。本方案增加第二种形态——**用户用 Docker 在自己的机器或内网里跑完整的 Re0**，知识库正文、向量、上传文件和调用日志都不出用户的边界。

结论是：**这件事的成本远低于直觉，因为绑定并不深。** 代码里对 Vercel 专有 API 的依赖只有 `@vercel/blob` 一处，而对象存储早就有 S3 兼容的第二条路（[lib/infrastructure/objects/store.ts](lib/infrastructure/objects/store.ts)）；Upstash 未配置时限流与缓存自行降级；Cron 只是一个带 Bearer 的 HTTP 端点；`after()`、Edge Middleware、MCP 路由在自托管的 Next.js 上都原生工作。真正要补的是四件事：**Postgres 驱动**（现在走 Neon 的 WebSocket 驱动）、**镜像与编排**、**几处写死的托管版假设**（公开站点 origin、计费与存证入口、向量维度），以及**内网可用的登录方式**。

交付形态是两套 compose：一体机（自带 pgvector、MinIO、Redis）与外接（只跑应用，数据库和对象存储用客户自有）。许可证保持 MIT，私有部署版开源免费，不做授权校验。

## 1. 决策与边界

### 1.1 已决事项

- **私有部署版开源免费。** 许可证仍是 MIT，不引入 BSL / 双许可，不做 license key、不做实例数或用量的授权校验，也不预留校验钩子。私有部署的目的是获客与信任，变现靠托管版与支持服务。
- **`DEPLOYMENT_EDITION` 只做形态开关，不做授权门禁。** 取值 `hosted`（默认）与 `self-hosted`；后者隐藏定价、升级、收益分成入口，关闭支付与链上存证，不影响任何检索、构建与 API 能力。
- **M1 同时覆盖“可访问公网”和“纯内网隔离”两种环境。** 因此通用 OIDC 登录属于 M1 范围，不推迟；GitHub / Google 仍然保留，三者按配置共存。
- **两套编排都交付**：`compose.yaml`（一体机，自带 Postgres + MinIO + Redis）与 `compose.external.yaml`（只起应用与 cron，数据库与对象存储由客户提供）。文档说明各自适用场景与运维责任归属。
- **向量维度做成安装期参数。** `EMBEDDING_DIMENSIONS` 默认 1536，安装时可改，改动由迁移脚本在库为空时一次性执行；建库之后不可再改。托管版永远是 1536。
- **私有部署不是新的套餐。** 不新增 Enterprise 计划，`BUILD_BILLING_MODE` 保持 `shadow`，套餐与额度在 self-hosted 形态下不做强制。
- **镜像是唯一的官方二进制交付物。** 发布到 GHCR，双架构（amd64 / arm64），tag 与仓库 tag 一一对应；不提供打包好的安装器。
- **不做数据迁入迁出工具。** 托管版与私有部署之间不承诺数据搬迁，两边各自独立。

### 1.2 对托管版的不变量

本方案不得改变以下任何一条，评审与实现都以此为准：

- Vercel 的构建命令、`vercel.json` 的 Cron 与 `buildCommand` 不变；
- 托管版仍使用 `drizzle-orm/neon-serverless` 与 Vercel Blob，运行路径一行不改；
- `db/migrations` 的内容与顺序不变，向量维度调整不写进迁移文件；
- `chunk.embedding` 与 `library_profile_vector.embedding` 在托管版仍是 `vector(1536)`；
- REST、MCP、SDK、CLI 的契约不变；
- 站点在 `hosted` 形态下的页面与文案除新增一个导航项与一个页面外不变。

### 1.3 非目标

首期不做：

- Helm chart 与 Kubernetes Operator（M2）；
- 离线镜像包与无外网现场交付流程（M2）；
- 多副本 / 高可用编排（应用可以起多副本，但本方案只验证单副本）；
- 托管版与私有部署之间的数据迁移；
- 私有部署的链上存证（需要公网 Aptos 节点与签名密钥，默认关闭）；
- 私有部署的支付与订阅；
- 维度超过 2000 的嵌入模型（pgvector 的 HNSW 对 `vector` 类型上限即 2000 维，更高需要改 `halfvec`，不在本期）；
- 自带嵌入 / 重排 / LLM 模型的镜像，模型服务由用户自备并通过 OpenAI 兼容端点接入。

## 2. 现状盘点：托管耦合点

| 能力 | 现状 | 私有部署替代 | 改动 |
| --- | --- | --- | --- |
| Postgres | `drizzle-orm/neon-serverless` + `@neondatabase/serverless` 的 WebSocket Pool（[lib/infrastructure/postgres/client.ts](lib/infrastructure/postgres/client.ts)） | `pgvector/pgvector:pg16` + `node-postgres` | **R1** |
| 构建产物 | Vercel 托管构建 | `output: 'standalone'` + 多阶段镜像 | **R2** |
| 迁移执行 | `vercel.json` 的 `buildCommand` 在 preview 环境跑 `db:migrate` | 一次性 migrate 容器 | **R3** |
| 对象存储 | Vercel Blob；未设 `BLOB_READ_WRITE_TOKEN` 时已退回手写 SigV4 的 S3 兼容实现 | MinIO 或客户自有 S3 / OSS | **R4**（只差浏览器可达的签名端点） |
| 向量维度 | `vector(1536)` 写死，适配器按 `EMBEDDING_DIMENSIONS = 1536` 校验返回宽度 | 安装期参数 | **R5** |
| Redis | Upstash REST；未配置时限流与缓存优雅降级（[lib/infrastructure/cache/redis.ts](lib/infrastructure/cache/redis.ts)） | Redis + `serverless-redis-http` 代理 | **R6**（0 行代码） |
| 定时任务 | Vercel Cron 调 `/api/cron/drain`、`/api/cron/anchor`，`Authorization: Bearer $CRON_SECRET` | cron 容器按同样节奏调用 | **R7**（0 行代码） |
| 公开 origin | `PUBLIC_ORIGIN = 'https://re0.io'` 写死（[lib/site/origin.ts](lib/site/origin.ts)） | self-hosted 下读 `APP_BASE_URL` | **R8** |
| 计费 / 存证 / 分成入口 | 页面常驻 | 形态开关关闭 | **R8** |
| 用户登录 | 仅 GitHub、Google OAuth | 增加通用 OIDC | **R9** |
| 后台登录 | 密码 + TOTP，空实例首位管理员自助注册 | 直接可用 | 0 |
| 就绪检查 | 无统一端点 | `/api/health` | **R10** |
| 长任务 | `after(runOperation)` + drain 兜底，`maxDuration = 300` | 自托管无函数时限，反而更宽松 | 0 |
| 嵌入 / 重排 / LLM | OpenAI 兼容 baseURL 可配置 | 指向内网 vLLM / TEI / Ollama | 0 |

值得单独记一笔：`app/files/[fileId]/route.ts` 与 Dashboard 的 PDF 直传都依赖**浏览器直接访问对象存储**（签名 URL 重定向、presigned PUT），浏览器端的 `put` 分支已经实现（[components/dashboard/pdf-uploader.tsx](components/dashboard/pdf-uploader.tsx)），所以 MinIO 路线不需要新写上传链路，只需要一个浏览器和应用都能解析的存储地址（R4）。

## 3. 目标拓扑

### 3.1 一体机 `compose.yaml`

```
caddy ──┬── app (Next.js standalone, 3000)
        └── minio (9000 / 9001)
app ──┬── postgres (pgvector/pgvector:pg16)
      ├── minio
      └── srh (serverless-redis-http) ── redis
migrate (一次性，先于 app 起) ── postgres
cron (supercronic) ── app:/api/cron/drain
```

- Caddy 终止 TLS，把 `/` 反代给 app，把 `/s3/*` 反代给 MinIO，因此**浏览器和应用看到的是同一个存储地址**，签名主机一致；不需要额外域名。
- 所有对外只暴露 Caddy 的 80 / 443；Postgres、MinIO 管理端口、Redis 只在 compose 网络内。
- 卷：`pgdata`、`miniodata`，外加 Caddy 的证书卷。

### 3.2 外接 `compose.external.yaml`

只起 `app` 与 `cron`（以及可选的 `migrate`），`DATABASE_URL`、`OBJECT_STORE_*`、`UPSTASH_*` 指向客户自有的 Postgres（必须装 pgvector）、S3 兼容存储与 Redis。适用于已有 DBA 与备份体系的团队；一体机的卷备份在这里不适用，运维责任归客户。

### 3.3 组件基线

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Postgres | `pgvector/pgvector:pg16` | 与 CI、`scripts/test-integration.sh` 完全一致 |
| MinIO | 最新稳定版 | 初始化脚本建桶并设置允许应用 Origin 的跨域 `PUT` |
| Redis | 7.x + `serverless-redis-http` | 仅限流与检索缓存；整体可省略 |
| Node | 24 | 与 `.github/workflows/test.yml` 一致 |
| 反向代理 | Caddy 2 | 自动 TLS；内网可换自签或企业 CA |

最小资源：4 vCPU / 8 GB / 50 GB 起。构建大知识库时嵌入是外部调用，本机压力主要在 Postgres 与向量写入；README 已记录四万条 1536 维向量约半 GB 的量级。

## 4. 代码改动

### R1 Postgres 驱动缝

现状是唯一构造驱动的地方写死了 Neon（[lib/infrastructure/postgres/client.ts](lib/infrastructure/postgres/client.ts)），而 Neon 的 Pool 走 WebSocket，普通 Postgres 接不上——集成测试为此专门起了一个 WebSocket 垫片（`tests/fixtures/wsproxy.mjs`）。

改法：同一个 `db()` 按 `DATABASE_DRIVER` 选择驱动，取值 `neon`（默认，或 host 命中 `.neon.tech` 时自动）与 `postgres`（`drizzle-orm/node-postgres` + `pg.Pool`）。新增 `pg` 依赖，`next.config.mjs` 的 `serverExternalPackages` 加 `pg`。

影响面只有这一个模块：`Database` 类型在两条分支下的查询 API 一致，调用方不感知。顺带的收益是集成测试可以直连 Postgres，`scripts/test-integration.sh` 里的 WebSocket 垫片可以退役（本方案不强制，留给独立的清理）。

风险：两套驱动的事务与连接池语义有细微差别（`node-postgres` 的 `Pool` 需要显式 `max` 与 `idleTimeoutMillis`）。验收要求集成测试在 `DATABASE_DRIVER=postgres` 下全绿。

### R2 构建与镜像

`next.config.mjs` 增加 `output: process.env.SELF_HOST_BUILD ? 'standalone' : undefined`，Vercel 构建路径不受影响。

`docker/self-host/Dockerfile` 三段式：`deps`（`npm ci`）→ `build`（`SELF_HOST_BUILD=1 npm run build`）→ `runner`（`node:24-alpine`，非 root，拷 `.next/standalone`、`.next/static`、`public`，`node server.js`）。镜像内保留 `db/migrations`、`scripts/migrate.mts` 与 `tsx`，供 migrate 容器复用同一个镜像。

注意：Next.js 在容器内会关闭 `.next/cache` 的持久化，ISR/页面缓存不跨重启，这对本产品无影响（页面基本是动态的），无需配置自定义 cache handler。

### R3 迁移执行

新增 `scripts/migrate.mts`：用 `node-postgres` 驱动跑 `drizzle-orm/node-postgres/migrator`，读 `db/migrations/meta/_journal.json`，沿用 drizzle 自己的 `__drizzle_migrations` 记录表，因此与托管版 `npm run db:migrate` 的历史语义一致。`package.json` 增加 `db:migrate:self-host`。

compose 里 `migrate` 是一次性服务，`app` 的 `depends_on` 用 `service_completed_successfully`。升级顺序固定为：停 app → 跑 migrate → 起新 app。

### R4 对象存储的公开端点

现状：`objectStore()` 用同一个 `OBJECT_STORE_ENDPOINT` 既做服务端读写，又做 `signedUrl` / `uploadTicket` 的签名。SigV4 的签名绑定 host，容器内网地址（`http://minio:9000`）签出来的 URL 浏览器解析不了。

改法：新增 `OBJECT_STORE_PUBLIC_ENDPOINT`，`presign()` 用它（未设时回落到 `OBJECT_STORE_ENDPOINT`），`send()` 仍用内网地址。改动集中在 `S3Store.url()` 的调用点，约 10 行。

一体机把公开端点设成 `https://<域名>/s3`，由 Caddy 反代到 MinIO；MinIO 初始化脚本建桶并设置跨域 `PUT` 规则（README 已经写明 S3 模式需要这条 CORS）。

### R5 向量维度参数化

这是唯一一处**装完就不可逆**的选择，必须在首次建库前定下来。

现状：`chunk.embedding vector(1536)`（无向量索引，0013 之后检索先锁版本再精确扫描）、`library_profile_vector.embedding vector(1536) NOT NULL` 带 HNSW 索引 `library_profile_vector_hnsw_idx`；适配器按常量 `EMBEDDING_DIMENSIONS = 1536` 校验提供方返回的宽度（[lib/infrastructure/ai/providers.ts](lib/infrastructure/ai/providers.ts)）。

改法：

1. 常量改为读 `EMBEDDING_DIMENSIONS`（默认 1536，取值范围 1–2000）。上限 2000 来自 pgvector：`vector` 类型的 HNSW 索引拒绝超过 2000 维的列。
2. `scripts/migrate.mts` 在跑完 journal 之后做一次**维度后处理**：读取 `chunk.embedding` 的实际列宽（`information_schema` / `atttypmod`），与目标维度一致则跳过；不一致且两张表都为空，则 `DROP INDEX library_profile_vector_hnsw_idx` → `ALTER TABLE ... ALTER COLUMN embedding TYPE vector(N)`（两张表）→ 重建 HNSW；不一致但表非空，则**直接失败**并给出可执行的提示（清空重建或换回原模型）。
3. 数据库列宽本身就是唯一事实来源，不引入新表、不改 `db/schema.ts`、不写新迁移文件，托管版因此完全不受影响。
4. 约定写进脚本注释与 `docker/self-host/README.md`：**今后任何新增 `vector` 列的迁移，都要把该列登记进 `migrate.mts` 的后处理清单**，否则自托管实例会出现宽度不一致的列。
5. `/api/health`（R10）把“环境变量声明的维度 vs 实际列宽”作为一项检查，不一致报红。

教程需要给出 1536 维的可选模型清单（含可在内网运行的开源模型）与“换模型等于重建全部知识库”的明确警告。

### R6 Redis

零代码。一体机用 `serverless-redis-http` 在 Redis 前面提供 Upstash 兼容的 REST 接口，填 `UPSTASH_REDIS_REST_URL` / `_TOKEN` 即可。整段服务也可以不装：限流与检索缓存会按现有逻辑降级（登录限流失效开、匿名 playground 失败关），教程里如实说明这两种取舍。

### R7 定时任务

零代码。`cron` 容器（supercronic）按 `vercel.json` 的节奏每 10 分钟 `curl -H "Authorization: Bearer $CRON_SECRET" $APP_INTERNAL_URL/api/cron/drain`。`/api/cron/anchor` 默认不启用。自托管没有函数时限，`maxDuration = 300` 只是 Vercel 的提示，长构建反而比托管版宽松。

### R8 形态开关与公开 origin

- `PUBLIC_ORIGIN` 在 `self-hosted` 下取 `APP_BASE_URL`。不改这一处的话，私有实例的首页、库详情页会教用户去连 `https://re0.io/mcp`，这是最容易被用户当成“装错了”的缺陷。
- `DEPLOYMENT_EDITION=self-hosted` 时：隐藏定价页入口、Dashboard 的升级与收益分成入口、状态页的平台级口径改为本实例口径；关闭存证与支付相关 UI。实现上集中成一个 `lib/domain/edition.ts` 的判定函数，页面按它取舍，不散落 `process.env` 判断。

### R9 通用 OIDC 登录

内网隔离环境用不了 GitHub / Google 的回调，这是 M1 的硬需求。

- `IdentityProvider` 由 `'github' | 'google'` 扩成加上 `'oidc'`（[lib/domain/auth.ts](lib/domain/auth.ts)）；`oauth_account.provider` 是无约束的 `text` 列，**不需要迁移**。
- 新增 `lib/infrastructure/identity/oidc.ts`：`${OIDC_ISSUER}/.well-known/openid-configuration` 发现端点，授权码 + PKCE（端口已有 `supportsPkce`），`id_token` 用仓库已依赖的 `jose` 验签，取 `sub` 作 `providerSubject`，`email` / `email_verified` / `name` / `picture` 填 `IdentityProfile`；与现有两家一样，登录不保存提供方令牌。
- 登录页按配置动态渲染按钮：未配置 `OIDC_ISSUER` 时不出现，文案由 `OIDC_DISPLAY_NAME` 指定（例如“企业账号登录”）。
- `handshake.ts` 的 provider 白名单、`begin-oauth` 的回调地址拼接照现有模式扩展；回调地址为 `${APP_BASE_URL}/api/auth/oidc/callback`。
- 验证目标：Keycloak（开源自建）与至少一家企业 IdP（Authing / 飞书 / Azure AD 任一）。

### R10 健康检查

新增 `GET /api/health`：数据库连通、对象存储可写（HEAD 一个探针 key）、队列可读、维度一致性、`self-hosted` 下 OIDC 配置是否可发现。返回 JSON 且不泄露连接串。compose 的 healthcheck 与用户排障都用它。

### R11 文档与索引

- 新增 `docker/self-host/README.md`（运维向，与站点教程页互补）；
- [README.md](./README.md) 的文档地图增加本文件一行；
- [architecture.md](./architecture.md) §3.1 补一句“存在第二种运行形态，见本方案”，§19.1 的环境变量表补自托管增量列。

## 5. 环境变量增量

托管版的完整清单见 architecture.md §19.1。自托管新增或语义变化的部分：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DEPLOYMENT_EDITION` | 是 | `self-hosted` |
| `DATABASE_DRIVER` | 否 | `postgres` / `neon`，默认按 host 自动判断 |
| `DATABASE_URL` | 是 | 指向自有 Postgres（必须装 pgvector） |
| `EMBEDDING_DIMENSIONS` | 否 | 默认 1536，上限 2000，**建库后不可改** |
| `OBJECT_STORE_*` | 是 | 取代 `BLOB_READ_WRITE_TOKEN` |
| `OBJECT_STORE_PUBLIC_ENDPOINT` | 是（一体机） | 浏览器可达的存储地址，用于签名 |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` / `OIDC_DISPLAY_NAME` | 内网必填 | 通用 OIDC 登录 |
| `APP_BASE_URL` | 是 | 同时决定 Cookie 是否走 `__Host-` 前缀 |
| `CRON_SECRET` | 是 | cron 容器与应用共享 |
| `SESSION_SIGNING_SECRET` / `API_KEY_HASH_SECRET` / `CREDENTIAL_ENCRYPTION_KEY` | 是 | 安装时随机生成一次，**丢失等于历史加密行不可读** |
| `APTOS_*` / `PAYMENT_*` | 否 | self-hosted 下留空，功能关闭 |

`.env.example` 与 `docker/self-host/.env.example` 分开维护：后者只列自托管需要的项，并在文件头给出生成密钥的命令。

## 6. 交付物与发布

```
docker/self-host/
  Dockerfile
  compose.yaml
  compose.external.yaml
  .env.example
  Caddyfile
  minio-init.sh
  cron/crontab
  README.md
```

发布：新增 `.github/workflows/release-image.yml`，在打 tag 时用 buildx 构建 amd64 / arm64 并推 `ghcr.io/symphonyprotocollab/re0:<tag>` 与 `:latest`。镜像 tag 与迁移版本绑定，README 的升级章节要求用户先读变更说明再升级。

## 7. 站点改动

- **Header 标签**：`components/site/header.tsx` 的 `nav` 数组新增 `{ href: '/self-hosted', label: t.nav.selfHosted }`。导航是数组驱动的，`MobileNav` 自动跟随；文案进 `lib/i18n/messages/{zh,en}.ts` 的 `nav` 块（“私有部署” / “Self-hosted”）。如需更醒目，给这一项套现有的 `bg-brandsoft text-brandink` 小 pill，不新造样式。
- **教程页** `app/(public)/self-hosted/page.tsx`：沿用 `about` / `pricing` 的版式（`SectionHeading`、`Card`、现有按钮与图标 primitives），全部文案走字典，中英双份。章节顺序：为什么私有部署 → 架构与数据边界 → 前置条件 → 五步快速开始（可复制的 compose 命令块）→ 环境变量表 → 嵌入模型与维度选择（含警告）→ OIDC 对接 → 升级与备份 → 常见问题 → 联系我们。
- middleware 已经为每个页面提供 `.md` 表示，因此 `/self-hosted.md` 天生就是一份可以直接喂给 AI 助手的安装说明，教程页里明说这一点。
- `pricing` 页与 footer 各加一个入口；`hosted` 与 `self-hosted` 两种形态下这个页面都保留（自托管实例里它就是自己的运维手册）。

## 8. 运维

- **备份**：一体机给 `backup.sh`——`pg_dump -Fc` 加 MinIO 数据目录快照，同一时间点成对保存；恢复脚本对应。外接形态由客户自有体系负责。architecture.md §16 的一致性与恢复口径在自托管下同样适用：对象是可重建的，业务库是权威。
- **升级**：停 app → migrate → 起新镜像。跨多个版本升级时按顺序过 migrate，不允许跳。
- **回滚**：镜像可回滚，**迁移不可回滚**；因此发布说明必须标注哪些版本含破坏性迁移，用户需先备份。
- **日志**：应用日志走 stdout，由 Docker 日志驱动收集；请求日志仍落 `request_log` 表，状态页与后台照常可用。

## 9. 安全差异

- **http 部署会降级 Cookie**：`isSecureDeployment()` 以 `APP_BASE_URL` 是否 `https://` 为准，决定是否使用 `__Host-` / `__Secure-` 前缀（[lib/http/cookie-names.ts](lib/http/cookie-names.ts)）。教程默认给 https（Caddy 自动证书或企业 CA），并解释纯 http 的代价。
- **三个加密类 Secret 必须安装时生成并长期保管**，与托管版“三环境同值”的理由一致：它们解密的是落库的行。
- **MinIO 凭据不是默认值**：初始化脚本强制从 `.env` 读取，`.env.example` 里留空而不是给 `minioadmin`。
- **`CRON_SECRET` 不可留空**：留空时 drain 端点直接 401（现有行为），但教程要明确它是防止外部触发构建的唯一屏障。
- **管理后台首位管理员**：空实例访问 `/admin/login` 自助注册第一位管理员，之后关闭该入口。教程要求安装后**立即**完成这一步，否则等于把后台留给了第一个访问的人。

## 10. 分阶段计划与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M1.1 | R1 驱动缝、R2 镜像、R3 迁移、R10 健康检查 | `docker compose up -d` 后实例起来，`/api/health` 全绿，集成测试在 `DATABASE_DRIVER=postgres` 下全绿 |
| M1.2 | R4 存储端点、R5 维度参数、R6 Redis、R7 cron、两套 compose | 上传 PDF → 构建成功 → 检索命中 → 引用链接可下载；改 `EMBEDDING_DIMENSIONS` 在空库上生效、在非空库上被拒绝 |
| M1.3 | R8 形态开关、R9 OIDC、R11 文档、站点 header 与教程页 | 断公网（仅放行内网 IdP 与嵌入服务）跑通：OIDC 登录 → 建库 → 构建 → 检索 → `re0 setup --url http://内网地址/mcp` 连通 |
| M2 | Helm chart、离线镜像包、备份恢复演练、内网模型配置矩阵 | 现场无外网交付一次成功 |

全阶段的硬性门禁：`npm run typecheck` 与 `./scripts/test-integration.sh` 全绿，且托管版的 Vercel 预览部署不受影响。

## 11. 风险与已接受的降级

1. **检索质量取决于用户自备的模型。** 纯内网下嵌入与重排都是用户的服务，效果低于托管版是预期内的，教程必须如实说明，不承诺同等效果。
2. **维度不可逆。** 已在 R5 用“表非空即拒绝”把风险显性化，但仍会有用户装完就改；文档与健康检查是唯一的防线。
3. **MinIO 直传依赖 CORS 配置正确**，配错的表现是浏览器端静默失败，排障成本高；初始化脚本与 `/api/health` 的存储探针一起兜底。
4. **单副本无高可用**，也没有多实例缓存协调；本期只验证单副本，多副本留给 M2 的 Helm。
5. **开源免费意味着无法阻止他人直接商用。** 这是 1.1 的既定选择，本方案不为此增加任何技术措施。
6. **私有部署实例没有链上存证**，`version_anchor` 相关 UI 在 self-hosted 下不出现；日后若有需求，需要用户自备 Aptos 节点与签名账户，属独立提案。

## 12. 待决问题

1. 教程页的路由定名：`/self-hosted` 还是 `/private-deployment`？（本文按 `/self-hosted` 写，`.md` 镜像与 SEO 都更自然）
2. 镜像命名空间是否就用 `ghcr.io/symphonyprotocollab/re0`？是否同时推 Docker Hub？
3. OIDC 首轮除 Keycloak 外，优先适配哪一家企业 IdP？
4. self-hosted 形态下状态页保留到什么程度——只留本实例的构建与调用口径，还是整页隐藏？
5. 私有部署实例是否需要一个“版本与升级提示”（检查 GHCR 最新 tag）？这会产生一次对外请求，与“纯内网”承诺需要权衡，默认关闭是否可接受？

## 13. 参考资料

- [architecture.md](./architecture.md) §3.1 运行边界、§7 对象存储布局、§9.1 向量布局、§16 一致性与恢复、§19.1 环境变量
- [requirement.md](./requirement.md) §2 产品边界、§3.2 三套身份的隔离
- `scripts/test-integration.sh` 与 `.github/workflows/test.yml`：本地 pgvector 的既有跑法，自托管的数据库基线与它保持一致
- Next.js 自托管与 `output: 'standalone'`；pgvector 的 HNSW 维度上限（`vector` 2000 维，`halfvec` 4000 维）
