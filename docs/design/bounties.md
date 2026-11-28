# 悬赏 Ree（bounty）：设计稿

- 状态：设计，未实现（2026-11-29）
- 上级文档：[agent-first.md](agent-first.md)。悬赏是建 Ree 的一种动力：用户可以在网站上手动建 Ree，也可以让 Claude、Codex 通过 MCP 建（总文档 §3、§4），建好后来悬赏里跑盲测。
- 界面设计稿：[agent-first-ui/re0-redesign.html](agent-first-ui/re0-redesign.html) 第 17 版的「悬赏」「管理后台 · 悬赏」两个 tab 和「我的 Ree」的「我的悬赏」（打开方式见 [README](agent-first-ui/README.md)）。设计稿和本文有几处不一致，列在 §12.1，等用户拍板；拍板之前两边都不改。
- 参考过的代码：`lib/services/earned.ts`、`payouts.ts`、`payout-minimum.ts`、`payout-funding.ts`、`task-rewards.ts`、`credits.ts`，`docs/design/earned-credits.md`，以及已搁置的比赛设计（`docs/design/competitions.md`，在 `d2663091` 上；实现由 #243 和迁移 0089、0090 撤下）。

> 用户原话：「系统管理员可以发布悬赏 Rees，比如可以发布悬赏某个具体学科或者知识的 Ree，比如古生物，历史等具体的任务，这个任务有具体的指向某个方面和某个知识点，然后设计 5-10 道盲测题目，用户根据悬赏的内容公告，自行创建相关内容的 Ree 后，到悬赏任务里面去跑盲测，如果盲测过关（打分制，需要每个题目都要答对），则发放给用户可以提现的积分作为奖励，盲测不过关则不发放奖励，盲测需要用户自行使用积分付费盲测，整理归纳并实现这个逻辑的相关文档文案以及原型设计」

## 0. 结论

管理员发布一个悬赏，公告写明要什么方面、哪些知识点的 Ree，并出 5–10 道**不公开**的盲测题。用户读公告，自己建一个 Ree（网站上手动建，或用 Claude / Codex 通过 MCP 建），然后报名，并用自己的 credits 付费跑盲测。盲测时，re0 让这个 Ree 只凭它自己的知识、带引用地回答每一道题，评分模型按参考答案和评分标准逐题打分，**每一题都通过才算过关**。

过关后先进入管理员审核。审核通过就发奖励：一笔 earned credits，走现有的账本，可以照现有规则提现（要过 KYC、达到提现最低额）。不过关不发奖励，盲测费不退。

奖励由平台出。发布悬赏时预留预算（奖励 × 名额），名额或预算用完就满额关闭。

和已搁置的比赛相比：比赛是任何用户都能办的公开赛，截止后一次性批量作答、排名、公布所有回答。悬赏只由管理员发布，是一张"达标就发钱"的任务单：每个用户随时来跑，题目和回答永远不公开，不排名，只有过关和不过关。比赛里能复用的是 Ree 作答流水线、知识冻结（`retrieve` 的 `asOf`）、评分提示词和防注入措施、cron 扫描模式和账本的 hold / settle（§9）。

估算约 12 人日（§10），§12 列出需要拍板的问题。

## 1. 角色和流程

### 1.1 管理员

1. 在管理后台 `/admin/bounties/new` 建草稿，填：
   - **学科**（例如古生物、历史）和**范围**：具体指向哪个方面，例如"中生代海生爬行类"；
   - **知识点**：3–10 条，写在公告里，例如"鱼龙、蛇颈龙、沧龙的分类和演化关系""主要化石产地"；
   - **公告**：中英文各一份，用 §7.1 的模板；
   - **盲测题**：5–10 道，每道有题干、参考答案、评分标准，可选 1–3 个改写（§3.4）；
   - **奖励**：每个过关者得多少 earned credits；
   - **名额**：最多几个人能拿到奖励，预算 = 奖励 × 名额；
   - **盲测费**：每跑一次收多少 credits；
   - **截止时间**；
   - **次数限制**：每个参赛 Ree 最多跑几次、每个用户在这个悬赏里一共最多跑几次、两次之间至少隔多久；
   - **领奖条件**：Ree 必须公开并发布，发奖后至少保持公开多少天（§4.4）。
2. **试跑**（可选，平台付费）：选一个现有的 Ree（例如官方 Ree）跑一次，看题目和评分标准是否合理。管理员能看到每一题的回答和评分，用来校准。
3. **发布**：检查预算（§5.3），把悬赏变成 `live`，公告出现在悬赏列表里。
4. **审核过关者**（§4.5）：看过关那次盲测的回答、引用和知识快照，批准或驳回。批准即发奖。
5. 处理申诉（§6.5），必要时暂停、延期或提前结束悬赏。

### 1.2 参赛用户

1. 在 `/bounties` 看到悬赏，打开公告：范围、知识点、奖励、剩余名额、截止时间、盲测费、规则。
2. 自己建一个 Ree：在网站上手动建（总文档 §3.1），或者让 Claude / Codex 读公告后通过 MCP 建（总文档 §4，`list_bounties` 能读到公告）。
3. **报名**：选一个自己的 Ree 参加这个悬赏。报名免费，只检查条件（§4.1）。
4. **跑盲测**：确认弹窗写明费用、剩余次数和"不过关不退费"，确认后扣费开始。几分钟后出结果：
   - 过关：显示"过关，等待审核"；
   - 不过关：显示总分和通过了几题，例如"72 分，通过 6 / 8 题"，**不显示是哪几题，也不显示题目**（暂定，§12 Q1）。
5. 不过关就补知识，等冷却时间过后再跑，直到次数用完。
6. 过关后等管理员审核；通过后收到奖励通知，earned credits 到账，可以照现有规则提现（§5.2）。

### 1.3 其他人

- 未登录访客能看悬赏列表和公告，不能报名。
- 悬赏结束后，公告页列出拿到奖励的 Ree（公开的 Ree 卡片，链到 Ree 页），但不公开题目、参考答案、任何一次盲测的回答和分数。

## 2. 名词

| 名词 | 含义 | 落地 |
| --- | --- | --- |
| 悬赏 bounty | 一个任务：范围、知识点、公告、题目、奖励、名额、费用、截止时间 | 表 `bounty` |
| 盲测题 question | 不公开的题目，带参考答案、评分标准和改写 | 表 `bounty_question` |
| 参赛 entry | 一个 Ree 参加一个悬赏 | 表 `bounty_entry`，`unique (bounty_id, ree_id)` |
| 盲测 run | 一次付费的盲测 | 表 `bounty_run` |
| 逐题结果 | 一次盲测里一道题的回答、引用和评分 | 表 `bounty_run_answer` |
| 知识快照 snapshot | 盲测开始那一刻 Ree 的知识和设定 | `bounty_run.snapshot`，作答时用 `retrieve(…, { asOf })` |
| 名额 slot | 能拿奖励的人数 | `bounty.max_winners`，已占用的记在 `bounty.slots_taken` |

## 3. 盲测

### 3.1 一次盲测怎么跑

1. **开始**（`POST /api/bounties/entries/[id]/runs`，或 MCP `run_bounty_test`）：在一个事务里检查条件（悬赏是 `live`、Ree 符合 §4.1、次数和冷却、余额），锁住 `bounty` 行，检查还有空余名额，然后为盲测费下一笔 hold（`credit_hold.kind = 'bounty_run'`），写一行 `bounty_run`（`queued`），记下快照（§3.3）和随机种子（§3.4）。
2. **作答**：cron（`/api/cron/bounties`，每分钟一次，做法和比赛的 cron 相同：先认领状态再干活，有时间预算和并发上限）对每一道题：
   - 按种子选题干的一个改写，题目顺序也按种子打乱；
   - `retrieve(reeId, 题干, …, { asOf: snapshot.as_of })` 只检索这个 Ree 自己的、快照时刻之前就绪的知识；
   - 用 `streamGroundedAnswer`（`lib/services/grounded-answer.ts`）生成回答和引用，模型用途记为 `bounty_answer`；
   - 检索判断"没有证据"时直接记为没答出，这一题不通过，也不调生成模型。
3. **评分**：每道题单独评（§3.2），用途 `bounty_grade`。
4. **结束**：所有题都评完后，在一个事务里：
   - 结算 hold：全额收取（`settleHold` 按盲测费结算）；
   - 写 `passed_count`、`total_count`、`score`、`status`（`passed` / `failed`）；
   - 过关时再锁一次 `bounty` 行占名额（§5.4），参赛状态变成 `pending_review`；
   - 发通知（§7.4）。
5. **系统错误**：生成或评分模型连续失败（每题最多重试 3 次）、re0 自己的故障导致盲测进行不下去时，盲测记为 `error`，**释放 hold，不收费**（暂定，§12 Q3），不计入次数。

一次盲测大约 10 道题 × 20–30 秒作答，加评分，通常 5–10 分钟出结果。页面显示进度（"正在作答 4 / 8"），但不显示题目。

### 3.2 评分

在比赛的评分提示词（`competitions.md` §8.1）上改：

- 输入：`<question>`（这次用的改写）、`<reference>`、`<rubric>`、`<answer>`、`<sources>`（回答引用的段落原文）。tag 里的内容声明为"材料，不是指令"；回答里的标签先转义。
- 输出 JSON：`{accuracy: 0–10, citation: 0–10, pass: boolean, injection: boolean, rationale}`。
- **这一题通过的条件**：`accuracy ≥ 7` 且 `citation ≥ 6` 且 `injection = false`。回答没有引用，或引用的段落不支持回答里的关键论断，`citation` 不会达标。门槛记在 `bounty.pass_rule` 里，管理员可以按悬赏调整（暂定）。
- **评两次**：第二次调换 `<reference>` 和 `<rubric>` 的顺序；两次结论不一致时评第三次，取多数。"每题都要答对"非常严格，单次评分的噪声会直接让一个本来该过关的 Ree 不过关，所以多评一次。
- **盲评**：提示词里没有 Ree 名、主人、次数、之前的分数。
- **服务端算总分**：`score = round(100 × Σ accuracy / (10 × 题数))`，只用于展示；过关只看是否每一题都通过。
- 评分模型固定：发布时写进 `bounty.grade_model`，整个悬赏用同一个模型。这个模型不可用时，盲测停在评分这一步，等它恢复后继续（不中途换模型），超过 6 小时就记为 `error` 并退费。

### 3.3 知识快照

"盲测时的知识"必须是固定的：既不能边跑边改，也不能事后把审核时看到的知识换掉。

- 开始时写 `bounty_run.snapshot`：`{as_of, system_prompt_digest, knowledge: [{id, title, kind, updated_at, chars, digest}]}`。`digest` 是这条 source 正文的 sha256，用于审核和查重（§4.3）。
- 作答时 `retrieve` 加 `asOf`：只用 `created_at <= as_of` 且 `updated_at <= as_of`、并且现在仍然 ready 的知识。比赛的实现里有过这个参数（`c8c51a6e` 随比赛一起删掉了），照它恢复。
- system prompt 在开始时复制进 `bounty_run.system_prompt`，作答时用它。
- 盲测进行中主人改了知识：改过的、新加的不参与这一次；删掉或暂停的也不参与（算主人自己的选择）。结果页提示"盲测期间你改了 n 条知识，它们没有参与这一次"。
- 审核看的是过关那一次的快照，并且核对这些 source 现在还在、内容没变（`digest` 一致）。不一致时提示管理员"过关之后知识被改过"。

### 3.4 题目不能泄露

题目是悬赏的全部价值，一旦泄露，任何人都能做一个只装着答案的 Ree。

**存储和读取**
- 题干、改写、参考答案、评分标准只存在 `bounty_question`。只有两处会读这些列：管理后台的悬赏编辑页（有审计，见下），和盲测 runner、评分的服务端调用。都走 `lib/services/bounties.ts` 里专门的 select；其他查询一律用不含这些列的投影，有单元测试断言公开接口、页面的 RSC payload、MCP 的返回里都不含题目。
- 管理员打开题目编辑页、查看某次盲测的逐题结果时，各写一条 `admin_audit`（`bounty.questions.view`、`bounty.run.view`）。

**不进 Ree 的可见历史**
- 盲测**不用**试问（`askReeTry`）或私密帖：那些会出现在 Ree 主人的试问列表里。回答只写进 `bounty_run_answer`。
- 盲测不计入 Ree 的回答数、统计、排名、角色门槛（`ree-counts`），也不进「我的帖子」、Ree 页的「回答」、feed、sitemap、搜索。
- 账本里盲测费的 `credit_entry.note` 只写"悬赏盲测 · <悬赏名>"，不写题目。

**不进日志**
- `model_call` 只记模型、token 数和成本，不存提示词和输出（已核对 `db/schema.ts`），不用改。
- 盲测 runner 和评分代码里，错误日志只记 run id、题目序号和错误码，不记题干、回答和模型返回的原文；有单元测试检查日志调用的参数。
- 模型请求走 AI Gateway；如果后台模型配置支持零数据保留，这两个用途优先用开了零数据保留的配置（暂定）。

**不回给参赛者**
- 结果只有总分和通过题数（是否显示逐题对错见 §12 Q1）。不显示回答、引用、评分理由。
- 申诉（§6.5）也不把回答或题目给参赛者，只告诉他结论。

**改写和打乱**
- 每道题可以有 1–3 个改写（意思相同、措辞不同），管理员在后台写，或者点"生成改写"让模型写好再由管理员改（用途 `bounty_variant`，平台付费）。
- 每次盲测按种子为每道题选一个改写，并打乱题目顺序。这样即使参赛者从 Ree 的检索行为里猜到题目的一部分措辞，下一次题面也可能不同；评分始终对照同一份参考答案。

### 3.5 为什么不显示逐题对错（暂定）

不过关时只显示"72 分，通过 6 / 8 题"。如果显示是哪几题没过，参赛者可以反复跑、对比，把没过的题定位到某个知识点，再针对性地补"答案"而不是补知识。不显示的代价是参赛者不知道该补哪里，只能按公告的知识点去补。

折中办法（备选）：因为每次题目顺序都被打乱，可以显示"第 1–8 题"各自的对错，但序号只对这一次有效，参赛者无法把序号和题目对上。它仍然会透露"有几题过了"之外的信息（例如总是同一类题没过）。见 §12 Q1。

## 4. 防作弊

### 4.1 能报名的 Ree

- 自己名下的 Ree，没有被下架，至少 1 条 ready 的知识；
- 一个 Ree 同时只能参加一个悬赏，拿过奖励的 Ree 不能再参加别的悬赏（暂定，§12 Q6）；
- 报名时可以是私有的，领奖前必须公开并发布（§4.4）；
- 管理员和官方账号的 Ree 不能报名。

### 4.2 一个人只能领一次

- 每个用户在一个悬赏里最多报名 `bounty.max_entries_per_user` 个 Ree（默认 1），最多拿 1 次奖励（部分唯一索引：`bounty_entry (bounty_id, user_id) where status in ('pending_review', 'awaiting_kyc', 'awarded')`）。
- 发奖前要求 KYC 已通过（推荐，§5.2、§12 Q4）。同一个 KYC 身份的多个账号在同一个悬赏里只能领一次：审核页按 KYC 记录列出同一个人的其他账号和它们在这个悬赏里的状态。

### 4.3 查重：复制的 Ree 不算

- 审核页对比过关快照里每条 source 的 `digest`：和这个悬赏里其他参赛 Ree 的快照、和全站其他用户的 Ree 的 source 有重合的，列出来。"同一份公开资料被两个人分别上传"是正常的；"两个账号的知识几乎完全一样"或"知识直接来自另一个参赛者"会被标红。
- 查重只给管理员看，不自动驳回。
- 用 `chunk` 级别的指纹（`passageDigest`）比整条 source 更准，但要扫的数据多，第一期先按 source 比（暂定）。
- **和参考答案的重合**（设计稿第 17 版）：一次没过关之后新加进来的来源，如果和某道题的参考答案高度重合（例如连续文字重合超过 50%），审核页给提醒，例如"第 1 次没过（6/8）后加了 3 个来源，其中 1 个和参考答案重合 64%"。这是"拿到题目的人往知识里塞答案"最直接的信号。只提醒，不自动驳回；只给管理员看，不告诉参赛者是哪道题。

### 4.4 Ree 必须是真的讲这个

过关只证明它答对了这几道题。悬赏要的是一个讲这个方面的、能公开使用的 Ree，所以：

- 领奖前 Ree 必须公开并发布，至少有介绍和 3 条示例问题（和总文档 §4.4 的静态检查一致），并在发奖后至少保持公开 `bounty.keep_public_days` 天（默认 90）。
- 管理员审核时看快照里的知识：数量、类型、总字数、来源。只装了几段"题目答案"的 Ree（知识很少、内容和公告的知识点对不上、像是一份答题卡）驳回。审核标准写在规则里（§7.2），参赛者事先知道。
- 发奖后提前转私有或删除：不追回奖励（追回要动账本，代价大），但这个账号以后不能再参加悬赏，并在后台标记（暂定，§12 Q7）。

### 4.5 管理员审核

过关后参赛状态是 `pending_review`，在后台 `/admin/bounties/[id]/review` 排队：

- 看：Ree 的基本信息和当前公开状态、过关那次的快照、逐题回答、引用和评分理由、查重结果、同一 KYC 身份的其他账号、这个用户在这个悬赏里的全部盲测记录（次数、分数变化）。
- **批准**：发奖（§5.2），参赛状态 `awarded`，通知用户，写 `admin_audit`（`bounty.award`）。
- **驳回**：必须写理由（会发给用户），释放名额，参赛状态 `rejected`。驳回后这个 Ree 不能再参加这个悬赏；用户可以申诉一次（§6.5）。
- **要求补充**：例如"Ree 还没公开"，参赛状态保持 `pending_review`，名额保留 14 天，到期没补齐就自动驳回。
- 审核时限：管理员 7 天内处理；超时在后台标红，不自动批准。

### 4.6 反复试探

- 次数限制：每个参赛 Ree 默认最多 5 次，每个用户在这个悬赏里一共最多 10 次，两次之间至少隔 6 小时（都由管理员按悬赏设置）。
- 盲测费本身就是试探的成本。
- 不显示逐题对错（§3.5）。
- 每次改写和顺序不同（§3.4）。

## 5. 钱

### 5.1 盲测费

- 管理员按悬赏设定，开始时冻结，结束时**全额收取，不过关也不退**。系统错误退费（暂定，§12 Q3）。
- 用 spendable credits 付（Plan、赠送、Pack），和问答一样；earned credits 不会被花掉（`earned-credits.md`）。是否允许用赠送和兑换码来的 credits 付，见 §12 Q5（推荐允许：奖励要过 KYC 和人工审核，免费额度洗不成现金）。
- 平台成本：每题一次作答（检索 + 一次生成，约等于一个基础费 20 credits 的成本）加 2–3 次评分调用。10 题一次约 250–350 credits 的模型成本。默认盲测费建议 500 credits，后台建悬赏时显示"每次盲测预计成本"，盲测费低于成本时提示。
- 账本：新 hold kind `bounty_run`，reason `bounty_run_hold` / `bounty_run_fee` / `bounty_run_release`，`ref_id` 为 run id。余额页显示成"悬赏盲测"。

### 5.2 奖励

- 审核批准时，在同一个事务里 `addGrant(tx, {userId, source: 'earned', amount: reward, reason: 'bounty_reward', refId: entryId, withdrawableAt: now})`，写 `bounty_entry.award_grant_id`。
- **立即可提现**（推荐，§12 Q8）：和邀请奖励一样，`withdrawableAt` 为发奖时刻。query fee 的 earned credits 要等 30 天（`EARNED_MATURITY_DAYS`），是为了等付钱那一方的退款和拒付；平台出的奖励没有这个风险，而且已经过了人工审核。备选是同样等 30 天。
- 之后完全走现有规则：
  - **提现**：要先完成 KYC 才能设置 PayPal（`setPaypalEmail` 的 `kyc_required`），达到提现最低额（`effectivePayoutMinimum`，默认 `PAYOUT_MIN_CREDITS` = 500,000，即 50 美元）才能申请，管理员审核后人工打款。奖励低于最低额时，结果页和通知写明"攒到 500,000 才能提现，或者在余额页换成 Pack credits"。
  - **换成 Pack credits**、**抵扣 Plan / Pack**：照 `earned-credits.md`。
- **发奖前要求 KYC 已通过**（推荐，§12 Q4）：没通过的，审核批准后参赛状态是 `awaiting_kyc`，名额保留 30 天；KYC 通过时自动发奖，到期没通过就释放名额。理由：奖励本身就是为了提现，§4.2 的"一人一次"只有靠 KYC 身份才查得住。
- **提现审核里能看出来源**：`payout-funding.ts` 现在把后台发的 earned credits 记为"无法追溯"。新增一类来源 `bounty`：earned grant 由 `bounty_reward` 条目记入，`ref_id` 指向参赛记录，审核页显示"来自悬赏「…」，于 … 由 … 批准"。

### 5.3 预算

平台不是一个有 credits 的账户，"预留"记在悬赏自己身上：

- `bounty.budget_credits = reward_credits × max_winners`，发布时写入；`bounty.awarded_credits` 记已发出的。
- 全站上限：后台设置 `bounty_settings.max_open_budget`（所有 `live`、`paused`、`full` 的悬赏的预算减去已发出的，之和不能超过它）。发布时在 `pg_advisory_xact_lock('bounty:budget')` 下检查。
- 后台财务页加一行"悬赏：已承诺 / 已发出"，承诺 = 未结束悬赏的剩余预算加上等待审核的名额。

### 5.4 名额和并发

几个用户同时过关时，不能多发：

- 开始盲测时：锁 `bounty` 行，`slots_taken < max_winners` 才允许开始。
- 盲测过关时：同一个事务里再锁 `bounty` 行：
  - `slots_taken < max_winners`：`slots_taken + 1`，参赛状态 `pending_review`；
  - 已满（期间别人先过关占了名额）：这次盲测记为 `passed_no_slot`，**退还盲测费**（暂定），通知"你过关了，但名额已经被先过关的人占满"，参赛状态保持 `entered`。如果之后有人被驳回、释放了名额，这个人**不会**自动补上（先到先得以占名额为准），但可以再跑一次。
- 名额被占满后悬赏变成 `full`，不能再开始新的盲测；有名额释放（驳回、KYC 超时）且没到截止时间时回到 `live`。
- 所有发奖都在 `bounty` 行锁下检查 `awarded_credits + reward <= budget_credits`，双重保险。

## 6. 状态和边界情况

### 6.1 悬赏 `bounty.status`

```
draft ──发布──▶ live ◀──恢复── paused
                 │  └──暂停──▶ paused
                 ├──名额占满──▶ full ──有名额释放且未截止──▶ live
                 └──截止 / 管理员提前结束──▶ ended
draft ──删除──▶（删除）     live / paused / full ──管理员取消──▶ cancelled
```

| 状态 | 能报名 | 能开始盲测 | 公开可见 |
| --- | --- | --- | --- |
| `draft` | 否 | 否（只有管理员试跑） | 否 |
| `live` | 是 | 是 | 是 |
| `paused` | 否 | 否；已经开始的跑完 | 是，标"暂停中" |
| `full` | 否 | 否；已经开始的跑完，过关的按 §5.4 | 是，标"名额已满" |
| `ended` | 否 | 否；截止前开始的跑完，仍可过关 | 是，列出获奖 Ree |
| `cancelled` | 否 | 否；进行中的盲测退费 | 是，标"已取消"，写明原因 |

- 截止时等待审核的照常审核、发奖。
- 取消时：进行中的盲测释放 hold；等待审核的由管理员逐个决定（推荐照常审核，已经过关的人不应吃亏），写在取消原因里。

### 6.2 参赛 `bounty_entry.status`

`entered` → `pending_review`（过关，占名额）→ `awarded` ｜ `awaiting_kyc` → `awarded` ｜ `rejected`；`entered` → `withdrawn`（用户撤回，没有进行中的盲测时）｜ `disqualified`（管理员取消资格，例如查重或 Ree 被下架）。

### 6.3 盲测 `bounty_run.status`

`queued` → `running` → `grading` → `passed` ｜ `passed_no_slot` ｜ `failed` ｜ `error`；`queued` 时 Ree 被删除或下架 → `cancelled`（退费）。

### 6.4 边界情况

| 情况 | 处理 |
| --- | --- |
| 有人报名后管理员要改悬赏 | 公告的文字（错别字、补充说明）可以改，保留修改记录，公告页显示"于 … 更新"。题目、参考答案、评分标准、改写：**有人跑过盲测之后不能改**，要改只能结束这个悬赏、另发一个。奖励只能加不能减；名额只能加，或减到不少于已占用的数；截止时间只能延后（有人报名后）；盲测费改动只对之后开始的盲测生效；次数限制只能放宽。每次改动写 `admin_audit` |
| 盲测进行中 Ree 被删除 | 后续作答拿不到 Ree，盲测记为 `failed`（`ree_gone`），不退费（主人自己删的）；参赛记录随 Ree 一起失效 |
| 盲测进行中 Ree 被管理员下架 | 记为 `error`，退费；参赛记录 `disqualified` |
| 盲测进行中改了知识或设定 | 不影响这一次（§3.3），结果页提示 |
| 余额不够 | 开始时冻结失败，提示差多少、去充值；不建盲测记录 |
| 过关后、审核前 Ree 被改 | 审核页提示"过关之后知识被改过"，管理员决定；通常要求用户恢复，或者驳回后让他重跑（不计次数，暂定） |
| 过关后、审核前 Ree 被删除 | 自动驳回，释放名额 |
| 同时过关、名额只剩一个 | §5.4 |
| 用户对结果有异议 | §6.5 |
| 评分模型长时间不可用 | §3.2：超过 6 小时记为 `error`，退费 |
| 账号被停用 | 进行中的盲测跑完；不发奖；等待审核的自动驳回 |

### 6.5 申诉

- 不过关（或被驳回）后 14 天内，用户可以对那一次申诉一次，写一段理由（≤ 1000 字）。每个用户在一个悬赏里最多申诉 3 次。
- 管理员在后台看那一次的逐题回答、引用和评分理由，可以：维持结果；或者改判某一题为通过（写理由）。改判后所有题都通过的，这一次变成过关，按 §5.4 占名额（名额已满就记为 `passed_no_slot` 并退费）。
- 告诉用户的只有结论和管理员写的说明，说明里不能包含题目和参考答案（后台提交前提醒）。
- 申诉不收费；改判过关的，这次的盲测费不退（照常收）。
- 表 `bounty_appeal`，每次决定写 `admin_audit`。

## 7. 文案（中英文）

### 7.1 公告模板

**中文**

```text
悬赏：{范围}的 Ree

我们在找一个讲「{学科} · {范围}」的 Ree。它应该能凭自己的知识、带出处地回答这方面的问题，尤其是这些知识点：
{知识点 1}
{知识点 2}
…

奖励：每个过关的 Ree 得 {奖励} credits（可提现），共 {名额} 个名额，先过关先得。
盲测：共 {题数} 道题，题目不公开。每跑一次 {盲测费} credits，每个 Ree 最多 {次数} 次，两次之间至少隔 {冷却}。每一题都答对才算过关。
截止：{截止时间}

怎么参加：
1. 建一个讲这个方面的 Ree：在 re0 上手动新建，或者用 Claude、Codex 通过 MCP 建。
2. 在这个页面报名，选你的 Ree。
3. 付费跑盲测，几分钟后出结果。
4. 过关后由我们审核，通过就发奖励。
```

**English**

```text
Bounty: a Ree on {scope}

We are looking for a Ree on "{subject} · {scope}". It should answer questions in this area from its own knowledge, citing its sources, especially on:
{knowledge point 1}
{knowledge point 2}
…

Reward: {reward} credits (withdrawable) for each Ree that passes, {slots} slots, first come first served.
Blind test: {count} questions, kept secret. Each run costs {fee} credits; up to {runs} runs per Ree, at least {cooldown} apart. A run passes only if every question is answered correctly.
Deadline: {deadline}

How to take part:
1. Build a Ree on this subject: by hand on re0, or with Claude or Codex through MCP.
2. Enter it on this page.
3. Pay for a blind run; the result is ready in a few minutes.
4. If it passes, we review it, and pay the reward once approved.
```

### 7.2 规则

**中文**

```text
规则
1. 盲测题目不公开，也不会在结果里出现。不过关时只告诉你总分和通过了几题。
2. 每一题都答对才算过关。Ree 只能凭它自己的知识回答，回答必须引用它的知识；没有引用、或者引用对不上的，那一题不算对。
3. 盲测用的是开始那一刻的知识。盲测进行中改动的知识不参与这一次。
4. 盲测费在开始时扣除，不过关不退。因为 re0 自己的故障没能跑完的，全额退回，也不计次数。
5. 过关后我们会人工审核：Ree 必须公开并发布、有介绍和示例问题，知识要真正覆盖公告里的范围，不能只是一份题目答案。我们会比对知识的重复情况，复制别人的 Ree、同一个人用多个账号参加的，不发奖励。
6. 每个人在一个悬赏里最多拿一次奖励。领奖前需要完成身份验证（KYC）。
7. 拿到奖励后，Ree 要至少保持公开 {天数} 天。
8. 对结果有异议，可以在 14 天内申诉一次。
9. 名额用完或到了截止时间，悬赏结束。截止前已经开始的盲测会跑完。
```

**English**

```text
Rules
1. The blind questions are secret and never appear in your results. A failed run tells you only its score and how many questions passed.
2. A run passes only if every question is answered correctly. Your Ree answers from its own knowledge and must cite it; an answer with no citation, or one its citations do not support, does not count.
3. A run uses your Ree's knowledge as it was when the run started. Knowledge you change during a run is not used for it.
4. The fee is charged when a run starts and is not refunded if the run fails. A run that re0 itself could not finish is refunded in full and does not count towards your runs.
5. A passing Ree is reviewed by us: it must be public and published, with an intro and sample questions, and its knowledge must really cover the subject announced, not just answers to questions. We compare knowledge across entries; copied Rees, or one person entering from several accounts, are not rewarded.
6. Each person can win a bounty once. Identity verification (KYC) is required before the reward is paid.
7. After winning, your Ree must stay public for at least {days} days.
8. If you disagree with a result, you can appeal it once within 14 days.
9. The bounty ends when its slots are filled or at the deadline. Runs started before the deadline still finish.
```

### 7.3 条款（加进现有服务条款的一节）

**中文**

```text
悬赏
re0 可以发布悬赏，为符合条件的 Ree 发放奖励。奖励以 earned credits 发放，提现适用本条款关于 earned credits、身份验证和提现最低额的规定。是否过关以 re0 的盲测结果和人工审核为准；re0 可以因为违反悬赏规则（包括复制他人内容、使用多个账号、提供不真实的身份信息）拒绝发放奖励，或者取消参加资格。盲测费是使用盲测服务的费用，不过关不退。re0 可以暂停、修改或取消悬赏；取消时尚未开始的盲测不收费，已经过关、正在审核的参加者照常审核。
```

**English**

```text
Bounties
re0 may publish bounties and reward Rees that meet their terms. Rewards are paid as earned credits; withdrawing them is subject to these Terms' provisions on earned credits, identity verification and the payout minimum. Whether a Ree passes is decided by re0's blind test and human review. re0 may withhold a reward, or disqualify an entry, for breaking a bounty's rules, including copying others' content, using several accounts or giving false identity information. The blind test fee pays for the test and is not refunded when a run fails. re0 may pause, change or cancel a bounty; on cancellation, runs not yet started are not charged, and entries that already passed and await review are reviewed as usual.
```

条款文本要请用户（或法律顾问）确认后再上线（§12 Q10）。

### 7.4 通知

| 通知（`NOTICE_KINDS`） | 中文 | English |
| --- | --- | --- |
| `bounty_run_passed` | 「{Ree}」通过了悬赏「{悬赏}」的盲测，我们会在 7 天内审核。 | "{Ree}" passed the blind test for "{bounty}". We will review it within 7 days. |
| `bounty_run_failed` | 「{Ree}」没有通过悬赏「{悬赏}」的盲测：{分数} 分，通过 {n} / {N} 题。还能再跑 {剩余} 次，{冷却结束时间} 之后可以再跑。 | "{Ree}" did not pass the blind test for "{bounty}": {score} points, {n} of {N} questions passed. You have {left} runs left; you can run again after {time}. |
| `bounty_run_no_slot` | 「{Ree}」过关了，但名额已经被先过关的人占满。这次盲测费已退回。 | "{Ree}" passed, but the slots were filled by earlier passes. The fee for this run has been refunded. |
| `bounty_run_error` | 盲测因为 re0 的故障没能跑完，{盲测费} credits 已退回，不计次数。 | The run could not finish because of a problem on re0. Your {fee} credits have been refunded and the run does not count. |
| `bounty_kyc_needed` | 「{Ree}」审核通过了。完成身份验证后就发放 {奖励} credits，名额为你保留到 {日期}。 | "{Ree}" was approved. Verify your identity to receive {reward} credits; your slot is held until {date}. |
| `bounty_awarded` | 悬赏「{悬赏}」的奖励 {奖励} credits 已到账，可以提现。累计达到 {最低额} 就能申请提现，也可以在余额页换成 Pack credits。 | The {reward} credits for "{bounty}" are in your balance and withdrawable. You can request a payout once you have {minimum}, or convert them to Pack credits on the balance page. |
| `bounty_rejected` | 「{Ree}」没有通过悬赏「{悬赏}」的审核：{理由}。你可以在 14 天内申诉一次。 | "{Ree}" was not approved for "{bounty}": {reason}. You can appeal once within 14 days. |
| `bounty_appeal_decided` | 你对「{悬赏}」的申诉已处理：{结论}。{说明} | Your appeal on "{bounty}" has been decided: {outcome}. {note} |

结果页（网站）和 MCP 返回用同一套文字。

## 8. 数据表、接口和页面（只是设计）

### 8.1 迁移

一个迁移 `bounties`，编号按合并顺序取下一个（目前 0103 已被总文档和子文档的迁移预定）。逐条自动提交，不写 `BEGIN`、`ON COMMIT DROP`。

**`bounty`**

| 列 | 说明 |
| --- | --- |
| `id` uuid pk、`slug` text unique | |
| `status` | `draft` `live` `paused` `full` `ended` `cancelled`，check 约束 |
| `subject`、`scope` | 学科、范围 |
| `knowledge_points` jsonb | `[{zh, en}]`，3–10 条 |
| `title` jsonb、`announcement` jsonb | `{zh, en}` |
| `lang` | 题目的语言 `zh` / `en` |
| `reward_credits`、`max_winners`、`budget_credits`、`awarded_credits`、`slots_taken` | §5 |
| `run_fee_credits` | 发布后改动只对之后的盲测生效 |
| `max_runs_per_entry`、`max_runs_per_user`、`run_cooldown_minutes`、`max_entries_per_user` | §4.6、§4.2 |
| `pass_rule` jsonb | `{accuracy: 7, citation: 6}` |
| `keep_public_days` | 默认 90 |
| `grade_model`、`answer_model` | 发布时写入 |
| `deadline_at`、`published_at`、`paused_at`、`ended_at`、`cancelled_at`、`cancel_reason` | |
| `created_by`、`published_by` | → `administrator.id` |
| `revision`、`created_at`、`updated_at` | 后台编辑用 revision 防并发覆盖，和 `earned_settings` 一样 |

**`bounty_question`**（不公开）：`id, bounty_id, ordinal (1–10), question (≤ 300), variants text[] (≤ 3), reference_answer (≤ 4000), rubric (≤ 2000), embedding jsonb, created_at, updated_at`；`unique (bounty_id, ordinal)`；发布时检查 5–10 题。

**`bounty_entry`**：`id, bounty_id, ree_id, user_id, status, runs_count, best_score, passing_run_id, reviewed_by, reviewed_at, review_note, awarded_at, award_grant_id, slot_held_until, created_at, withdrawn_at`；`unique (bounty_id, ree_id)`；§4.2 的部分唯一索引。

**`bounty_run`**：`id, bounty_id, entry_id, ree_id, user_id, status, fee_credits, hold_id, seed, snapshot jsonb, system_prompt, passed_count, total_count, score, via ('web' | 'mcp'), api_key_id, error_code, attempts, claimed_at, started_at, finished_at, created_at`；索引 `(status, claimed_at) where status in ('queued', 'running', 'grading')`、`(entry_id, created_at desc)`。

**`bounty_run_answer`**（不公开）：`run_id, question_id, position, variant, state (queued | answering | answered | no_answer | failed), text, citations jsonb, grades jsonb ([{accuracy, citation, pass, injection, rationale, model}]), passed, attempts`；主键 `(run_id, question_id)`。

**`bounty_appeal`**：`id, run_id, entry_id, user_id, note, status (open | upheld | overturned), decided_by, decision_note, created_at, decided_at`。

**`bounty_settings`**（一行）：`max_open_budget`、默认盲测费、默认次数限制、`revision`。

**现有表的改动**
- `credit_hold.kind` 加 `bounty_run`；`CREDIT_ENTRY_REASONS` 加 `bounty_run_hold`、`bounty_run_fee`、`bounty_run_release`、`bounty_reward`（改对应的 check 约束），`REASONS` 加 `bounty_run` 一项；
- `NOTICE_KINDS` 加 §7.4 的八种；
- `CALL_PURPOSES` 加 `bounty_answer`、`bounty_grade`、`bounty_variant`；
- `payout-funding` 的 `FundingSources` 加 `bounty`（§5.2）；
- `retrieve` 恢复 `asOf` 参数（§3.3）。

### 8.2 接口

| 方法 | 路径 | 谁 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/bounties?status=` | 所有人 | 列表（进行中 / 已结束） |
| GET | `/api/bounties/[slug]` | 所有人 | 公告、规则、奖励、剩余名额、截止时间；登录用户多看到自己的参赛和盲测记录 |
| POST | `/api/bounties/[slug]/entries` `{reeId}` | 登录用户 | 报名 |
| DELETE | `/api/bounties/entries/[id]` | 参赛者 | 撤回（没有进行中的盲测） |
| POST | `/api/bounties/entries/[id]/runs` `{fee}` | 参赛者 | 开始盲测；`fee` 是页面显示的费用，和当前不一致就拒绝（`fee_changed`），和 `rate_changed` 一个思路 |
| GET | `/api/bounties/runs/[id]` | 参赛者 | 进度和结果（不含题目、回答） |
| POST | `/api/bounties/runs/[id]/appeal` `{note}` | 参赛者 | 申诉 |
| GET | `/api/cron/bounties` | Cron | §3.1 |
| … | `/api/admin/bounties…` | 管理员 | 建、改、试跑、发布、暂停、结束、取消、审核、申诉、设置；全部写 `admin_audit` |

服务端代码：`lib/services/bounties.ts`（流程、读写，题目只在这里读）、`lib/services/bounty-runner.ts`（作答和评分）、`lib/domain/bounty.ts`（状态、规则、分数这些纯函数）。

### 8.3 MCP 工具

都进总文档的工具注册表（总文档 §5）：

| 工具 | effect | 说明 |
| --- | --- | --- |
| `list_bounties {status?, query?}` | read | 进行中的悬赏：范围、知识点、公告、奖励、剩余名额、盲测费、截止时间、次数限制。外部 agent 读它来决定建什么 Ree。返回的公告标为第三方数据（`DATA_NOTE`） |
| `enter_bounty {bounty, ree}` | write | 报名；返回参赛 id 和剩余次数 |
| `run_bounty_test {entry, max_cost}` | spend | 开始一次盲测；`max_cost` 低于盲测费就拒绝；返回 run id 和预计完成时间 |
| `get_bounty_run {run}` | read | 进度和结果：状态、总分、通过题数、剩余次数、下次可跑时间；不含题目和回答 |

外部 agent 可以"建 Ree → 跑盲测 → 补知识 → 再跑"，次数、冷却和费用对它一样适用。盲测费是花 credits 的操作，照常受 `max_cost` 约束，不需要主人另外确认（总文档 §4.5 只要求发布、公开、查询费、删除确认）。领奖前要求 Ree 公开并发布，这一步仍然要主人在网站上确认，所以 agent 不能替主人领奖。

### 8.4 页面

| 路由 | 内容 |
| --- | --- |
| `/bounties` | 悬赏列表：进行中 / 已结束，卡片上是学科、范围、奖励、剩余名额、截止时间 |
| `/bounties/[slug]` | 公告、知识点、规则、奖励和名额、盲测费；"报名"（选 Ree）；我的参赛和盲测记录（每次的时间、分数、通过题数、状态）、"跑盲测"、申诉；结束后列出获奖的 Ree |
| 「我的 Ree」的 Ree 卡片 | 参加了悬赏的标"悬赏中 · {悬赏}"，过关、等审核、已获奖分别标出 |
| `/admin/bounties` | 列表、预算、已承诺 / 已发出 |
| `/admin/bounties/new`、`/admin/bounties/[id]` | 编辑公告、知识点、题目（含改写和"生成改写"）、奖励、名额、费用、次数、截止；试跑；发布、暂停、结束、取消 |
| `/admin/bounties/[id]/review` | 审核队列（§4.5）、申诉 |

导航入口（设计稿第 17 版）：宽屏顶栏加「悬赏」；手机顶栏放不下，从 Explore 的第三个标签「悬赏」进；「我的悬赏」是「我的 Ree」的第三个标签，列出参加过的悬赏、每次盲测的时间、分数和通过题数，以及待审核和已到账的奖励。悬赏列表不吸顶；详情页右栏（奖励、费用、参加）在桌面上吸顶，手机上挪到正文后面，和 Ree 页的价格卡一样。

## 9. 和比赛（已搁置）的对比

| | 比赛（competitions.md） | 悬赏 |
| --- | --- | --- |
| 谁发起 | 任何满足条件的用户 | 只有管理员 |
| 目的 | 排名，看谁的 Ree 答得最好 | 达标就发奖励，用来补齐 re0 缺的知识领域 |
| 题目 | 开卷或闭卷，截止后公开；参考答案公布后可以公开 | **永远不公开**；每次换改写和顺序 |
| 作答 | 截止后一次性批量，每个 Ree 每题只答一次 | 用户随时付费跑，每次都是完整的一轮，有次数限制 |
| 结果 | 0–100 分排名，回答公开成 `post_answer` | 只有过关 / 不过关（加总分和通过题数），回答不公开 |
| 钱 | 参赛者或主办方付答题费，主办方付评审费；奖池放在二期 | 参赛者付盲测费给平台；平台出奖励，earned credits，可提现 |
| 人工 | 主办方改分 | 管理员审核过关者、处理申诉 |
| 复用 | — | 作答流水线（检索 + `streamGroundedAnswer`）、`asOf` 冻结知识、评分提示词和防注入、评两次取多数、cron 认领模式、hold / settle、审计 |

比赛里不再适用的部分：channel 绑定、题目 post、排行榜、主办方押金、回答审核后公开、人气榜。

## 10. 分期和工作量

**第一期（约 12 人日）**
- 迁移和表 1；
- `lib/domain/bounty.ts`（状态、规则、过关判断、名额）和单元测试 1；
- 盲测 runner：快照和 `asOf`、作答、评分（两次取多数）、cron、重试和退费 3；
- 账本：hold kind、reason、奖励 `addGrant`、`payout-funding` 的 `bounty` 来源 1；
- 公开页：列表、公告、报名、跑盲测、结果、申诉 1.5；
- 管理后台：编辑、题目和改写、试跑、发布 / 暂停 / 结束 / 取消、审核（含查重、KYC 身份）、申诉、预算 2.5；
- MCP 四个工具 0.5；
- 文案、通知、条款 0.5；
- 集成测试 1：名额并发（两个同时过关只占一个名额，另一个 `passed_no_slot` 并退费）；不过关不退费、系统错误退费；快照之后改知识不影响这一次；题目不出现在任何公开接口、页面和 MCP 返回里；一人一次；奖励可提现并出现在提现审核的来源里。

**之后看数据**
- chunk 级查重；
- 逐题对错的显示方式（§3.5）；
- 用户提议悬赏、或者由用户出资的悬赏（今天只做平台出资）；
- 获奖 Ree 在 Ree 页上的"悬赏获奖"标记。

## 11. 不做的事

- 不公开题目、参考答案、任何一次盲测的回答和评分理由，结束后也不公开。
- 不排名，不做排行榜。
- 不让普通用户发布悬赏，也不让用户出资（第一期）。
- 不自动发奖：每一笔奖励都要管理员批准。
- 发奖后不追回奖励（违规的处理见 §4.4）。
- 不让盲测结果影响 Ree 的回答数、统计和排名。
- 不复活比赛、channel 绑定、题目 post。

## 12. 需要拍板的问题

| # | 问题 | 推荐 | 备选 |
| --- | --- | --- | --- |
| Q1 | 不过关时显示到什么程度（**暂定**） | 只显示总分和通过题数 | 再显示逐题对错（序号每次打乱，对不上题目）；或者只显示过关 / 不过关 |
| Q2 | 每题通过的门槛 | `accuracy ≥ 7` 且 `citation ≥ 6`，评两次取多数，管理员可按悬赏调整 | 固定一个门槛；或只看 accuracy |
| Q3 | 系统错误时退不退盲测费（**暂定**） | 退，且不计次数 | 不退，只不计次数 |
| Q4 | 发奖前要不要求 KYC | 要求；没通过时名额保留 30 天 | 先发 earned credits，提现时再 KYC（同一个人多账号领奖要在提现审核时才查得出） |
| Q5 | 能不能用赠送和兑换码来的 credits 付盲测费 | 能（奖励要过 KYC 和人工审核） | 只能用付费的 Plan / Pack credits |
| Q6 | 一个 Ree 能不能拿多个悬赏 | 同时只能参加一个；拿过奖励的不能再参加别的 | 不限（不同悬赏的范围本来就不同） |
| Q7 | 领奖后提前转私有或删除 | 不追回，以后不能再参加悬赏 | 发奖时先冻结一部分，保持公开满期后再放 |
| Q8 | 奖励什么时候可以提现 | 发奖时就可以（和邀请奖励一样） | 等 30 天（和 query fee 一样） |
| Q9 | 名额满之后才过关的人 | 退还这次的盲测费，不自动补位 | 进候补队列，有人被驳回时按过关时间补位 |
| Q10 | 条款文本 | 由用户或法律顾问确认后上线 | — |
| Q11 | 默认数值 | 盲测费 500 credits、每个 Ree 5 次、每人 10 次、冷却 6 小时、保持公开 90 天、申诉 14 天内 1 次 | 由管理员每次自己填，不给默认值 |
| Q12 | 题目改写 | 每题 1–3 个，可以让模型生成再由管理员改 | 不做改写，只打乱顺序 |

### 12.1 和设计稿第 17 版的出入（等用户拍板）

设计稿第 17 版和本文在下面几处做法不同。拍板之前两边都不改；拍板后改输的那一边。

| # | 事项 | 本文 | 设计稿第 17 版 |
| --- | --- | --- | --- |
| Q13 | 什么时候拍知识快照 | 每次盲测开始时拍（§3.3），参赛者补了知识就直接再跑 | **参加时**拍；参加后 Ree 改了，开跑前提醒，二选一："更新快照再跑"或"用原来的快照跑"。是否允许更新快照、更新要不要占一次次数，设计稿也标了待定（原型里不另收费、不重置次数） |
| Q14 | 名额什么时候占 | 过关时占；名额满了才过关的记 `passed_no_slot` 并退费（§5.4） | **开始盲测时**先占一个名额，没过关再放回；名额都被占着就不能开始新的盲测 |
| Q15 | 限额方式 | 只有"每人奖励 × 名额"，预算由它算出 | 二选一：**按名额**或**按预算**；按预算时，剩下不够一份奖励就自动结束 |
| Q16 | 发奖前要不要 KYC（即 Q4） | 要求，没通过时名额保留 30 天（`awaiting_kyc`） | **不要求**：KYC 没完成也能批准，奖励先进可提现余额，提现时再验证 |
| Q17 | Ree 要不要公开（即 §4.4、Q7） | 领奖前必须公开并发布，之后至少保持 90 天 | 私有 Ree 也能参加；过关后要不要公开，设计稿标了待定 |
| Q18 | 悬赏页上列谁 | 结束后列出获奖的 Ree（公开的 Ree 卡片） | 详情页列"已经过关的人"（只列人，不列 Ree 名字）；要不要列 Ree，设计稿标了待定 |
| Q19 | 默认数值（即 Q11） | 盲测费 500 credits；每个 Ree 5 次、每人 10 次；两次之间隔 6 小时 | 示例里每次 200 credits，**每人最多 3 次**，没有冷却时间 |
| Q20 | 驳回之后 | 写理由；这个 Ree 不能再参加这个悬赏；可以申诉一次（§6.5） | 写理由，用户能看到，盲测费不退、次数照算；**没有申诉** |
| Q21 | 申诉 | 有，14 天内一次（§6.5） | 没有申诉的入口 |
| Q22 | 审核时限 | 7 天 | 一般 3 个工作日（设计稿注明要运营确认） |
| Q23 | 题目改写（即 Q12） | 每题 1–3 个改写，每次随机选一个、打乱顺序（§3.4） | 管理后台的出题卡里没有改写 |
| Q24 | 发布后能改什么 | 有人**跑过盲测**后锁定题目和评分标准；盲测费可以改（只对之后的盲测生效） | 有人**参加**后就锁定；奖励和每次费用都**不能改低**；截止只能延后；暂停后不能参加、不能开始新盲测，已参加的保留；结束前先确认，进行中的盲测会跑完 |

两边一致的：题目不公开；每题都带出处、全部通过才过关；没过关只给得分和通过题数，盲测中只显示"第 n / N 题"；盲测费开始时扣、没过关不退；系统出错退费、不算次数；一个人在一个悬赏里最多拿一次奖励，过关后不能再跑；奖励进可提现的 earned credits，走现有的提现和 KYC 流程；审核驳回要写理由。
