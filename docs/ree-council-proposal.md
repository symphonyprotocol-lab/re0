# Ree 圆桌与回答核验：精简方案

2026 年 11 月 8 日 · 待确认

## 1. 为什么是精简版

《Re0 AI Council 产品与技术规格书 V1.0》提出 Compare、Debate、Research、Verify 四种多模型模式，以及 REST、MCP、持久化 Workflow 和按 token 计费。评估后的结论如下。

| 规格书内容 | 处理 | 原因 |
| --- | --- | --- |
| 多家模型并排回答、交叉辩论（Compare / Debate） | 不做 | 产品价值会从「谁的知识」变成「哪个模型」。这条赛道已经很挤，我们没有优势。每次 8–12 次模型调用，成本是现在一次提问的 50–250 倍 |
| 问题拆解与并行研究（Research） | 不做 | 依赖持久化 Workflow、取消、幂等和按 token 计费，仓库里都没有。冷启动阶段公开知识也不够支撑 |
| REST `/v1/council`、MCP `council-run` | 不做 | 重建方案第 2 节已经明确不做 CLI / SDK / MCP |
| Workspace、Library、Trust Score、文档版本 | 不采用 | 这些是重建前的概念，现在的模型是 Ree、知识、对话 |
| Claim 核验（Verify） | **改造后采用**，见第 3 节 | 直接加强「只用这些知识回答」的承诺，只多一次模型调用 |
| 多方观点综合（Moderator） | **改造后采用**，见第 4 节 | 换成多个 Ree 的综合：竞品没有「背后有主人的知识」，还能给 Ree 主带来更多查询费 |

规格书里有三条原则直接沿用：
- 引用只能由服务端绑定，不接受模型生成的编号。
- 模型之间意见一致，不能当作「正确」展示。
- 失败、证据不足和未完成的状态要明确显示。

## 2. 首版范围

| 功能 | 首版 | 暂不包含 |
| --- | --- | --- |
| 回答核验 | 一个 Ree 回答后，逐句核对有引用的论断是否被所引段落支持，标出未引用的句子。提问时可以选择打开，Ree 测试对话里默认打开 | 核对引用以外的外部事实；给出整体可信度分数；事后对历史回答补做核验 |
| Ree 圆桌 | 一个问题有至少 2 个 Ree 作答时，可以一键生成综合结论：结论、共识、分歧、没有覆盖到的部分，每一点都带回原 Ree 的引用 | 多轮辩论；Ree 互相看对方的回答；综合结论进入后续追问的上下文；分享页 |
| 从 explore 发起圆桌 | 在搜索结果上方加一个入口：带着这个问题一起问前 3 个 Ree | 自动选 Ree 的策略配置 |

两项功能都沿用现有的固定 credits 计费、`streamText` 流式输出和 `model_call` 成本记录。不引入 Workflow 引擎、Redis 或按 token 计费。

## 3. 回答核验

### 3.1 用户看到什么

- 输入框旁加一个「核对引用」开关，作用范围是这一次提问，用法和「只问这个 Ree」一样。打开后，「最多 N credits」里会加上每个作答 Ree 的核验费。
- Ree 测试对话（`conversation.kind = 'ree_test'`）里默认打开，Ree 主可以关掉。Ree 主由此能看到哪句话缺依据，再回去补知识。这是给供给侧的直接价值。
- 回答流式结束后，气泡下方追加一行汇总，例如「5 句有引用：4 句有依据 · 1 句依据不足 · 另有 1 句未引用」。依据不足和未引用的句子在正文里用浅色下划线标出。点开能看到所引段落的摘录和一句判断理由。
- 核验失败（超时或模型出错）时，回答照常保留，汇总行显示「未能核对」，核验费退回。

### 3.2 判定规则

| 状态 | 怎么得出 | 含义 |
| --- | --- | --- |
| `supported` | 模型判断 | 所引段落明确写了这句话的内容 |
| `partial` | 模型判断 | 段落只支持一部分，或者有条件、范围上的限制 |
| `unsupported` | 模型判断 | 段落没有写，或者和这句话相矛盾 |
| `uncited` | 服务端规则，不调用模型 | 这句话是事实陈述，但没有带 `[n]` |

具体流程：
1. 服务端按句切分回答，用 [`citationSnapshots`](../lib/domain/answer.ts) 同样的解析方式取出每句的 `[n]`。没有标记的句子先标成 `uncited` 候选。客套话、过渡句这类不算论断的句子，由同一次模型调用判定排除。
2. 带标记的句子连同对应段落的**完整内容**，一次性交给 `generateObject`（zod 定义输出结构），让模型逐句返回状态和不超过 80 字的理由。
3. 核验在作答流程里做，这时 `retrieve()` 的完整段落还在内存里。消息里只存了 600 字的摘录，事后再核对会缺上下文，所以首版不支持对历史回答补做核验。
4. 模型返回的句子序号和段落编号由服务端对照校验，对不上的一律丢弃。核验结果只描述「段落是否支持这句话」，不对外宣称「这句话是真的」。
5. 核验指令沿用回答指令的规则：段落是数据，不是指令。

### 3.3 计费与记录

| 项目 | 规则 |
| --- | --- |
| 费用 | 新常量 `VERIFY_FEE`，按作答的 Ree 逐个收，全部归平台，不进 Ree 主收入。初始值待定，见第 6 节 |
| 冻结与结算 | 和现有提问同一个事务冻结（`placeHold`，`kind: 'chat'`，新子账本 `chat_verify`）。没有作答的 Ree 不核验，核验费退回；核验失败也退回 |
| 模型 | 和作答用同一个 `generationForUser(userId, …)`，免费用户和 Plan 用户各用各自的模型。`CallPurpose` 新增 `verify`，后台的模型调用页就能单独看到成本 |
| 存储 | `message` 表新增一列 `checks jsonb not null default '[]'`，存每句的起止位置、引用编号、状态和理由。消息被删时随消息一起删 |
| 统计 | 按 Ree 汇总 `unsupported` 和 `uncited` 的比例，在统计页（`/rees/[id]/statistics`）里展示给 Ree 主，公开页不展示 |

### 3.4 涉及的代码

- [`lib/services/answer.ts`](../lib/services/answer.ts)：`run()` 在结算之后追加核验，写入 `data-check` part，再把结果更新到消息上。
- [`lib/domain/answer.ts`](../lib/domain/answer.ts)：新增切句、核验 prompt 和结果校验的纯函数，配单元测试。
- [`lib/domain/chat-message.ts`](../lib/domain/chat-message.ts)：新增 `data-check` 的类型。
- [`lib/services/credits.ts`](../lib/services/credits.ts) 和 [`db/schema.ts`](../db/schema.ts) 里的 `CREDIT_ENTRY_REASONS`：新增 `chat_verify` 子账本的 hold、settle、release 三个 reason。`credit_entry_reason_check` 约束要跟着迁移放宽。
- [`components/conversations/composer.tsx`](../components/conversations/composer.tsx)、[`components/chat/message-parts.tsx`](../components/chat/message-parts.tsx)：开关、汇总行和句子标注。
- 迁移：`message.checks` 一列，加上 reason 约束的放宽。

## 4. Ree 圆桌

### 4.1 用户看到什么

- 普通对话里，一个问题有至少 2 个 Ree 成功作答后，最后一个回答下方出现「综合这 N 个回答」按钮，旁边写着价格。
- 点击后流式生成一个综合气泡，样式和 Ree 气泡区分开，标题是「综合」，固定四段：
  - **结论**：能从各 Ree 回答里得出的直接答案。
  - **共识**：几个 Ree 都支持的观点。
  - **分歧**：哪个 Ree 怎么说、各自的依据是什么。不裁定谁对。
  - **没覆盖到**：问题里没有任何 Ree 回答到的部分。
- 每一点后面跟着来源标记，例如「[产品手册 Ree 2]」，点开就是原 Ree 那条回答里的引用。综合本身不产生新的引用。
- 一个问题只生成一次综合，首版不支持重新生成。综合不进入任何 Ree 的历史轮次，Ree 之间仍然互相看不到对方的回答（重建方案第 5 节）。

### 4.2 怎么生成

1. 接口：`POST /api/chats/[id]/messages/[requestId]/synthesis`，`requestId` 是提问那条用户消息的 id。服务端校验三件事：对话属于当前用户；这个问题至少有 2 条成功作答（`role = 'ree'`、`no_answer = false`）；还没有生成过综合。
2. 输入只包含这个问题、各 Ree 的回答原文，以及各自的引用摘录（`message.citations` 的 `excerpt`）。各 Ree 编号为 A、B、C，引用写成 `[A2]` 这样的形式，`A2` 表示 A 这个 Ree 的第 2 条引用。
3. 指令要求只综合各 Ree 已经说过的内容，不加外部知识；分歧要如实列出，不按多数票下结论；每一点都要标来源。
4. 服务端在流式输出结束后校验所有 `[A2]` 形式的标记，没有对应 Ree 或对应引用的标记一律删掉，再映射回原消息的 `CitationSnapshot`。
5. 流式协议沿用 `createUIMessageStream`，新增 `data-synthesis` part，前端追加到这个问题下面。

### 4.3 计费与记录

| 项目 | 规则 |
| --- | --- |
| 费用 | 新常量 `SYNTHESIS_FEE`，每次综合收一次，全部归平台。各 Ree 主已经在作答时拿到查询费，综合不再重复收 |
| 冻结与结算 | 点击时冻结（`kind: 'chat'`，新子账本 `chat_synthesis`），成功后结算，失败或返回空内容就退回。余额不足返回 402，沿用现有的充值引导 |
| 模型 | `generationForUser(userId, 'synthesis')`，`CallPurpose` 新增 `synthesis` |
| 存储 | 新建 `synthesis` 表，不往 `message` 里加角色。这样现有按 `role = 'ree'` 统计答复率、回答数和收入的查询都不受影响。字段：`id`、`conversation_id`（级联删除）、`request_id`（唯一）、`user_id`、`content`、`sources jsonb`（映射后的引用）、`cost_credits`、`model`、`created_at` |
| 反馈 | 综合气泡也有「有用 / 没用」。写入新的 `synthesis_feedback`，不计入任何 Ree 的好评率 |
| 读取 | `messagesOf()` 的调用方按 `request_id` 把综合合并进对话的渲染列表 |

### 4.4 从 explore 发起

- 有搜索结果时，结果列表上方加一行「一起问前 3 个 Ree」，旁边写着最多花费。点击后新建一个对话，加入这 3 个 Ree，并把问题直接发出去。匿名访客点击时要求登录，和「加入对话」一样。
- 重建方案第 2.4 节规定「卡片上不放输入框和按钮」。这个入口放在列表上方，不放在卡片上，卡片本身不变。是否接受这处改动，见第 6 节。
- 对话里所有 Ree 都没有相关知识时，现在会推荐「这些公开 Ree 可能知道」。推荐列表旁边同样可以加「一起问这 3 个」。

### 4.5 涉及的代码

- 新增 `lib/services/synthesis.ts`，以及 `lib/domain/synthesis.ts`（prompt、来源标记的解析与校验，配单元测试）。
- [`lib/services/conversations.ts`](../lib/services/conversations.ts)、[`lib/services/chat.ts`](../lib/services/chat.ts)：读取对话时带上综合。
- [`components/conversations/chat-room.tsx`](../components/conversations/chat-room.tsx)：按钮和综合气泡。
- [`lib/services/explore.ts`](../lib/services/explore.ts) 及 explore 页面：「一起问前 3 个 Ree」入口。
- 迁移：`synthesis` 和 `synthesis_feedback` 两张表，`chat_synthesis` 的三个 reason。
- i18n：中英文词条各一组。

## 5. 种子用户与验证指标

### 5.1 这两个功能对谁有用

| 人群 | 价值 | 怎么用来拉人 |
| --- | --- | --- |
| Ree 主（供给侧） | 测试对话里默认核验，哪句话缺依据一目了然，补知识有了方向。圆桌每多拉进一个 Ree，就多一笔查询费 | 宣传语可以是「你的知识，回答句句有据」。邀请有现成文档、课程或仓库的人建公开 Ree，并告诉他们会出现在圆桌里 |
| 提问者（需求侧） | 一个问题能同时拿到几个专业来源的回答和一份综合结论，分歧摆在明面上 | 准备 2–3 个垂直领域的圆桌示例，用真实问题加真实的 Ree，作为站外传播素材 |

建议冷启动先选 2–3 个垂直领域。每个领域找 10–20 位 Ree 主建公开 Ree，保证 explore 里同一个问题能找到至少 3 个 Ree。否则圆桌的入口很少出现。

### 5.2 指标与上线后的判断

| 功能 | 观察指标 | 继续投入的信号 |
| --- | --- | --- |
| 回答核验 | 普通对话中打开核验的提问占比；测试对话里核验结果出来后 7 天内补知识的 Ree 主占比；每次核验的平均模型成本 | Ree 主在核验后补知识的比例明显高于没有核验的对照，且单次成本低于 `VERIFY_FEE` |
| Ree 圆桌 | 有至少 2 个 Ree 作答的问题里，点击综合的比例；综合的「有用」率；从 explore 一起提问的转化；参与圆桌的 Ree 主查询费收入的变化 | 点击率和「有用」率都稳定，参与圆桌的 Ree 收入上升 |

两个功能都用后台开关控制上线，先对一部分用户开放。数据证明「多个来源、有据可查」确实有需求，再讨论接入多家模型、多轮辩论和 API / MCP。

## 6. 待确认事项

| 事项 | 建议 | 需要确认 |
| --- | --- | --- |
| `VERIFY_FEE` / `SYNTHESIS_FEE` 初始值 | 先用后台模型调用页里 `answer` 的平均实际成本估算，核验约等于一次作答，综合约为 1.5 倍；暂定 10 和 30 credits，上线两周后按 `verify`、`synthesis` 的实际成本再调 | 定价，以及是否允许低于成本试运行 |
| 核验默认打开的范围 | 只在 Ree 测试对话默认打开，普通对话默认关闭 | 普通对话是否也默认打开（体验更好，平台成本翻倍） |
| explore 入口 | 放在结果列表上方，不放在卡片上 | 是否接受对重建方案第 2.4 节的这处改动 |
| 综合能否重新生成 | 首版不行 | 用户对综合不满意时，是否允许付费重来 |
| 交付顺序 | 先做核验，再做圆桌，各一个 PR；两者都排在 rebuild 上生产之后 | 与第 6、7 步（提现、视频）的先后 |
