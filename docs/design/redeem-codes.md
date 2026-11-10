# 兑换码（Redeem codes）设计稿

2026-11-09，基于 `rebuild` 分支 `d3a864e2`。

**状态**：用户 2026-11-09 确认第 9 节全部按推荐默认实现，已在同一 PR 中实现。下文已按实现同步；与最初设计稿不同的地方在第 11 节列出。第二期事项（撤销兑换、Paddle 顺延扣款日、失败尝试表、资格条件、概览统计）不在本次范围。

需求原话：增加兑换码功能，可以兑换 plan 或者是 pack，可以设定一个兑换码可以兑换多少次，以及有效期，可以批量生成。

## 0. 现状（设计依据）

读代码时确认的几件事，下文的取舍都建立在它们上面：

- **只有一个 Plan、一个 Pack**（`lib/constants.ts` 的 `PLAN` / `PACK`，售价与 credits 由 `billing_price` 覆盖）。Plan = Paddle 月订阅，每期一条 `credit_grant(source='plan')`，`expires_at` = 本期结束，过期由续费 webhook 或 `/api/cron/expire-plan`（每天 00:15 UTC）调用 `expirePlanGrants` 清零。Pack = 一次性，`source='pack'`，永不过期，**只卖给 Plan 有效的用户**。没有 Plan 档位之分，所以"同档 / 升档 / 降档"问题在当前产品里不存在，只剩"已有 Plan 时再兑换 Plan"。
- **"Plan 是否有效"完全来自 `subscription` 表**（Paddle 镜像）：`subscriptionOf` + `planIsActive`。它决定四件事：能否买 Pack（`startCheckout` 的 `plan_required`）、侧栏 Plan 用量条（`planUsage`）、生成模型档位（`lib/services/generation.ts` 的 `hasActivePlan` → `'plan' | 'free'`）、后台给 Plan 桶加 credits（`adjustCredits` 的 `no_plan`）。兑换来的 Plan 没有 Paddle 订阅，所以必须把"Plan 有效"从单一来源改成"Paddle 订阅 **或** 兑换的 Plan"。
- **credits 到账统一走 `addGrant`**（`lib/services/credits.ts`）：建 grant、写 `credit_entry`、先还 `credit_debt`。Pack 购买的到账就是 `addGrant({ source: 'pack', reason: 'purchase', purchaseId })`。兑换直接复用 `addGrant`，不复用 `creditTransaction`（它绑定 Paddle transaction、`purchase` 行和金额）。
- **`purchase` 表只记 Paddle 真实付款**：`paddle_transaction_id NOT NULL UNIQUE`，`amount_minor` 用于退款比例和后台财务。兑换不是付款，不写 `purchase`，否则会污染收入统计和退款逻辑。
- 已有可复用的基础设施：`rate_bucket` + `hitRateBucket`（固定窗口限频，`lib/services/explore.ts`；每小时由 rank 任务清理一小时前的窗口）、`admin_audit` + `AUDIT_ACTIONS`、`sealCredential`（`ADMIN_SECRET_KEY` 加密）、`sha256`、`lib/domain/csv.ts`、后台列表的 `format=csv` 约定和 UTC+8 显示。
- 迁移在 `db/migrations`，最新 `0035_infra_cost_rates`（journal `when` = 1794197413808）。

## 1. 概念

| 概念 | 说明 |
| --- | --- |
| 批次 `redeem_batch` | 一次生成动作：兑换什么、每码可用几次、每人可用几次、有效期、状态。所有"承诺"都在批次上。 |
| 兑换码 `redeem_code` | 批次下的一个码，有自己的已用次数和启用状态。 |
| 兑换记录 `redeem_redemption` | 某用户成功兑换某码一次。兑换 Plan 时它同时就是这段"兑换 Plan"（起止时间、每期 credits）。 |

两种典型用法都用同一模型表达：

- **N 个一次性码**（发给 N 个人）：`code_count = N`，`max_redemptions = 1`。
- **1 个多次码**（公开活动码，如 `RE0LAUNCH`）：`code_count = 1`，`max_redemptions = M`（或不限），每人限 1 次。

## 2. 数据模型

### 2.1 `redeem_batch`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid pk | |
| `name` | text not null | 后台内部名称，1–80 字。 |
| `note` | text | 内部备注（渠道、负责人）。 |
| `kind` | text not null | `'plan' \| 'pack'`。 |
| `plan_months` | integer | Plan：1–12 个月；Pack 时为 null。 |
| `pack_quantity` | integer | Pack：1–10 个；Plan 时为 null。 |
| `credits` | bigint not null | **建批次时的快照**：Plan = 每期 credits（当时 `currentUnitCredits('plan')`）；Pack = `pack_quantity × 当时单包 credits`。之后改价不影响已发出的码。 |
| `code_prefix` | text | 可选前缀，2–8 位 `[A-Z0-9]`。 |
| `code_count` | integer not null | 1–10,000。 |
| `max_redemptions` | integer | 每个码可兑换次数（1–1,000,000，默认 1），null = 不限（只允许 `code_count = 1` 时为 null）。 |
| `per_user_limit` | integer not null default 1 | **同一用户在整个批次内**最多兑换次数（1–1,000，见 4.4）。 |
| `starts_at` | timestamptz not null | 默认创建时刻。 |
| `expires_at` | timestamptz | null = 不过期（不推荐，后台默认填 90 天后）。 |
| `status` | text not null default `'active'` | `'active' \| 'disabled'`。 |
| `redemption_count` | integer not null default 0 | 冗余汇总，列表展示用，和码上的计数同事务更新。 |
| `created_by` | uuid → administrator，`on delete set null` | |
| `created_at` / `updated_at` | timestamptz | |

约束：`kind` / `status` 的 check；`(kind = 'plan') = (plan_months is not null)`、`(kind = 'pack') = (pack_quantity is not null)`；`plan_months between 1 and 12`、`pack_quantity between 1 and 10`、`credits between 1 and 100000000`；`max_redemptions is null or max_redemptions >= 1`；`max_redemptions is not null or code_count = 1`；`per_user_limit >= 1`；`expires_at is null or starts_at < expires_at`。
索引：`(created_at desc)`、`(status, expires_at)`。

### 2.2 `redeem_code`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid pk | |
| `batch_id` | uuid not null → redeem_batch | |
| `code_digest` | text not null | `sha256('redeem:' + 规范化后的码)`（base64url，同 `api_key` 的写法），**unique**，查询入口。 |
| `code_sealed` | text not null | `sealCredential(code, 'redeem_code')`，供后台再次导出（见 3.4）。 |
| `code_last4` | text not null | 后四位明文，列表展示 / 模糊搜索。 |
| `max_redemptions` | integer | 从批次复制，便于单行原子判断。 |
| `redemption_count` | integer not null default 0 | |
| `status` | text not null default `'active'` | `'active' \| 'disabled'`，单码可单独停用。 |
| `last_redeemed_at` | timestamptz | |
| `created_at` | timestamptz | |

约束：`unique(code_digest)`；`redemption_count >= 0 and (max_redemptions is null or redemption_count <= max_redemptions)`（并发兜底，正常路径不会触发）。索引：`(batch_id, created_at)`、`(batch_id, code_last4)`。

### 2.3 `redeem_redemption`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid pk | |
| `code_id` | uuid not null → redeem_code | |
| `batch_id` | uuid not null → redeem_batch | 冗余，便于按批次统计与每人限次计数。 |
| `user_id` | uuid not null → user | |
| `kind` | text not null | 快照 `'plan' \| 'pack'`。 |
| `credits` | bigint not null | Pack：本次到账总额；Plan：每期额度。 |
| `plan_months` | integer | Plan 才有。 |
| `plan_starts_at` / `plan_ends_at` | timestamptz | Plan 才有，见 4.2。 |
| `request_id` | uuid | 客户端每次提交生成的幂等键。 |
| `ip_hash` | text | `HMAC(ADMIN_SECRET_KEY, 日期 + ip)`，排查滥用用，不存明文 IP（11.1）。 |
| `user_agent` | text | 截断到 200 字。 |
| `revoked_at` / `revoked_by` | timestamptz / uuid（`on delete set null`） | 预留给后台撤销（第二期，见 Q5），本次没有任何代码写它。 |
| `created_at` | timestamptz | |

约束：`(kind = 'plan') = (plan_starts_at is not null and plan_ends_at is not null and plan_months is not null)`。
索引：`unique(user_id, request_id) where request_id is not null`（幂等）；`(batch_id, user_id)`（每人限次计数）；`(code_id, created_at)`；`(user_id, plan_ends_at) where kind = 'plan' and revoked_at is null`（查当前 / 排队中的兑换 Plan）。

### 2.4 现有表的改动

- `credit_grant`：新增 `redemption_id uuid → redeem_redemption`、`redemption_period smallint`。`unique(redemption_id, redemption_period) where redemption_id is not null` 保证每期只发一次；check `purchase_id is null or redemption_id is null`。Pack 兑换只有 period 0；Plan 兑换每月一条（0..months-1）。`source` 仍是 `'plan'` / `'pack'`，**扣费顺序和 Plan 过期逻辑完全不用改**。
- `credit_entry`：`CREDIT_ENTRY_REASONS` 增加 `'redeem'`（check 约束换一次）。`ref_id` = redemption id，`note` 形如 `redeem ····7KQ2 · plan 1/3` 或 `redeem ····7KQ2 · pack x2`。不写完整码，也不写批次名（批次名是后台内部名称，用户的账本里看得到 note）。
- `AUDIT_ACTIONS` 增加 `redeem.batch.create`、`redeem.batch.update`（改名 / 备注 / 有效期 / 启停）、`redeem.batch.export`、`redeem.code.reveal`、`redeem.code.disable`、`redeem.code.enable`；第二期再加 `redeem.redemption.revoke`。`admin_audit.action` 是 text，无约束要改。
- `CredentialPurpose` 增加 `'redeem_code'`。

### 2.5 迁移

一个迁移 `0036_redeem_codes.sql` + drizzle 快照（`drizzle-kit generate` 生成），journal `when` = 1794234669018，大于本地库 `drizzle.__drizzle_migrations` 中已应用的最大值 1794197413808。内容：建三张表与索引、`credit_grant` 加两列与约束、`credit_entry_reason_check` 换约束。不写 `BEGIN` / `ON COMMIT DROP`（`test-integration.sh` 逐句自动提交）。纯新增，无需回填。

## 3. 码的格式与生成

### 3.1 格式

- 字符集 30 个：`ABCDEFGHJKMNPQRSTVWXYZ23456789`，去掉易混的 `0 O 1 I L U`。
- 随机部分 12 位，展示分 3 组：`7KQ2-M9XA-RT4H`；有前缀时 `SPRING-7KQ2-M9XA-RT4H`。
- 熵：30¹² ≈ 5.3×10¹⁷（约 59 bit）。配合第 5 节限频，暴力猜测不可行；即使 10,000 个码同时有效，单次猜中概率约 2×10⁻¹⁴。
- **自定义码**：仅当 `code_count = 1` 时允许管理员手填（如 `RE0LAUNCH`，6–32 位 `[A-Z0-9]`，不受字符集限制）。这种码低熵、可被猜到，适合本来就要公开传播的活动码。

### 3.2 规范化

用户输入和生成都先规范化再算 digest：转大写、去掉空格和 `-`、全角转半角。随机部分不做 `O→0` 之类的纠错（这些字符本来就不会出现）；规范化后长度不在 6–40、或含 `[A-Z0-9]` 之外字符的，直接按 `invalid_code` 拒绝，不查库。

### 3.3 生成

- 服务端用 `crypto.getRandomValues` + 拒绝采样（避免取模偏差）生成。
- 一个事务内：插入批次 → 每 500 个码一组 `insert … on conflict (code_digest) do nothing returning`，冲突的重新生成补齐（理论上不会发生），最后断言总数 = `code_count`。10,000 个码 × 加密开销在一次请求内可完成；实现时测一下耗时，必要时把上限降到 5,000。
- 创建接口直接返回本批次的明文码（JSON），前端立刻提供"下载 CSV"和"复制全部"。
- 自定义码已存在时整批回滚，返回 `custom_code_taken`。

### 3.4 明文还是哈希？

推荐 **digest 查询 + 加密保存原文 + 明文后四位**，和 `api_key` 的 digest/last4 做法一致，再加一份 `code_sealed`：

- 查询只用 `code_digest`，数据库里没有可直接使用的明文码；只读的 DB 泄露拿不到可兑换的码（还需 `ADMIN_SECRET_KEY`）。
- 运营经常需要"再导出一次"或"把第 37 个码发给谁"，所以保留加密原文，后台导出时解密；每次导出写 `redeem.batch.export` 审计。
- 备选：只存 digest、码只在生成时下载一次（像 API key）。更安全，但 CSV 丢了就只能作废重发。列为开放问题 Q4。

### 3.5 CSV 导出

码 CSV 列：`code, batch, kind, target, credits, max_redemptions, redemptions, status, starts_at, expires_at`（时间 UTC+8，和其他后台导出一致）。兑换记录 CSV 列：`redeemed_at, user_email, user_id, code_last4, batch, kind, credits, plan_starts_at, plan_ends_at`。走 `lib/domain/csv.ts`，`format=csv` 约定同其他后台列表。

## 4. 兑换语义

### 4.1 兑换 Pack

`addGrant({ source: 'pack', amount: credits, reason: 'redeem', refId: redemption.id, redemptionId, redemptionPeriod: 0, note })`，永不过期，先还欠款（`addGrant` 已有逻辑）。

**不要求 Plan 有效**（推荐）：Pack"只卖给 Plan 用户"是销售规则，兑换码是赠送，由发码方决定发给谁。见 Q2。

### 4.2 兑换 Plan："兑换的 Plan"

兑换 Plan 不创建 Paddle 订阅，而是一段 `[plan_starts_at, plan_ends_at)` 的会员期，按自然月切成 `plan_months` 期，**每期发一次 Plan credits**，和付费 Plan 完全同构：

- 第 k 期：`[addMonths(start, k), addMonths(start, k+1))`（UTC，与 `creditTransaction` 的 `addMonth` 兜底一致）。
- 每期一条 `credit_grant(source='plan', expires_at=期末, period_start=期初, redemption_id, redemption_period=k)`，额度 = 快照的 `credits`。期末未用完照常由 `expirePlanGrants` 清零——**不把 3 个月的额度一次性给齐**，否则会变成"3 倍额度、3 个月有效"，和付费 Plan 的语义不同。
- 兑换时若立即生效，当场发第 0 期；排队的兑换到点后由 cron（`/api/cron/plan-redemptions`，最初为每小时 `20 * * * *`，现为每分钟 `* * * * *`，见 11.2，已登记在 `vercel.json`）发第 0 期，之后各期也由它在每期开始后发放。幂等靠 `unique(redemption_id, redemption_period)` 和发放前的存在检查；cron 按 `next_period_at` 取到期行、`for update skip locked`，重叠运行不会重复发。发新一期前先 `expirePlanGrants(userId, cutoff=max(期初, now))`，同续费 webhook。cron 整月都没跑到的期次不补发（那一期的额度到现在已经过期了），只发当前期。到账延迟（现最多约一分钟）期间，侧栏按现有逻辑显示"本期未使用"（`planUsage` 对"本期 grant 未到"已有处理），额度取兑换时的快照。

**Plan 有效的判定**改为统一的 `planStateOf(executor, userId, now)`：

```
active Paddle subscription（planIsActive）  → { active, source: 'paddle', periodStart/End, cancelAtPeriodEnd }
否则 now 落在某条未撤销的兑换 Plan 内        → { active, source: 'redeemed', periodStart/End = 当期, endsAt = 整段兑换的最晚结束 }
否则                                          → { active: false }
```

`hasActivePlan`、`startCheckout` 的 Pack 门槛、`currentPlanUsage`、后台用户列表的 `planActive` 和 `adjustCredits` 的 Plan 桶（`expiresAt` 取当期期末）全部改用它。于是兑换了 Plan 的用户可以买 Pack、用 Plan 档生成模型、看到 Plan 用量条——和付费用户一致。

### 4.3 与 Paddle 订阅、与其他兑换的叠加

只有一个 Plan 档，所以只需处理"已有 Plan 时又兑换 Plan"：

| 用户当前状态 | 兑换 Plan 的结果 |
| --- | --- |
| 无 Plan | 立即生效：`starts_at = now`。 |
| 已有兑换 Plan（生效中或排队中） | **顺延**：`starts_at` = 该用户所有未撤销兑换 Plan 的最晚 `plan_ends_at`。时长累加，不叠加同期额度。 |
| Paddle 订阅有效、**已关闭续费**（`cancel_at_period_end`） | 排队：`starts_at = max(当前期末, 已有兑换 Plan 的最晚结束)`，Paddle 期满后无缝接上。 |
| Paddle 订阅有效、**会自动续费** | **拒绝**，`plan_subscription_renewing`。提示"关闭自动续费后再兑换，兑换的 Plan 会在本期结束后接上"。否则下期 Paddle 照常扣款，用户等于花钱又兑换了一份。 |
| Paddle 订阅 `past_due` / `paused`（库里存 `expired`） | 拒绝，`plan_renewal_pending`，与结账的 `renewal_pending` 一致。 |

反方向（兑换 Plan 生效 / 排队中再去 Paddle 订阅）：`startCheckout` 对 Plan 增加一个拒绝 `plan_redeemed_active`（409）；余额页 Plan 卡的按钮变成禁用的"兑换的 Plan 到期后可订阅"。同理，兑换 Plan 排在一个已关续费的 Paddle 期之后时，不能再恢复 Paddle 续费（`plan_redeemed_queued`，11.1）。为了让兑换和结账互斥，兑换 Plan 时拿同一把 `pg_advisory_xact_lock(hashtext('checkout:' || userId))`，并像 `checkoutAttempt` 那样作废该用户一小时内未完成的 Plan checkout（`cancelCheckoutTransaction` + `superseded_at`）。

兜底：如果兑换后仍有一笔之前打开的 Plan 付款到账（overlay 已在别的标签页付了），webhook 照常记账（钱已收），沿用现有"user paid for a second Plan"的 warn，管理员在交易页处理。不做自动退款。

Paddle 自动续费用户想用兑换码的更好体验是"把 Paddle 的下次扣款日顺延 N 个月"（Paddle 支持改 `next_billed_at` + `do_not_bill`），但这把兑换和 Paddle API 耦合在一起，失败模式多，推荐放第二期。见 Q1。

### 4.4 次数限制

- **每码次数** `max_redemptions`：码行上的原子条件更新保证不超发（见 4.5）。
- **每人次数** `per_user_limit`：在**批次**范围内计数，默认 1。这样"N 个一次性码"的批次也能防止一个人收集多个码重复领取；对"1 个多次码"的批次，批次范围就等于码范围。
- 同一用户、不同批次互不影响（两个活动可以各领一次）。

### 4.5 并发与幂等

`POST /api/billing/redeem` 的事务顺序（锁顺序固定，避免死锁）：

1. 事务外：校验登录、限频占位（第 5 节、11.1）、规范化、算 digest。
2. `pg_advisory_xact_lock(hashtext('checkout:' || userId))`——同一用户的兑换之间、兑换与结账之间串行。
3. 若带 `request_id` 且 `(user_id, request_id)` 已有记录、且记录的码就是本次的码：直接返回那条记录的结果（双击 / 重试不重复兑换）。码不同按新请求处理（11.1）。
4. `select … from redeem_code join redeem_batch where code_digest = $1 for update of redeem_code`——同一个码的并发兑换在这里排队。
5. 校验：批次与码均 `active`；`starts_at <= now`；`expires_at is null or now < expires_at`；`count(*) from redeem_redemption where batch_id and user_id and revoked_at is null` < `per_user_limit`；Plan 时按 4.3 判定。
6. `update redeem_code set redemption_count = redemption_count + 1, last_redeemed_at = now where id = $1 and (max_redemptions is null or redemption_count < max_redemptions) returning`——返回 0 行即 `code_exhausted`。有第 4 步的行锁其实已经串行，这里再用条件更新 + check 约束双保险。
7. 批次 `redemption_count + 1`；插入 `redeem_redemption`；Pack 调 `addGrant`，Plan 计算起止并在 `starts_at <= now` 时发第 0 期。
8. 提交。任何一步失败整体回滚，码次数不会被白白消耗。

### 4.6 到期与停用对已兑换的影响

- 批次 / 码过期或停用：只阻止**之后**的兑换；已兑换的 credits 与兑换 Plan 不受影响。
- 兑换 Plan 到期：`plan_ends_at` 之后 `planStateOf` 不再视为有效；最后一期 grant 的 `expires_at` = `plan_ends_at`，由每日 `expire-plan` cron 清零（与已取消的 Paddle Plan 相同）。Pack credits（买的和兑换的）不过期，但再买 Pack 需要 Plan 有效——和现在一致。

## 5. 防滥用

- **限频**（只统计"猜码类"失败：`invalid_code`、`code_not_found`）：每用户 15 分钟 5 次、每 IP 15 分钟 20 次、每用户 1 小时 20 次；超过后返回 429 `too_many_attempts`（带 `retryAfter`），**在查库前**就拒绝。复用 `rate_bucket`，把 `hitRateBucket` 从 `explore.ts` 提到公共的 `lib/services/rate-limit.ts`，并加一个原子的 `takeRateSlots`（查库前占位，非猜码结果再退回，见 11.1；最初设计的只读 `peekRateBucket` 先看后计数，并发下不成立）。窗口不超过 1 小时，正好落在现有每小时清理范围内。常量加到 `lib/constants.ts` 的 `REDEEM_RATE_LIMIT`。
- 真实存在但不可用的码（过期、用完、停用、已兑换过）不计入限频：持有真码的人不是在猜。
- **错误分级**：上述真实码的错误会告诉用户具体原因（体验优先）；格式错误和查无此码统一为 `code_not_found`，不区分"格式对但不存在"。
- **审计**：
  - 成功兑换：`redeem_redemption` 本身就是审计记录（谁、哪个码、何时、`ip_hash`、UA、得到什么），后台可按批次 / 用户查看导出；用户侧账本有 `redeem` 流水。
  - 后台操作：`admin_audit`（建批次、改有效期、启停、导出）。
  - 失败尝试：MVP 只在服务端日志记一行（`console.info`：user、ip_hash 前 8 位、错误码、digest 前 8 位），不建表。确有需要再加 `redeem_attempt` 表（Q7）。
- 停用的账号没有会话，无法兑换；官方账号允许兑换。

## 6. 界面

### 6.1 后台（`/admin/redeem-codes`）

导航放在"价格与促销"之后，key `redeem-codes`。

- **批次列表**：名称、兑换内容（"Plan · 3 个月 · 50,000/月" / "Pack × 2 · 200,000"）、码数、已兑换 / 总容量（不限时显示"已兑换 N"）、有效期、状态、创建人与时间。筛选：状态（生效 / 未开始 / 已过期 / 已停用）、类型、时间；搜索：批次名，或**粘贴完整码**（按 digest 精确定位到批次和码），或后四位。
- **新建批次**（弹窗，沿用 `console-modal`）：
  - 名称、备注；
  - 兑换内容：Plan（月数 1–12）或 Pack（数量 1–10），下方实时显示当前单价对应的 credits 快照；
  - 生成方式：「多个一次性码」（数量 N，每码 1 次）／「一个多次码」（总次数 M 或不限，可选自定义码）；高级里可改每码次数和每人次数；
  - 前缀（可选）、生效时间（默认现在）、过期时间（默认 90 天后，UTC+8 输入，与其他后台页面一致）。
  - 提交后进入结果页：显示全部码，按钮"下载 CSV""复制全部"。
- **批次详情** `/admin/redeem-codes/[id]`：
  - 头部：批次信息、进度、"停用 / 启用批次"、"修改有效期"、"导出码 CSV"、"导出兑换记录 CSV"。批次的兑换内容、次数限制创建后不可改（它们是对持码人的承诺）；需要不同条件就新建批次。
  - 「兑换码」表：码（默认只显示 `····7KQ2`，点"显示"解密并记 `redeem.code.reveal` 审计）、已用 / 上限、状态（可兑换 / 已用完 / 已停用）、最近兑换时间、单码停用 / 启用。两个表是顶栏的两个 tab（`?tab=codes|redemptions`）。
  - 「兑换记录」表：时间、用户（链接到 `/admin/users/[id]`）、码后四位、得到的 credits / Plan 起止。
- 用户详情页 `/admin/users/[id]`：「充值」tab 底部增加"兑换记录"表（链接到对应批次）；顶部 Plan 余额卡在兑换 Plan 生效时显示"兑换的 Plan 至 X"。后台"给 Plan 桶加 credits"对兑换 Plan 同样可用，到期时间取当期期末。

### 6.2 用户侧

- 位置：`/settings?tab=balance`（余额 tab），在 Plan / Pack 两张卡下方加一张"兑换码"卡：一个输入框 + "兑换"按钮。输入时自动大写并按 4 位加 `-`。定价页 Plan 卡下加一个小链接"有兑换码？"指向这里。
- 支持 `/redeem?code=XXXX` 链接：302 到 `/settings?tab=balance&code=XXXX`，预填但**不自动提交**（未登录先走登录再回来）。
- 结果状态（卡内行内提示，成功后刷新余额与侧栏）：
  - Pack：「兑换成功，200,000 credits 已到账。」
  - Plan 立即生效：「兑换成功，Plan 有效至 2027-02-09，本期 50,000 credits 已到账。」
  - Plan 排队：「兑换成功，Plan 将于 2026-12-01 生效，有效至 2027-03-01。」
  - 各错误码对应文案（见第 7 节）。
- Plan 卡：来源为兑换时，续费行显示「兑换的 Plan，有效至 {date}」，不显示续费开关；排队中的兑换显示「另有兑换的 Plan 将于 {date} 接续」。
- 账本：`redeem` 原因显示为「兑换码」，归在"全部"；`summary.purchases`（充值到账）不计入兑换。

### 6.3 i18n 键（zh / en 各一份）

- `i18n/pages/billing.ts`：`reasons.redeem`；`redeem.{title, hint, placeholder, submit, submitting, link}`；`redeem.success.{pack, plan, planQueued}`；`redeem.errors.{code_not_found, code_not_started, code_expired, code_disabled, code_exhausted, already_redeemed, plan_subscription_renewing, plan_renewal_pending, too_many_attempts, generic}`；`plan.redeemedUntil`、`plan.redeemedNext`、`plan.resumeBlocked`；`errors.plan_redeemed_queued`；结账页 `errors.plan_redeemed_active`。
- 新文件 `i18n/pages/redeem-admin.ts`（`t.redeemAdmin`）：列表、表单、结果、详情、状态、错误、用户页兑换记录；`console.nav['redeem-codes']`；审计动作名称 `redeem.batch.create` 等（审计搜索按本地化名称匹配）。CSV 表头是英文，与其他后台导出一致。
- `i18n/pages/site.ts`：结账错误 `plan_redeemed_active`；定价页 Plan / Pack 卡下方"有兑换码？"链接到余额页兑换卡。

## 7. API 与错误码

用户侧：

| 路由 | 说明 |
| --- | --- |
| `POST /api/billing/redeem` | body `{ code, requestId }`。200 `{ kind, credits, plan?: { startsAt, endsAt, queued }, balance }`。 |

| 错误码 | HTTP | 计入限频 | 含义 |
| --- | --- | --- | --- |
| `unauthenticated` | 401 | – | 未登录。 |
| `too_many_attempts` | 429 | – | 限频，带 `retryAfter` 秒数。 |
| `code_not_found` | 400 | 是 | 格式不对或不存在。 |
| `code_not_started` | 400 | 否 | 未到生效时间（返回 `startsAt`）。 |
| `code_expired` | 400 | 否 | 已过期。 |
| `code_disabled` | 400 | 否 | 码或批次已停用。 |
| `code_exhausted` | 409 | 否 | 次数已用完。 |
| `already_redeemed` | 409 | 否 | 达到本批次每人上限。 |
| `plan_subscription_renewing` | 409 | 否 | 有自动续费中的 Paddle Plan。 |
| `plan_renewal_pending` | 409 | 否 | Paddle 订阅 past_due / paused。 |

后台（均经 `apiAdministrator`，失败走 `adminFailure`）：

| 路由 | 说明 |
| --- | --- |
| `GET /api/admin/redeem-batches` | 列表：`q`、`status`、`kind`、`period`、`sort`、`size`、`page`；`format=csv`。 |
| `POST /api/admin/redeem-batches` | 建批次，返回批次与明文码（201）。错误（422，`custom_code_taken` 409）：`invalid_name`、`invalid_note`、`invalid_kind`、`invalid_target`、`invalid_count`、`invalid_limits`、`invalid_window`、`invalid_prefix`、`invalid_custom_code`、`custom_code_taken`。 |
| `GET /api/admin/redeem-batches/[id]` | 详情与统计。 |
| `PATCH /api/admin/redeem-batches/[id]` | 仅 `name`、`note`、`status`、`expiresAt`。 |
| `GET /api/admin/redeem-batches/[id]/codes` | 码列表（掩码）；`format=csv` 导出明文并审计。 |
| `POST /api/admin/redeem-codes/[id]/reveal` | 解密单个码，审计（用 POST，因为每次都会写审计）。 |
| `PATCH /api/admin/redeem-codes/[id]` | `status`；错误 `invalid_status`。 |
| `GET /api/admin/redeem-batches/[id]/redemptions` | 兑换记录；`format=csv`。 |
| 第二期：`POST /api/admin/redemptions/[id]/revoke` | 撤销一次兑换（见 Q5）。 |

`GET /api/cron/plan-redemptions`：补发到期的兑换 Plan 各期 credits；按 `CRON_SECRET` 鉴权，同其他 cron。

代码位置：码生成 / 规范化、批次参数校验、排队起点放 `lib/domain/redeem.ts`；Plan 期次（`addMonths`、`redeemedPeriod`）和 Plan 状态（`planStateFrom`）与其他 Plan 规则一起放 `lib/domain/billing.ts`；`planStateOf` / `redeemedPlansOf` 在 `lib/services/billing.ts`；兑换事务和 cron 在 `lib/services/redeem.ts`；后台在 `lib/services/admin-redeem.ts`；固定窗口限频从 `explore.ts` 提到 `lib/services/rate-limit.ts`（`explore.ts` 原样转导出）。`/redeem?code=` 是 `app/redeem/route.ts`。

## 8. 测试计划

单元（vitest）：

- 码生成：只含字符集字符、长度与分组、前缀、拒绝采样分布大致均匀；规范化（大小写、空格、`-`、全角）。
- 批次参数校验的每个错误分支；credits 快照计算。
- Plan 期次切分：月底（1/31 → 2/28）、跨年；排队起点的选取（无 Plan / 兑换 Plan 排队 / Paddle 已关续费 / 两者都有）。
- `planStateOf` 各组合。

集成（`./scripts/test-integration.sh`，本地 Docker Postgres）：

1. 建批次（N 个一次性码 / 1 个多次码 / 自定义码），码数、digest 唯一、CSV 解密导出与审计。
2. 兑换 Pack：grant `source='pack'` 不过期、流水 `redeem`、先还欠款、没有 Plan 也可以兑换。
3. 兑换 Plan（3 个月）：立即发第 0 期并 `expires_at` 正确；时间推进后 cron 发第 1、2 期且重复运行不重复发；上一期剩余被 `expire`；结束后 `hasActivePlan` 为 false；期间可买 Pack（`startCheckout` 不再 `plan_required`）、生成走 `plan` 档。
4. 叠加：兑换 Plan 顺延；Paddle 已关续费时排队；Paddle 自动续费时 `plan_subscription_renewing`；`past_due` 时 `plan_renewal_pending`；兑换 Plan 生效时 Plan 结账被拒 `plan_redeemed_active`；兑换会作废打开中的 Plan checkout。
5. 次数：`max_redemptions = 3` 时 10 个用户并发兑换只成功 3 个，`redemption_count = 3`；`per_user_limit = 1` 时同一用户用同批次两个码，第二个 `already_redeemed`；同一 `requestId` 重放返回同一结果且只兑换一次。
6. 有效期与状态：未开始、已过期、批次停用、单码停用；停用后已兑换的 credits 不变。
7. 限频：连续 5 次 `code_not_found` 后第 6 次 429 且不查库；真实但过期的码不计数。
8. 账本一致：所有场景结束后，grant 余额之和 = 流水之和（对账辅助放进 `tests/integration/billing-audit.ts`，和 `debtOf` 等放在一起）。
9. 后台权限：各路由都走 `apiAdministrator`（与其他后台路由相同）。本次没有为它单独写测试——路由处理依赖 Next 的请求上下文，集成测试只测服务层。

浏览器验收（需要用户登录后台一次）：建批次 → 下载 CSV → 用户侧兑换 Pack 和 Plan → 余额卡、侧栏 Plan 条、账本、后台兑换记录都对得上。

## 9. 开放问题（附推荐默认）

| # | 问题 | 推荐默认 |
| --- | --- | --- |
| Q1 | Paddle 自动续费中的用户兑换 Plan 怎么办？ | MVP 拒绝并提示先关闭续费，兑换的 Plan 会在本期结束后接上。第二期再考虑调用 Paddle 把下次扣款日顺延 N 个月。 |
| Q2 | 兑换 Pack 是否要求 Plan 有效（付费购买 Pack 有此要求）？ | 不要求，兑换码是赠送，发给谁由运营决定。 |
| Q3 | 兑换 Plan 的 credits 是每月发一次，还是一次给齐？ | 每月发一次、每期月底过期，和付费 Plan 一致。 |
| Q4 | 码存加密原文（可再次导出），还是只存哈希（生成时只能下载一次）？ | 存 digest + 加密原文 + 后四位，导出和"显示"都记审计。 |
| Q5 | 是否需要"撤销已兑换"？ | MVP 不做，只能停用批次 / 码阻止之后的兑换。第二期：撤销时结束兑换 Plan、不再发后续期，并收回对应 grant 中**剩余**的 credits，已花掉的不记欠款。 |
| Q6 | 每人次数按批次算还是按码算？ | 按批次，默认 1。 |
| Q7 | 失败尝试是否落表供后台查看？ | MVP 只写服务端日志；出现滥用迹象再加 `redeem_attempt` 表。 |
| Q8 | 是否需要"仅新用户可兑换"等资格条件？ | MVP 不做；需要时在批次上加 `eligibility`（如注册时间晚于某日）。 |
| Q9 | 批次上限和有效期默认值？ | 每批最多 10,000 个码；过期时间默认 90 天，可清空为不过期；Plan 1–12 个月，Pack 1–10 个。 |
| Q10 | 后台概览 / 财务是否展示兑换？ | 兑换不计收入。概览加一个"本期兑换发放 credits"数字，可放第二期。 |

## 10. 实施顺序（review 通过后）

1. 迁移 + schema + `lib/domain/redeem.ts` 及单元测试。
2. `planStateOf` 替换所有 Plan 有效判定（独立一步，单独验证付费 Plan 行为不变）。
3. 兑换服务、`POST /api/billing/redeem`、限频、cron，以及集成测试。
4. 后台 API 与页面、CSV、审计。
5. 用户侧兑换卡、Plan 卡状态、账本文案、i18n。
6. 本地浏览器验收；PR 指向 `rebuild`，不创建 Preview 部署。

## 11. 实现记录（2026-11-09）

与上文最初设计稿的差异，以及实现时补充的决定：

- **digest**：`sha256('redeem:' + 码)` 的 base64url（沿用 `lib/infra/crypto/tokens.ts` 的 `sha256`），不是 hex。
- **账本 note 不写批次名**：批次名是后台内部名称，而 note 用户在账本里看得到。
- **新增审计动作** `redeem.code.reveal`；"显示"接口改为 POST。
- **管理员外键** `created_by` / `revoked_by` 为 `on delete set null`，删除管理员不受兑换码批次阻挡（集成测试 `admin.test.ts` 会清空管理员表）。
- **Plan 有效判定**统一为 `planStateOf`（`lib/services/billing.ts`），替换了 `hasActivePlan`、Pack 结账门槛、侧栏 / 余额页 Plan 用量、后台用户 `planActive`、后台给 Plan 桶加 credits。Paddle 订阅相关的续费开关（`setRenewal`）是否可用仍只看 Paddle 订阅；恢复续费另有兑换 Plan 的限制，见 11.1。后台用户列表的"会员状态"筛选仍是 Paddle 订阅状态，没有改。
- **`planUsage`** 新增 `source`（`paddle` / `redeemed`）、`redeemedUntil`、`redeemedNext`；兼容旧的传 Paddle 订阅的调用。
- **Plan 结账拒绝 `plan_redeemed_active`** 的条件是"存在任何未结束的兑换 Plan"（生效中或排队中）。
- **cron 不补发错过的整月**，只发当前期（见 4.2）。
- **限频**：只有 `code_not_found`（含格式不对）计数；超限时在查库前返回 429 和 `retryAfter`（响应头 `retry-after` 同步）。

### 11.1 Code review 修正（2026-11-10）

- **兑换的 Plan 在时不能恢复 Paddle 续费**：`setRenewal('resume')` 在用户有任何未结束的兑换 Plan（生效中或排队中）时拒绝，错误码 `plan_redeemed_queued`（409），在调用 Paddle 之前。否则 Paddle 会在本期末 T 扣款续费，cron 又在 T 发兑换 Plan 的第一期，同一段时间出现两个 Plan。余额页 Plan 卡在"Paddle 已关续费 + 兑换 Plan 排队"时不显示"恢复续费"，换成禁用的"已兑换 Plan，无需恢复续费"。`/api/billing/subscription` 的错误码映射改为：`invalid_action` 400，其余 409。
- **限频改为原子的"先占位、后判断"**（替换 5 节的 `peekRateBucket` 先看后计数）：`lib/services/rate-limit.ts` 新增 `takeRateSlots`，在查库前对该用户和该 IP 的每个窗口各做一次原子 `+1`（`insert … on conflict do update … returning hits`）。任一窗口超限，全部退回并返回 429；没超限就放行，事后看结果：`code_not_found`（含格式不对）保留占位，其他结果（成功、过期、用完、停用、已兑换、重放、异常）退回占位。这样每个窗口内"已计数的猜错 + 进行中的尝试"不会超过上限，N 个并发请求不会都看到 0 而同时查库。和原设计的差别：进行中的真码兑换也暂时占位，所以同一用户同时发出超过上限个请求时，超出的会被 429，哪怕它们是真码；顺序发出的真码兑换不受影响。超限被拒的尝试不计数（与原来一致），所以连续撞限不会把 1 小时窗口也撑满。
- **重放核对码**：带 `requestId` 的重放只在已存记录的码 digest 与本次提交的一致时才返回原结果；同一 `requestId` 配另一个码，按新请求处理，存记录时不带这个 `requestId`（它已被占用）。
- **`ip_hash` 改为 HMAC**：`hmacSha256(ADMIN_SECRET_KEY, 'redeem-ip:' + 日期 + ':' + ip)`，仍按天加盐。原来的 `sha256(ip + 公开日期)` 可以枚举全部 IPv4 反推出 IP。不新增环境变量。改动前写入的 `ip_hash` 与改动后的不可比较，影响只限于排查用途。
- **先判每人次数，再判用完**：用户再次输入自己用过的一次性码，得到 `already_redeemed` 而不是 `code_exhausted`。
- **CSV 导出全有或全无**：任何一个码解不开（`ADMIN_SECRET_KEY` 换过），导出失败并返回 `sealed`（409），与"显示"一致；不写空码，也不记 `redeem.batch.export` 审计。
- **用户侧 `requestId`**：只在拿到明确答复（2xx 或 4xx）后才换新的；5xx、网络错误或超时后再点兑换，沿用原 `requestId`，已提交但响应丢失的兑换会被重放，而不是再兑换一次。

### 11.2 第二轮修正：按期到点发放（2026-11-10）

11.1 当时留下的三件事已处理：

- **期初空档缩到一分钟内**：`redeem_redemption` 新增 `next_period_at`（迁移 `0037_redeem_next_period`）：下一个还没发的月份的开始时间，最后一期发出后为 null，Pack 恒为 null。兑换时写入：排队的是 `plan_starts_at`，立即生效的（当场发了第 0 期）是第 1 期的开始。cron 改为每分钟（`* * * * *`），只读 `next_period_at <= now` 的行（部分索引 `redeem_redemption_next_period_idx`），发 `now` 所在的那一期（仍不补发整月错过的期），然后把 `next_period_at` 推到再下一期或 null。没有到期行时，一次运行只是一条走索引的查询。于是每期开始（包括排在 Paddle 期末或上一个兑换 Plan 之后的第一期）到额度到账最多约一分钟，而不是一小时。没有采用"提前发下一期"，因为 `availableOf` 不看 `period_start`，提前发的额度当场就能花。
- **cron 不再做全表聚合**：去掉了每页对 `credit_grant` 的 `max(redemption_period)` 子查询；是否已发由 `next_period_at` 决定，重复发放仍由 `issuePlanMonth` 的存在检查和 `credit_grant_redemption_key` 兜底。cron 的分页不再需要 id 游标：处理过的行 `next_period_at` 都会前移，下一页自然看不到。原来给 cron 用的 `redeem_redemption_plan_due_idx` 删除。
- **空档期的用量条**用该兑换 Plan 的快照额度（`redeem_redemption.credits`），不再用当前 Plan 售价。`RedeemedPlan` 增加可选的 `credits`，`redeemedPlansOf` 读出它。

迁移对已有的未结束兑换 Plan 回填 `next_period_at = plan_starts_at`；cron 第一次跑到时算出当前期，已发过的不会重发，然后正常前移。

验证：`npm run typecheck`；单元测试 `tests/unit/redeem.test.ts`（码格式与分布、规范化、批次参数、月份切分与月底、排队起点、Plan 状态）和原有 `tests/unit/billing.test.ts`；集成测试 `tests/integration/redeem.test.ts`（第 8 节 1–8）与全套 `./scripts/test-integration.sh`。浏览器验收需要用户登录一次后台。
