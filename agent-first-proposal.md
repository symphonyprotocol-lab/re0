# Agent 优先：数据资产 Agent、频道与 A2A

- 版本：0.10
- 更新日期：2026-10-29（0.10，按评审意见修订：最低价 $5 扩展到任一笔交易，年付同样适用；免费资产的匿名访问改由平台承担并走匿名限流，已认证调用一律计入调用方，频道所有者不再为访客付 Call；频道页分身需登录、计 1 Call；持有期按拒付窗口拉长到 120 天，补负余额处理；2.3 的改法改为完整引用并把记录商户转售写成合规级决定，Paddle 可售范围的确认要附依据；GitHub 资产的保留 owner 名单；A2A 确认门改用 `INPUT_REQUIRED`，待确认操作过期时任务转 `FAILED`；handle 挂在工作空间；`access` 随移出频道重置；页面路径改名从 P0 挪到 P1；热门排序匿名读者的去重；评论对创作者可见；现有锚点随数据重建作废；更正统计数字。0.9：平台管理费上调到 20%，创作者拿 80%；确认 re0 可以用自己的 Paddle 账户销售创作者内容。0.8：频道订阅走 re0 自己的 Paddle 账户，re0 按月结算、经 PayPal 付给创作者，结算与出账流程保留改记频道收入。0.7：频道订阅用 Paddle、平台承担手续费、月付最低 $5；API Key 统一 20 个；A2A `ask` 10 Calls 一答、每天 500 答；频道目录排序。0.6：GitHub 之外不再有文档仓库类型，删除 `llms.txt` 与 OpenAPI 来源；不做兼容；容量按工作空间分 500 MB 与 2 GB 两档；取消发布者分成，平台收取频道订阅 15% 管理费；只面向海外；音频不转写；去掉自检问题；不提供自定义域名；数据库表改名）
- 历史：0.5 出口收窄为频道、Agent Card 与 A2A，取消 Pro 与专家库；0.4 资产分类型、频道由多项资产组成、评论；0.3「数据资产」取代「知识库」；0.2 知识创作者频道与付费订阅；0.1 Agent 优先定位、工作台与确认门、A2A（均为 2026-10-29）
- 状态：实施中（P0、P1 完成；P2 完成于 2026-10-30，迁移 0063 待应用到 Neon dev 分支；P3a、P3b 完成于 2026-10-30，迁移 0064 待应用到 Neon dev 分支。P3a 在第 13.2 节四项业务前提齐备前先行实施：按 Paddle sandbox 开发，最低单笔价格、平台管理费、持有期与提现门槛做成控制台配置，四项仍待落实，落实前不在生产环境开放频道收款），已决定事项见第 13.3 节
- 依据：[requirement.md](./requirement.md) 第 2 节（产品定义）、第 2.3 节（MVP 不包含）、第 4 节（套餐、计量、分成）、第 5.1 节「在线试用」八条硬性规则、第 6 节（领域模型）、第 7 节（来源、认领）、第 9 节（查询接口）、第 10 节（访问规则）；[architecture.md](./architecture.md) 第 9.5、9.6 节、第 11 节、第 13 节
- 关联文档：[playground-agent-proposal.md](./playground-agent-proposal.md)；本提案取消 [publisher-revenue-share.md](./publisher-revenue-share.md) 的发布者分成与 [expert-library-prd.md](./expert-library-prd.md) 的专家库
- 外部规范：A2A Protocol v1.0（<https://a2a-protocol.org/latest/specification/>）；`@a2a-js/sdk` v1.x

> 术语说明：本文描述目标产品时一律用「数据资产」（简称「资产」）。引用现有代码、表名、接口时保留它们现在的名字（如 `library`、`libraryId`、`createWorkspaceLibrary`），改名在 P5 完成（第 3.5 节）。

## 1. 问题与做法

新 slogan 是 **Your data asset agent for life, work & business**。它和现在的产品定义主语不同：

- 现在（requirement.md 第 2 节）：re0 是**给别人的 Agent 用的知识层**。用户把资料变成知识库，Claude、Codex、Cursor 通过 MCP/REST 取上下文；知识库还能挂成网站插件和分享页。
- slogan 说的是：**re0 自己就是一个 Agent**，替用户收集、整理、使用、分发并变现数据资产。

做法：

- 把「知识库」打散成按来源分类型的**数据资产**；
- 用**频道**组织和公开资产，取代知识库的公开发布、网站插件和分享页；
- 对外只宣传三个出口：**频道**（给人看）、**Agent Card**（给 Agent 发现）、**A2A**（给 Agent 调用）。REST 接口保留，供网站内部与测试使用；
- 套餐只剩每月免费额度加人人可买的 Additional Calls；变现只有频道订阅，平台收取 20% 管理费；取消专家库与发布者分成。

网站还没有开始运营，**本提案不考虑兼容**：不保留旧路径、旧接口名、旧数据形态，也不设下线通知期。

不变的部分：不可变版本、逐句引用、链上存证、按 Call 计费。这些是 Agent 的**底座和差异点**。

## 2. 定位与文案

### 2.1 Slogan

| 语言 | 文案 |
| --- | --- |
| en | Your data asset agent for life, work & business |
| zh | 为生活、工作与生意打理数据资产的 Agent |

副标题承接「可信」：**Every answer cites its source. Every version is verifiable.** / 每句话都有出处，每个版本都能验证。

### 2.2 四个场景

| 场景 | 资产 | Agent 替用户做什么 | 用到的出口 |
| --- | --- | --- | --- |
| Life | 合同、保单、说明书、学习笔记（上传文件、Notion 文章） | 收进来，问答时逐句给出处 | 不放进频道，或放进私有频道；用户自己的 Agent Card |
| Work | 团队文档、代码仓库、内部手册（GitHub 库、Notion 文章、上传文件） | 保持最新，交给同事的 Agent 调用 | 私有或公开频道；A2A |
| Business | 官网、产品资料、帮助中心（网站、GitHub 库） | 一个公开频道作为产品资料的官方出处，客户和客户的 Agent 都能问 | 公开频道；频道 Agent Card |
| Creators | 文章、音频、问答，以及读者的评论 | 开一个频道，可以收费，用 AI 分身答读者的问题，订阅者的 Agent 也能接入 | 公开频道与订阅；频道 Agent Card |

slogan 不加第四个词，Creators 作为首页的第四个场景出现。Life 涉及更私密的数据，安全要求见第 10 节，晚于其他场景对外宣传。

## 3. 数据资产

### 3.1 定义

一项**数据资产**是从**一个来源**得到的一份数据，带不可变版本，内容可以逐句引用。

- 产品里只有资产这一个顶层概念，「知识库」「库」「Library」「资料集」都不再出现；
- **一项资产只对应一个来源**：一个网站、一个上传文件、一个 GitHub 库、一篇 Notion 文章、一篇文章、一期音频、一条问答；
- 资产可以**不属于任何频道**，或**属于且只属于一个频道**（第 6 节）。不属于频道的资产只有所有者能用；
- 资产内部的结构名称不变：来源、文档、版本、片段（Chunk）；
- **评论不是资产**，不进版本、不进检索，见第 6.8 节。

### 3.2 资产类型

| 类型 | 中文 | 来源 | `source_type` | 资产 ID |
| --- | --- | --- | --- | --- |
| `website` | 网站 | 抓取一个网站或其中一个路径 | `website` | `/websites/{slug}` |
| `upload` | 上传文件 | 一个上传的 PDF 或 Markdown 文件 | `pdf`、`markdown` | `/docs/{slug}` |
| `github` | GitHub 库 | 一个 GitHub 仓库，文档仓库也按 GitHub 库处理 | `github` | `/{owner}/{repo}` |
| `notion` | Notion 文章 | 一个 Notion 页面 | `notion` | `/notion/{slug}` |
| `post` | 文章 | 平台内编辑器撰写，或从网址、RSS 导入 | 新增 `editor` | `/posts/{handle}/{slug}` |
| `audio` | 音频 | 上传的音频文件，**不转写** | 新增 `audio` | `/audio/{handle}/{slug}` |
| `qa` | 问答 | 创作者回答读者的提问 | 新增 `editor` | `/qa/{handle}/{slug}` |

- `source_type` 中的 `llms_txt` 与 `openapi` **删除**，连同对应的抓取、解析与认领方式；GitHub 以外的 Git 仓库（GitLab、Gitee 等）不支持；
- 资产 ID 不随所属频道变化，资产移进、移出频道不会让引用和链上记录失效；
- `{handle}` 是工作空间的公开名（第 12 节 `workspace.handle`），第 4.3 节的用户主页与第 7 节的用户 Agent Card 也用它。MVP 只有个人工作空间，所以它看起来是「用户的名字」；将来有团队工作空间时，它仍然是工作空间的名字；
- **保留的 owner 名**：GitHub 资产的 `/{owner}/{repo}` 与其他命名空间共用根路径，所以 `websites`、`docs`、`notion`、`posts`、`audio`、`qa`、`channels`、`u`、`a2a`、`admin`、`dashboard`、`api`、`v1` 以及页面路由已占用的首段都是保留名；owner 与保留名同形的 GitHub 仓库拒绝创建，提示用户联系支持。requirement.md 6.1 原本只保留前三个，这里扩成一份显式名单，放在 `lib/domain` 里由资产 ID 解析与路由共用；
- 视频不支持。

### 3.3 现有数据

网站尚未运营，现有数据都是开发与测试数据，按新模型直接处理，不做兼容：

- 现有知识库按来源拆开：每个来源重建为一项资产，不保留原有的版本历史；这些版本已有的链上锚点随之作废，链上记录会指向不再存在的版本 ID，公开 Verifier 对它们返回「版本不存在」而不是「验证失败」；
- `llms_txt`、`openapi` 来源的知识库删除；
- Pro 订阅直接取消，不做补偿；专家标签、专家申请、自检问题，以及发布者分成产生的收益、结算单与出账记录清除（结算与出账的表结构保留，改记频道收入，第 6.9 节）；
- 迁移后所有资产都不属于任何频道。

### 3.4 术语对照

| 现在 | 中文 | English |
| --- | --- | --- |
| 知识库、库、Library、资料集 | 数据资产，行文中可简称「资产」；具体时按类型称呼（网站、GitHub 库……） | data asset, asset |
| Library ID | 资产 ID | Asset ID |
| 公开知识库 | 公开频道里的资产 | asset in a public channel |
| 私有知识库 | 不属于频道的资产，或私有频道里的资产 | unlisted asset, asset in a private channel |
| 知识库目录 | 频道目录 | channel directory |
| 专家库、自检问题、发布者分成 | 取消 | — |
| 平台自建库 | 平台资产，放在平台的公开频道里 | platform asset |

不变的词：来源、文档、版本、片段、Call、工作空间、频道。

### 3.5 改名

没有兼容负担，改名不设别名、不做重定向，但分两步做，先让用户看到的东西一致，再改内部：

| 层 | 现状（2026-10-29 统计） | 做法 | 阶段 |
| --- | --- | --- | --- |
| 界面文案 | `lib/i18n/messages/zh.ts` 476 处「知识库」，`en.ts` 713 处 librar-（含 library 与 libraries）；营销页、邮件、法律页、OG 图 | 全部替换 | P0 |
| 产品文档 | requirement.md、architecture.md 及各提案 | 正文改为资产与频道；已取消的提案标为废止 | P0 |
| 页面路径 | `/libraries/*`、`/dashboard/libraries/*` | 直接改为 `/assets/*`、`/dashboard/assets/*`、`/channels/*`，旧路径删除。随频道一起落地，P0 不做（P0 的 `/channels/*` 会是空路由） | P1 |
| REST | `/v1/libraries`、`/v1/libraries/search`，字段 `libraryId`，错误码 `library_*` | 直接改为 `/v1/assets`、`assetId`、`asset_*`，测试同步修改 | P5 |
| 代码标识符 | 321 个文件提到 library（`lib`、`app`、`packages`、`tests`、`scripts` 下的 `.ts`/`.tsx`，不区分大小写）；`lib/application/libraries` 等模块 | 机械重命名；**新代码从现在起一律用 asset** | P5 |
| 数据库 | 13 张表名含 library（`library`、`library_version`、`library_profile` 等）、22 个 `library_id` 列（按 `db/schema.ts` 中的列定义计，不含索引） | **改名**：一次迁移完成 `ALTER TABLE … RENAME` 与列改名，Drizzle schema 同步改名 | P5 |
| 资产 ID 的值 | requirement.md 6.1 的各种形式 | 形式不变。链上锚点的叶子哈希的是 ID 的值，不是字段名（`lib/domain/anchor-leaf.ts`） | — |

### 3.6 下线与删除

| 对象 | 处理 |
| --- | --- |
| 网站插件（`/widget.js`、`app/embed`、`app/api/embed`、`lib/application/embed`、站点密钥） | **暂时下线**：入口与路由撤掉，代码保留在开关之后 |
| 分享页（`app/s`、`lib/application/showcase`、自定义域名、线索收集） | **暂时下线**：同上；已收集的线索删除；自定义域名不再提供 |
| MCP（`/mcp`、`/mcp/oauth`、`lib/webmcp`、`packages/mcp`、`packages/tools-ai-sdk`） | **暂时下线**：同上 |
| Pro 套餐 | 删除 |
| 专家库：标签、申请、管理员审批、门槛配置（`/admin/expert-libraries/thresholds`） | 删除；[expert-library-prd.md](./expert-library-prd.md) 标为废止 |
| 自检问题（`library_eval_question`） | 删除；Benchmark 只剩结构分（文档数、Chunk 数、引用完整性、重复率，requirement.md 6.3） |
| 发布者分成：按检索次数计算收益的部分（可计分成 Call、分成池、`share_rate`、专家与订阅资格判断） | 删除；[publisher-revenue-share.md](./publisher-revenue-share.md) 标为废止。账期结算、持有期、抵扣为 Calls、PayPal 人工出账、结算单上链（`lib/application/revenue`、`/v1/revenue*`、锚点类型 `earning_statement`）**保留**，改为结算创作者的频道订阅收入（第 6.9 节） |
| `llms_txt`、`openapi` 来源 | 删除 |

REST 接口 `/v1/*` 不下线（第 13.3 节），只随所属功能删除对应的端点（如 `/v1/revenue*`）。SDK 与 CLI 封装的是 REST，保留，随 P5 的接口改名发新版本。

### 3.7 存储与检索

- **每项资产都有自己的版本线**，沿用现有的 `library` / `library_version` 机制，用新增的 `kind` 字段区分类型。改一篇文章只产生这篇文章的新版本，版本照常上链；
- **频道是一个检索范围**。问频道时，检索在一次查询里覆盖频道内调用者有权看到的全部资产，而不是对每项资产分别查询再合并：architecture.md 9.1 的库内精确扫描本来就按资产过滤，过滤条件从「一项」放宽为「一组」即可；
- **跨频道发现在频道层做**。architecture.md 9.6 的画像现在按知识库生成；资产打散后单项资产太小，画像上移到频道：用频道内公开资产的标题、实体与质心生成频道画像，平台级提问先路由到频道，再在频道内检索；
- 资产的 Trust 与 Benchmark（结构分）继续计算，用作安全信号与频道排序的输入，不再单独展示。

### 3.8 资产的生命周期

| 阶段 | 用户对 Agent 说 | 落到的应用层函数 |
| --- | --- | --- |
| 收集 | 「把 example.com、这个 GitHub 库和这几份 PDF 交给你」 | `createWorkspaceLibrary`、`confirmUploads`（`lib/application/libraries/create.ts`），改为每个来源各建一项资产 |
| 整理 | 「这项资产过期了吗？刷新一下」 | `requestLibraryRebuild`（`rebuild.ts`）、构建计量（requirement.md 4.2.1） |
| 使用 | 「我的保单里，住院怎么报销？」 | 在线试用的 Agent 循环（architecture.md 9.5） |
| 公开 | 「把这几项资产放进我的产品频道」 | 新增，第 6 节 |
| 变现 | 「这个频道开个月付订阅」「这个月订阅收入多少」 | 第 6.9 节 |

## 4. 入口与信息架构

### 4.1 入口一览

| 入口 | 给谁 | 职责 |
| --- | --- | --- |
| Web：Agent 工作台 | 资产的所有者 | 对话式地收集、整理、使用资产，管理频道 |
| Web：频道与用户主页 | 读者、订阅者 | 浏览、阅读、收听、提问、评论、订阅 |
| A2A + Agent Card | 其他 Agent | 发现（Agent Card）并调用（A2A）平台、用户、频道三个层级的 Agent，见第 7 节 |
| REST `/v1` | 网站内部、测试、需要脚本化管理的用户 | 现有的检索与管理接口，不对外宣传 |

### 4.2 首页

- **Hero**：slogan + 副标题 + 一个对话输入框。占位文字：「粘贴网址、上传文件，或直接提问」。发送沿用在线试用的登录门槛（requirement.md 5.1），登录后进入 Agent 工作台并带上这句话。
- **四个场景区块**：Life / Work / Business / Creators，各配一段实际对话的静态演示，不调用模型。Creators 区块的按钮是「开通频道」。
- **频道目录**：热门与最近更新的公开频道，取代现在的知识库目录区块。
- **「给 Agent 开发者」区块**：平台 Agent Card 地址与 A2A 接入说明，取代现在的 MCP 连接卡。
- 删除网站插件、分享页与发布者分成区块；`/publishers` 页面删除。

### 4.3 用户主页

`/u/{handle}`：用户的公开名、简介、他的公开频道列表，以及用户 Agent Card 的地址。没有公开频道的用户没有公开主页。

### 4.4 Dashboard 改为 Agent 工作台

- `/dashboard` 首页：左侧对话，右侧资产与频道卡片，卡片上的状态和对话里的操作双向同步。
- 侧栏分组：

```text
Agent        对话、待确认的操作、A2A 任务
资产          全部资产（按类型筛选）、未归入频道的资产
频道          我的频道、待答列表、评论管理、订阅收入与出账
Agent Card   我的用户卡与频道卡、API Key
订阅          我订阅的频道（订阅者视角）
设置          访问规则、调用记录、导出、容量与购买、设置
```

- 网站插件、分享页的 Dashboard 页面删除；现有的收益与出账页面改为展示频道订阅收入（第 6.9 节）。

### 4.5 在线试用并入工作台

`/playground` 保留为公开演示（只读、只查公开频道里的免费资产），登录用户的提问进入工作台对话。两边共用同一个 Agent 循环和生成链路（architecture.md 9.5），区别只在工具集合。

## 5. re0 Agent

### 5.1 工具

在 [playground-agent-proposal.md](./playground-agent-proposal.md) 的检索工具与 `answer` 之上，增加资产与频道的操作工具。每个工具只是应用层函数的薄包装，鉴权、Policy、计量都在应用层完成，工具层不重写业务规则。

| 工具 | 副作用 | 确认 |
| --- | --- | --- |
| `list_assets` | 无 | 不需要 |
| `create_asset` | 按来源类型创建一项资产并开始构建，消耗构建 Call 与容量 | **需要** |
| `refresh_asset` | 重建，可能消耗构建 Call | **需要** |
| `create_channel` | 创建频道，默认公开 | **需要** |
| `move_asset` | 把资产放进某个频道、移到另一个频道或移出频道；放进公开频道即公开；移出频道时 `access` 重置为 `free` | **需要** |
| `subscription_summary` | 无 | 不需要 |

不进入工具集合的操作：删除资产或频道、撤销或轮换 API Key、改访问规则、购买额度、设置频道价格、发布文章与音频、处理评论。这些仍然只能在 Dashboard 里由人点击完成。

### 5.2 确认门

「需要确认」的工具调用不直接执行，而是生成一条**待确认操作**：写明要做什么、作用于哪项资产或哪个频道、预计消耗多少 Call 与容量、是否会让内容公开。用户在对话里的确认卡片上点击后，服务端才以用户身份执行一次，并写审计日志。

- 确认是一次性的，绑定到具体参数；参数变了要重新确认；
- 模型不能代用户确认，资产内容里的任何文字也不能（requirement.md 5.1 第 3 条：Chunk 是不可信数据）；
- 待确认操作 24 小时未处理即作废。

A2A 调用方触发的同类操作走同一个确认门，见第 7.6 节。

### 5.3 证据规则一条不放松

Agent 写给用户的事实性内容，仍然受 requirement.md 5.1 八条规则约束：零结果不调模型、只用本轮证据、逐句绑定 Chunk、未绑定不得作为事实展示、模型失败降级为 Chunk 列表。资产与频道操作的结果由服务端模板生成，不经过模型。

## 6. 频道

### 6.1 频道是什么

频道取代了知识库的公开发布、网站插件和分享页，是资产对外的唯一组织方式。

- 一个频道包含多项资产，类型不限：网站、GitHub 库、上传文件、文章、音频、问答……都可以放进同一个频道；
- **一项资产不属于任何频道，或只属于一个频道**；移出频道后回到只有所有者可用，`access` 同时重置为 `free`（它只在频道内有意义，不带到下一个频道）；
- 频道**默认公开**，也可以设为私有；
- 一个工作空间可以有多个频道；频道 ID 为 `/channels/{slug}`。访问规则（requirement.md 第 10 节）的名单可以直接写频道 ID，覆盖频道里的全部资产；
- 频道不支持自定义域名。

### 6.2 谁能看到什么

| 资产在哪里 | `access` | 所有者 | 订阅者 | 其他人与其他 Agent |
| --- | --- | --- | --- | --- |
| 不属于任何频道 | — | 可见 | 不可见 | 不可见 |
| 私有频道 | — | 可见 | 不可见 | 不可见 |
| 公开频道 | `free` | 可见 | 可见 | 可见 |
| 公开频道 | `paid` | 可见 | 可见 | 只见标题、摘要和发布时间 |

- `access` 默认 `free`。频道开通订阅（第 6.9 节）后，创作者逐项把资产设为 `paid`；
- 可见性由 Policy Engine 在固定可访问资产与版本时判断，先于召回（同 architecture.md 9.6「Policy 与可见性先于路由」）。不可见与不存在对外同 404 外观。

### 6.3 频道主页

`/channels/{slug}`：

- 频道介绍、资产流（按发布时间倒序，可置顶）、订阅方案与订阅按钮；
- 文章、音频、问答有各自的阅读与收听页；网站、GitHub 库等来源型资产显示来源地址、最近更新时间与版本，正文以引用片段的形式出现在回答里，不整篇转载；
- **AI 分身**：在频道主页上提问，分身在调用者有权看到的频道资产里作答（第 3.7 节），逐句带出处；走第 7.7 节那条共用的生成链路，requirement.md 5.1 的硬性规则全部适用。界面始终标明「AI 分身，依据频道内容作答」，不冒充创作者本人发言。**提问需要登录**（与在线试用的登录门槛一致，requirement.md 3.1），每问计提问者工作空间 1 Call，生成成本由平台承担（第 8.2 节）；未登录的访客只能阅读、收听和看到输入框上的登录提示；
- 主页上给出频道 Agent Card 的地址，供读者把频道接进自己的 Agent。

### 6.4 频道目录

`/channels`：列出公开频道，取代现在的知识库目录。

- 频道里的单项资产不单独列在目录里；免费的文章与音频有自己的公开页面，可以被搜索引擎收录；
- **不进目录**：被安全暂停或下架的频道，私有频道，以及还没有任何资产的频道；
- **「热门」排序**（默认）：`得分 = 0.5 × 活跃度 + 0.25 × 新鲜度 + 0.25 × 质量`，三项都先归一化到 0–1：
  - 活跃度：近 30 天（沿用 `POPULARITY_WINDOW_DAYS`）阅读、收听、提问或经 A2A 检索这个频道的**不同访问者数**，登录用户按用户、A2A 调用按工作空间、匿名访客按 architecture.md 11.2 匿名限流用的那把哈希后的 IP 与设备信号键去重，所有者本人不计；三类访问者各自 `log(1 + n)` 后相加，再在全部频道内归一化。按人数而不是调用次数计，一个调用方刷再多次也只算一个；免费文章会被搜索引擎收录，匿名读者是主要流量，不计匿名就等于只按登录与 A2A 排序；
  - 新鲜度：最近一次发布或刷新距今的天数，按 14 天半衰期衰减，让新频道和持续更新的频道有曝光；
  - 质量：频道内资产 Trust 与 Benchmark（结构分）的平均值；
- **「最近更新」排序**：按最近一次发布或刷新时间倒序；
- 订阅数、订阅收入、是否收费都**不进入排序**，免费频道与付费频道同等竞争；
- 三个权重与半衰期放进控制台配置，上线后可调。

### 6.5 文章

- **撰写**：平台内 Markdown 编辑器，支持图片；草稿、定时发布、立即发布；
- **导入**：从网址或 RSS 导入，每篇原文生成一篇文章，沿用现有抓取与 SSRF 防护；
- **版本**：每次发布或修改发布后的内容，都是这篇文章的一个新版本；
- **图片**：存入私有 Bucket，付费文章的图片和正文一样只对订阅者签发访问地址；图片本身不进检索，图片说明文字进；
- **通知**：新文章发布时通知订阅者（站内通知，邮件可选）。

### 6.6 音频

- **上传**：MP3、M4A、WAV；文件大小计入工作空间容量（第 8.1 节）；
- **不转写**：音频内容不做语音识别。进入检索的只有创作者为这期音频写的**标题与节目说明**；分身只能依据节目说明回答，引用指向这期音频本身，不指向时间点；
- **播放**：音频文件存私有 Bucket，按次签发短时效地址，只发给有权收听的人；不提供下载；
- **版本**：替换音频文件或修改节目说明都产生新版本；版本摘要覆盖音频文件的哈希，照常上链。

### 6.7 问答

- 读者的提问先由分身回答；
- 检索零结果、分身不作答的问题（requirement.md 5.1 第 2 条）自动进入创作者的**待答列表**；读者也可以直接「向作者提问」；
- 创作者用文字回答，可以附一段音频；进入检索的是问题与文字回答，附带的音频与第 6.6 节一样不转写。回答发布后生成一项**问答资产**，放进该频道，由创作者选择免费或付费；提问者默认匿名，本人同意后才显示昵称；
- 之后同类问题分身也能答，并引用这条问答；
- 创作者可以给分身的某条回答打上「作者确认」标记。标记绑定到该回答所依据的版本，资产更新后旧标记仍显示，但注明对应的版本。

### 6.8 评论

评论是读者对频道里某项资产的互动，**不是资产**：

- **谁能评论**：公开频道里的资产可以评论；`paid` 资产只有订阅者能评论，评论也只有订阅者和创作者看得到；`free` 资产任何登录用户都能评论，人人可见；不属于频道或在私有频道里的资产不开评论；
- **结构**：一层回复；创作者可以置顶、隐藏、删除评论，也可以对单项资产关闭评论；读者可以举报，平台可以下架；
- **不进检索**：评论是读者写的，不是创作者的内容，也可能包含读者的个人信息，所以**不进入检索、不作为分身的证据、不上链**。创作者可以把评论里的好问题转进待答列表，回答后成为问答资产，问答资产只引用创作者自己的回答；
- **安全**：评论正文按不可信内容渲染，链接加 `nofollow` 与外链提示；发评论有频率限制；评论正文经过与上传内容相同的 PII 与恶意内容检查（requirement.md 第 12 节第 3 条），命中时先隐藏待创作者处理；
- **通知**：新评论通知创作者，回复通知被回复的人；
- **删除**：评论者可以删除自己的评论；用户注销时其评论正文删除，只留「该评论已删除」占位。

### 6.9 订阅与收款

订阅是频道的可选功能，频道默认免费。只面向海外用户与创作者，不考虑中国大陆。

- **价格**：创作者为频道设月付、年付方案，价格写进不可变的频道方案版本，改价只影响新订阅；
- **订阅身份**：订阅绑定到用户，该用户的个人工作空间获得频道 `paid` 资产的读权限；
- **退订与退款**：退订后可以用到当期结束；退款立即收回访问权；
- **平台管理费**：平台收取订阅金额的 **20%** 作为管理费，费率写进频道方案版本，以后调整只影响新订阅；
- **收款方式：re0 用现有的 Paddle 账户直接售卖频道订阅**（已决定）。Paddle 作为记录商户向订阅者收款并处理销售税，把收入结给 re0；re0 按月把创作者的份额付给创作者。沿用现有的 Paddle 接入（`lib/infrastructure/payment/paddle.ts`、Paddle Webhook），频道订阅作为一个新的 Paddle 商品，价格取自频道方案版本，与现有的非目录价格做法一致（architecture.md 11.3）；
- **分配**：创作者拿订阅金额（不含税，即 Paddle 交易的小计）的 **80%**。**Paddle 手续费（含拒付费）由平台承担**，从平台的 20% 里出；
- **最低价格**：**任何一笔交易不低于 $5**，月付与年付都适用。按 Paddle 标准费率 5% + $0.50 每笔计算，$5 一笔的手续费是 $0.75，平台 20% 管理费是 $1.00，净得 $0.25；保本点约为 $3.34，低于它平台每笔都亏。保本点是按单笔交易算的，与计费周期无关：一笔 $2 的年付和一笔 $2 的月付亏得一样多，所以年付不能豁免。Paddle 官网没有写清手续费是按含税总额还是按小计计算；若按含税总额，20% VAT 下 $5 一笔的手续费是 $0.80，净得 $0.20，仍不亏，但更薄。P3a 开工前按含税口径向 Paddle 核实一次（第 13.2 节），若手续费确实按含税总额计，最低价相应上调；
- **记账**：每笔订阅收款完成（Paddle `transaction.completed`）时，为频道所有者记一条收入，金额为小计的 80%；退款与拒付冲回对应收入。已经付出的部分从之后的收入里扣回，扣回期间创作者的可提现余额为负；
- **负余额**：创作者停更、注销或长期没有新收入时，负余额扣不回来。处理规则：负余额由平台承担，不向创作者追讨，但该创作者在负余额清零前不能开新的付费方案，也不能提现；注销账户时负余额直接核销并记入平台成本。这是平台承担拒付费的一部分，预算时按订阅收入的 1% 预提；
- **结算与出账**：复用现有的分成结算流程，只换收入来源——按月关账生成结算单、**120 天持有期**（`PAYOUT_HOLD_DAYS` 从 45 天改为 120 天：卡组织的拒付期通常到交易后 120 天，45 天只盖得住退款窗口；没有出账过的收入遇到拒付直接冲回，不会产生负余额）、满 $20 可申请 PayPal 提现（`PAYOUT_THRESHOLD_MINOR`，由运营人工打款并登记交易号），也可以不设门槛转为本工作空间的 Additional Calls（转为 Calls 同样要过持有期，否则拒付后 Calls 已经花掉）；结算单照常上链（锚点类型 `earning_statement`）；
- **创作者收款资料**：PayPal 收款邮箱，以及 re0 主体所在地要求的税务信息（例如美国的 W-9 / W-8BEN）；资料齐全前收入照常累积，但不能提现；
- **资金与合规**：re0 在持有期与出账前替创作者保管这部分收入，并自己维护分账账本。这触及 requirement.md 2.3 排除的「平台自行持有或冻结用户资金、双重记账与自建清结算」，不是改一句话就能过去的事：re0 从「卖自己的套餐」变成「作为记录商户转售创作者的内容并向创作者付款」，涉及税务申报（例如美国对非雇员付款的 1099 申报）、各地区对代收代付的监管要求，以及 Paddle 对平台型商户的可售范围。2.3 改为：「除待结算给创作者的频道收入外，平台不持有用户资金；频道收入的分账账本只记录应付与已付，不做双重记账与清结算」。这是合规级别的决定，P3a 开工前要有法务或会计意见（第 13.2 节）；
- **Paddle 可售范围**：re0 作为平台以自己的 Paddle 账户销售创作者的内容订阅，已确认可行（第 13.3 节）。确认依据（Paddle 的书面答复，或其条款中允许的条目）附在本节，没有依据之前 P3a 不开工：Paddle 作为记录商户对平台转售第三方内容有自己的审核口径，口头或印象中的「可以」不算。**待附。**
- **先行实施（2026-10-30）**：用户决定在第 13.2 节前四项齐备前开始 P3a。代码按 Paddle **sandbox** 实现；最低单笔价格（默认 $5.00）、平台管理费（默认 20%）、持有期（默认 120 天）与提现门槛（默认 $20）是控制台的 `commerce_config`，手续费口径的答复可以不经部署落地；创作者税务信息只记为「已收集文件」的记录（表格类型、状态、日期、核验人），不声称任何辖区的表格足够。第 13.2 节第 1–4 条**仍待落实**，落实前不在生产环境开放频道收款。

### 6.10 内容保护

- 频道检索**不设默认的返回上限与每日上限**，也不设覆盖率告警的默认阈值；创作者可以在频道设置里为订阅者自行开启每日上限。不设上限不会让所有者吃亏：第 8.2 节规定访客的检索一律不计入所有者，匿名访问由平台承担并受匿名限流约束；
- 付费的文章图片与音频只发短时效签名地址，不提供下载；频道不提供导出；
- 免费资产不需要登录即可阅读和检索（含匿名 A2A `search_context`），但走匿名限流（architecture.md 11.2），不计 Call；向分身提问需要登录（第 6.3 节）。

### 6.11 内容权利

- 把来源型资产（网站、GitHub 库）放进**公开**频道之前，所有者必须先完成 requirement.md 7.3 的认领，证明控制该来源，防止把别人的文档放进自己的频道并收费；上传文件、Notion 文章、文章、音频、问答由创建者直接声明权利（7.1）；
- 频道开通订阅时，增加一项明确确认：**本人拥有、或已获授权在 re0 上付费分发这些内容**；
- 收到侵权举报时，按 7.1 暂停涉事资产或整个频道的检索与新订阅并进入复核，已有订阅者按支付服务的规则退款。

## 7. Agent Card 与 A2A

### 7.1 三层 Agent Card

| 层级 | 代表谁 | 地址 | 公开卡的检索范围 | 认证后扩展卡多出 |
| --- | --- | --- | --- | --- |
| 1 平台 | re0 整体 | `https://re0.io/.well-known/agent-card.json` | 全部公开频道里的 `free` 资产，先路由到频道（第 3.7 节） | 调用方工作空间的资产操作：`ingest`、`refresh`、`publish` |
| 2 用户 | 一个用户 | `https://re0.io/a2a/users/{handle}/agent-card.json` | 该用户全部公开频道里的 `free` 资产 | 用户本人认证时：他的全部资产，包括不属于频道和私有频道的——这就是 slogan 里「你的数据资产 Agent」 |
| 3 频道 | 一个频道 | `https://re0.io/a2a/channels/{slug}/agent-card.json` | 该频道的 `free` 资产 | 订阅者认证时：该频道的 `paid` 资产 |

- 三层卡共用一个 A2A 服务，按 `supportedInterfaces[].tenant` 路由：平台卡 tenant 为空，用户卡写 `users/{handle}`，频道卡写 `channels/{slug}`；
- 私有频道没有频道卡；没有公开频道的用户，公开的用户卡上没有检索技能，只在本人认证后的扩展卡里出现；
- 用户主页、频道主页的 HTML 里加 `<link rel="agent-card">`，`sitemap.ts` 列出全部公开的用户卡与频道卡；平台卡提供 `find_channels` 技能，让其他 Agent 按主题找到频道及其卡。

### 7.2 技能

| Skill | 平台卡 | 用户卡 | 频道卡 | 说明 |
| --- | --- | --- | --- | --- |
| `find_channels` | ✓ | | | 按主题返回公开频道与频道卡地址，不调用模型 |
| `search_context` | ✓ | ✓ | ✓ | 结构化上下文：Chunk、Citation、Version，**不调用模型** |
| `ask` | ✓ | ✓ | ✓ | 带逐句引用的答案，走共用生成链路（第 7.7 节） |
| `ingest` | 扩展 | 扩展（本人） | | 把一个来源变成一项资产；长任务 |
| `refresh` | 扩展 | 扩展（本人） | | 刷新一项资产 |
| `publish` | 扩展 | 扩展（本人） | | 把资产放进频道；一律需要人确认 |

扩展卡还写明调用方工作空间的额度、容量和每日答案上限，不得出现内部服务地址或凭证（A2A 规范 13.3）。

### 7.3 版本与绑定

- 实现 A2A **v1.0**，打开 SDK 的 v0.3 兼容模式，接住尚未升级的客户端；
- **JSON-RPC** 与 **HTTP+JSON** 两种绑定都在 P1 提供；gRPC 不做；
- 流式响应用 SSE，跑在默认的 Node.js 运行时上。

### 7.4 鉴权与 API Key

MCP 下线后 **API Key 仍然需要**：

- A2A 的扩展卡要靠它识别调用者——用户本人的 Agent 访问自己的全部资产、订阅者的 Agent 访问频道的 `paid` 资产、`ingest` 等写操作，都要带 Key；
- REST `/v1` 继续用它做脚本化访问与测试。

规则：

- `securitySchemes` 声明 HTTP Bearer，凭证就是 API Key，Key 归属的工作空间即调用身份；
- 匿名请求只能用公开卡上的 `find_channels` 与 `search_context`，走匿名低额度与限流（architecture.md 11.2），不计 Call、不记到任何工作空间；`ask` 需要认证；
- 沿用 API Key 现有的权限范围（`lib/domain/api-key.ts`：`knowledge:search`、`knowledge:read`、`usage:read`、`admin:keys`）：`find_channels`、`search_context`、`ask` 要求 `knowledge:search` 或 `knowledge:read`；新增 `assets:write`，才能调用 `ingest`、`refresh`、`publish`；
- OAuth 留到以后。

### 7.5 可验证的结果

A2A 的 Artifact 由多个 Part 组成，re0 的结果固定带两个：

- `text`：答案正文（`ask`），或上下文的可读摘要（`search_context`）；
- `data`：结构化证据，包括每条 Citation 的 `chunk_id`、资产 ID、来源 URL、章节、Version，以及该版本的链上锚点（requirement.md 6.4）。

调用方 Agent 拿到 `data` 后，用公开 Verifier 就能独立核对版本，不需要再调用 re0。这是 re0 在 A2A 生态里别人很难照抄的差异点，Agent Card 的 `description` 里要明说。

### 7.6 任务生命周期

| 技能 | 典型状态路径 |
| --- | --- |
| `find_channels`、`search_context`、`ask` | 直接返回 Message，或 `WORKING → COMPLETED` |
| `ingest`、`refresh` | `SUBMITTED → WORKING → COMPLETED / FAILED`，对应一次构建 Workflow |
| 需要确认的操作（`ingest`、`refresh` 的扣费，`publish`） | `WORKING → INPUT_REQUIRED`，状态消息里写明等的是资产所有者在 Dashboard 中的确认，并给出待确认操作的链接；人确认后回到 `WORKING`；待确认操作 24 小时过期（第 5.2 节）或被所有者拒绝时转 `FAILED`，状态消息注明原因 |

- **调用方 Agent 不能自己确认**，和第 5.2 节是同一张待确认操作表。A2A v1.0 的 `AUTH_REQUIRED` 表示「调用方需要先完成认证」，`INPUT_REQUIRED` 表示「任务在等输入」；这里等的是另一个人（资产所有者）而不是调用方，两者都不完全贴合，取后者，因为调用方收到它之后该做的事一样：等待并轮询，而不是去换凭证。Agent Card 的 `description` 与技能说明里写清这条约定；
- 长任务建议调用方设 `returnImmediately: true`，再用推送通知或 `GetTask` 查进度；
- `CancelTask` 对构建任务的语义是取消排队；已开始写入的版本按 architecture.md 8.3 的发布事务处理，不会留下半成品。

### 7.7 生成答案的入口

- architecture.md 9.5「REST 不得引入 LLM 依赖」保留；MCP 部分随 MCP 下线删除；
- A2A 的 `find_channels` 与 `search_context` 和 REST 一样**不调用模型**，移除生成层后行为完全不变；
- 生成答案的入口限于在线试用、Agent 工作台、频道 AI 分身和 A2A `ask`，**共用同一条生成链路**（同一个检索函数、逐句闸门、引用绑定校验、降级为 Chunk 列表），受 requirement.md 5.1 同一组硬性规则约束。

### 7.8 在 Next.js 中接入

- 路由：`app/a2a/[[...tenant]]/route.ts` 承接三层卡的 JSON-RPC 与 HTTP+JSON 请求，`/.well-known/agent-card.json` 与各层 `agent-card.json` 由同一份卡片生成逻辑按层级输出；
- `@a2a-js/sdk` v1.x 的 `JsonRpcTransportHandler` 不依赖 Express：Route Handler 解析请求体、构造带工作空间身份与 tenant 的 `ServerCallContext`，调用 `handle()`；流式方法返回的 `AsyncGenerator` 转成 `text/event-stream`；
- `AgentExecutor` 只是适配层：把 A2A Message 转成第 5 节的 Agent 循环或检索调用，把结果写成 Artifact；
- **任务存储放 Postgres**。SDK 默认的 `InMemoryTaskStore` 和事件总线都在单个函数实例的内存里，Vercel 上第二个请求可能落到别的实例：`GetTask` 会找不到任务，`SubscribeToTask` 只能拿到一张快照。要实现基于 Postgres 的 `TaskStore`；`SubscribeToTask` 在函数时长内以短间隔读库推送状态变化，到时长上限后正常关闭流，由客户端重连。Upstash Redis 只做限流与缓存，不拿来做事件总线；
- 推送通知的回调 URL 在登记时过与抓取相同的 SSRF 校验（requirement.md 第 12 节第 1 条），每次发送前再解析校验一次。

### 7.9 re0 作为 A2A 客户端（P4）

re0 Agent 把子任务委托给用户已连接的外部 Agent，例如日历、CRM、报销。三个前提——外部 Agent 登记、凭证加密保存、逐次授权——在 P4 按下面的决定落地（2026-10-30）。

**1. 外部 Agent 登记**

| 项 | 决定 |
| --- | --- |
| 归属 | 按工作空间登记，只有 Owner / Admin 能登记、改动和删除；每个工作空间最多 20 个，和 API Key 一样 |
| 登记方式 | 填 Agent Card 的 URL：只收 `https`；只写了域名时取 `/.well-known/agent-card.json` |
| 抓取 | 走推送回调同一套 SSRF 校验（`lib/infrastructure/connectors/callback-url.ts`：字面地址检查之后，解析出的每个地址都不能是私有、回环或链路本地地址），不跟随重定向，10 秒超时，响应不超过 256 KB，必须是 JSON |
| 接受的卡 | 用 SDK 的卡片解析器规范化，打开 v0.3 兼容（P1 服务端也开了）；只保留 `JSONRPC` 与 `HTTP+JSON` 两种绑定、协议版本 1.0 或 0.3 的接口，每个接口 URL 同样要过字面 SSRF 检查；一个可用接口都没有的卡拒绝登记。gRPC 不做 |
| 保存 | 卡片快照（名称、说明、提供方、版本、可用接口、技能的 id / 名称 / 说明 / 标签、`securitySchemes` 与 `security` 要求）、快照摘要、抓取时间、状态 |
| 刷新 | 所有者在 Dashboard 点「重新抓取」，过同样的校验；接口或鉴权方式变了的卡，之前提出的委托在执行时按「卡片已变」失败，要重新提出 |
| 停用与删除 | 停用后不能再提出或执行委托；删除同时删掉凭证，已发生的委托记录保留（名称是快照） |
| 入口 | Dashboard 侧栏「Agent Card」分组新增「外部 Agent」（`/dashboard/external-agents`） |

**2. 凭证加密保存**

- 每个外部 Agent 至多一份凭证，两种：`bearer`（`Authorization: Bearer …`）与 `api_key`（请求头名取卡片里 `in: header` 的 apiKey 方案，没有就是 `X-API-Key`；放在 query 或 cookie 里的 apiKey 方案不支持）；
- 复用模型凭证的 `sealCredential`：AES-256-GCM，密钥由服务端环境变量 `CREDENTIAL_ENCRYPTION_KEY` 经 HKDF 派生，用途标签与模型凭证不同（`re0/agent-credential/v1`），不新增环境变量；
- 明文只在发送那一刻、在服务端解密，用完即弃；不进日志、错误信息、审计日志和任何 API 响应。保存后只显示种类和末 4 位（凭证短于 12 个字符时连末 4 位也不显示）；
- 用户可以轮换（覆盖并让版本号加一）和删除。

**3. 逐次授权**

- re0 Agent 新增 `delegate_task` 工具，**只在工作台**提供：A2A 调用方的技能里没有它，确认门对 `origin = a2a` 的委托提议直接拒绝；
- 它不执行，只生成第 5.2 节的待确认操作，确认卡片写明：目标 Agent（名称与卡片地址）、发送的接口（URL 与绑定）、技能、**要发送的原文**（不超过 4,000 字符）、要用的凭证（种类与末 4 位，或「不带凭证」）。参数摘要绑定这些值和凭证的 ID 与版本号：凭证轮换、删除，或卡片接口变化之后，旧卡片确认不了（执行时以 `stale` 失败）；
- 一次性、24 小时过期、只有登录的所有者能确认，模型、Chunk 文字和 A2A 调用方都不能——与第 5.2 节同一张表、同一组测试；
- 确认后服务端以 A2A 客户端身份用 SDK 发送**一次** `SendMessage`（`returnImmediately: true`，新的 `contextId`，技能写在 Message 的 `metadata.skill`），把远端任务记进 `agent_delegation`：远端任务 ID、状态、最近一条状态消息、Artifact；对方直接回 Message 的，记为已完成并保存回复；
- 所有者在对话里的委托卡片上点「刷新」走 `GetTask`，点「取消」走 `CancelTask`；服务端不在无人操作时自行轮询外部 Agent；
- 每次出站请求（`SendMessage`、`GetTask`、`CancelTask`）都重新做一遍上面的 SSRF 解析校验，不跟随重定向，20 秒超时，响应不超过 1 MB，保存的 Artifact 正文截到 32 KB；
- **外部 Agent 返回的一切都是不可信输入**：它不进入系统提示，不改变工具集合、工具权限和确认门；界面上以纯文本放在「外部 Agent 的输出，未经 re0 核实」框里，不当作 re0 的引证；规划器只能通过只读工具 `check_delegation` 读到它，结果带 `untrusted: true` 标记；回答模型从不收到它，它也不会成为带引用的句子（requirement.md 5.1）；
- 计量：委托本身、`GetTask`、`CancelTask` 都不计 Call（第 8.2 节未列收费项）；触发委托的那一问照常按工作台对话计 1 Call（检索有结果时）。

**4. 保留与删除（第 10 节中归 P4 的部分）**

- 入站 A2A 任务（P1 / P2）与出站委托的正文——Message、Query、状态消息、Artifact，以及待确认委托里的原文——**保留 30 天**，之后清空，只留 ID、状态、技能、时间与计量；由每日的 Cron 路由 `/api/cron/retention` 执行，P2 放在 drain 里的入站清理挪到这里；
- 工作台对话保留到所有者删除为止；
- `/dashboard/privacy`「导出与删除」：一键导出对话、入站 A2A 任务与出站委托（JSON），一键删除对话、一键删除全部 A2A 任务记录（入站与出站）；
- 私有资产（不在任何公开频道里的资产）的保留期：工作空间设置，可选「不自动删除」（默认）/ 30 / 90 / 180 / 365 天；以最近一次成功构建（没有则为创建时间）计，到期由同一个 Cron 走正常的删除流程；
- 隐私声明写明 Agent 对话与 A2A 任务的保存范围与期限。

## 8. 套餐与计费

### 8.1 套餐与容量

取消 Pro 订阅，只剩一档：

| 能力 | 规则 |
| --- | --- |
| 每月免费额度 | 1,000 Calls，当前账期有效，期末清零（同现在的 Free） |
| Additional Calls | **任何用户都可以购买**，$5 / 5,000 Calls，一次性付款，不过期，跨账期结转 |
| 工作空间总容量 | 默认 **500 MB**；用户**订阅过任意频道**或**买过 Additional Calls** 后，永久提升到 **2 GB**。想扩容的免费用户买一次 Additional Calls 即可 |
| 资产数、频道数 | 不单独设上限，只受总容量约束 |
| API Key 数 | 统一 **20 个**，两档容量相同 |
| 版本存证 | 包含 |

- 总容量统计工作空间内全部资产：抓取与上传内容按现有口径（requirement.md 4.1，解压后、规范化前的有效内容字节），加上文章图片与音频文件的大小；
- 容量提升按**用户**判断（订阅与购买都绑定在用户上），作用于该用户的个人工作空间；
- 创作者频道的订阅费是创作者自己的收入，不进入 re0 的套餐账单；
- `lib/domain/plans.ts` 中的 `pro` 档与按档区分的权益（站点密钥、分享页、`addonPurchase`）删除；`share_rate` 随分成一起删除，频道的 20% 管理费写在频道方案版本里。

### 8.2 计量

| 动作 | 计量 |
| --- | --- |
| A2A `find_channels` | 不计 |
| A2A `search_context` | 每次成功检索计 1 Call，零结果不计（同 requirement.md 4.2） |
| A2A `ask` | 每个答案计 **10 Calls**；每个工作空间每天最多 **500 个答案**。检索零结果时不调用模型、不计费；模型失败降级为片段列表时按 `search_context` 计 1 Call |
| 工作台对话中的一问 | 沿用在线试用：1 Call，生成成本由平台承担 |
| `ingest`、`refresh`、发布或修改文章与问答 | 沿用构建计量（requirement.md 4.2.1） |
| 上传音频 | 不计 Call，只占容量；节目说明的构建按 4.2.1 计 |
| 频道主页上问分身 | 需登录；计入**提问者**工作空间 1 Call，生成成本由平台承担（同工作台对话） |
| 已认证调用方通过 A2A 或 REST 检索频道（订阅者与非订阅者都一样） | 计入**调用方**自己工作空间的 Call |
| 免费资产的匿名阅读、收听与检索（含匿名 A2A `search_context`） | **不计 Call**，由平台承担；受匿名限流（architecture.md 11.2） |
| REST `/v1` 检索 | 规则不变 |

一条总原则：**谁发起，谁付 Call；没人可付时平台付，并用匿名限流兜底。频道所有者不为访客付 Call。** 之前的版本把分身提问和匿名检索记在所有者头上，所有者每月只有 1,000 免费 Calls，一个稍微受欢迎的免费频道会在月初被陌生人问到停摆，而且任何人都能故意刷光它；6.10 又不设默认上限，这个口子必须从计量规则上堵。
| A2A 协议操作（`GetTask`、`ListTasks`、`CancelTask`、取卡、推送配置） | 不计 |
| 阅读文章、播放音频、评论、订阅、退订、退款 | 不计 |

`ask` 不能照搬在线试用的「1 Call，平台承担生成成本」：A2A 是机器调用，量级不同。取值依据是 [playground-agent-proposal.md](./playground-agent-proposal.md) 第 8.2 节的估算（flash 级模型、按 $0.001 / Call 换算）：Agent 循环典型一问约 $0.0074，用满默认 4 步上限约 $0.0104。

- **10 Calls**：典型一问有约 35% 的余量，用满默认上限时打平，保证 A2A 问答不亏本；免费用户每月 1,000 Calls 约可问 100 次；
- **每天 500 个答案**：等于每天 5,000 Calls，约一包 Additional Calls（$5）。它不是为了限制正常用户，而是防止调用方的 Agent 陷入循环，一夜之间耗光额度；
- 两个值都放进控制台配置。A2A `ask` 上线一周后，用生产环境的 `llm_cost_event` 重新核算单问成本，偏差超过 20% 就调整。

### 8.3 平台收入

平台收入只有两项：Additional Calls 的销售，和频道订阅 20% 的管理费（扣除平台承担的 Paddle 手续费后为净收入）。发布者分成取消：分成原本从 Pro 订阅收入中拨出，Pro 取消后不再有分成池；创作者的回报是频道订阅收入，订阅制下也不存在刷调用量换收益的问题。

## 9. 不再适用的现有规则

| 规则 | 出处 | 处理 |
| --- | --- | --- |
| 四个入口：Web、REST、MCP、CLI/SDK | requirement.md 第 2 节 | 改为 Web、A2A、REST（站内与测试）；MCP 下线 |
| MCP 两项工具 `resolve-library-id` / `query-docs` | requirement.md 9.3 | 随 MCP 下线；REST 的两阶段查询保留；A2A 的 `search_context` 在服务端完成路由与检索 |
| Context7 接入模式作为决策依据 | requirement.md 第 1 节 | 从决策顺序中移除 |
| Free / Pro 两档与按档区分的权益 | requirement.md 4.1、`lib/domain/plans.ts` | 改为第 8.1 节的一档与两级容量 |
| 发布者调用分成 | requirement.md 4.4、publisher-revenue-share.md | 删除 |
| 专家库、自检问题与 Benchmark 的命中率部分 | requirement.md 4.4、6.3，expert-library-prd.md | 删除；Benchmark 只剩结构分 |
| 结算单上链 | requirement.md 6.4、aptos-anchoring-proposal.md | 保留，结算单改为创作者的频道收入结算单 |
| `llms.txt`、OpenAPI 来源 | requirement.md 6.1、7.3、8.1 | 删除 |
| 网站插件、分享页与自定义域名 | requirement.md 9.4、architecture.md 13.4 | 暂时下线；自定义域名不再提供 |
| 公开知识库的上架 | requirement.md 5.1、7.4 | 改为把资产放进公开频道 |

## 10. 安全与隐私

- **Life 场景的数据更私密**。需要补上：私有资产的保留期设置、一键导出与删除（现有 `/dashboard/export` 扩展到对话和 A2A 任务）、隐私政策里写明 Agent 对话与 A2A 任务的保存范围；
- **公开是一个明确动作**：资产默认不属于任何频道，只有所有者可用；放进公开频道需要人确认（第 5.2 节），Agent 和 A2A 调用方都不能代为确认；
- A2A 任务里的 Message 与 Query 正文同等保密：不进普通日志和 Analytics，任务记录默认保留 30 天后删除正文、只留 ID 与计量信息；
- 来自其他 Agent 的 Message 一律是不可信输入，和 Chunk 一样不能改变系统提示、工具权限或确认门；
- 用户卡的扩展卡只在本人认证时出现；任何人以他人身份都拿不到不属于频道的资产；
- 付费内容只对订阅者签发访问地址（第 6.10 节）；评论的安全与删除见第 6.8 节；订阅者的支付信息只保存在支付服务；
- 音频原文件只存私有 Bucket，不送往任何第三方服务；
- 分享页已收集的访客线索在下线时删除。

## 11. 需要修改的产品规则与架构约束

| 文档 | 位置 | 改动 |
| --- | --- | --- |
| requirement.md、architecture.md | 全文 | 按第 3.4 节改用资产与频道术语 |
| requirement.md | 第 1 节 | 决策顺序删除「Context7 接入模式」 |
| requirement.md | 第 2 节 | 产品定义改为「数据资产 Agent」；入口改为 Web、A2A、REST；核心价值删除「可持续供给」（分成），增加**可委托**：有副作用的操作必须经人确认 |
| requirement.md | 第 2.3 节 | 「通用 Agent Workflow」改为「不做通用 Agent：Agent 只操作用户的数据资产与频道」；「按知识片段、Token 或单个知识库分别报价」改为「re0 不按资产报价；频道订阅由创作者定价，平台收取 20% 管理费」；「平台自行持有或冻结用户资金、双重记账与自建清结算」改为「除待结算给创作者的频道收入外，平台不持有用户资金；频道收入的分账账本只记录应付与已付，不做双重记账与清结算」（第 6.9 节）；「自助套餐只有 Free、Pro 和 Additional Calls 三档」改为「自助套餐只有每月免费额度与 Additional Calls」；「REST 与 MCP 不生成最终长篇答案」改为「REST 不生成答案，生成入口见第 7.7 节」；增加「不支持视频、不做语音转写、不面向中国大陆」 |
| requirement.md | 第 4 节 | 4.1 改为一档与两级容量；4.2 增加 A2A 计量与「答案」单位，以及「谁发起谁付 Call、匿名由平台承担」的总原则；4.4 发布者分成改写为频道收入结算：80% 归创作者、Paddle 手续费由平台承担、任一笔交易最低 $5、120 天持有期、$20 提现门槛或转为 Calls、负余额处理；新增频道订阅：方案版本、20% 管理费、退订退款 |
| requirement.md | 第 5.1 节 | 首页改为对话入口；目录改为频道目录；新增用户主页、频道主页、文章与音频页、评论、订阅流程；删除 Publishers 页；生成答案的入口按第 7.7 节改写 |
| requirement.md | 第 5.2 节 | Dashboard 首页改为 Agent 工作台，侧栏重新分组；新增文章编辑器、音频上传、待答列表、评论管理、订阅收入、容量与购买；删除网站插件、分享页、收益与出账 |
| requirement.md | 第 5.3 节 | 管理后台删除专家审批、门槛配置、自检问题；结算与出账保留，改为频道收入 |
| requirement.md | 第 6 节 | 「Knowledge Library 领域模型」改为「数据资产与频道领域模型」：资产类型与 ID（第 3.2 节）；一项资产一个来源；资产与频道的归属；可见性（第 6.2 节）；6.3 删除测试集，Benchmark 只剩结构分；6.4 删除结算单上链 |
| requirement.md | 第 7 节 | 7.3 认领改为「来源型资产放进公开频道之前」，删除 `llms.txt` 与 OpenAPI 的验证方式；7.4 公开审核改为频道层面的下架与恢复；频道订阅增加付费分发权利确认 |
| requirement.md | 第 8 节 | Ingestion 每个来源各建一项资产；删除 `llms.txt` 与 OpenAPI；增加编辑器与音频两种来源 |
| requirement.md | 第 9 节 | 删除 MCP 与网站插件的契约；REST 保留，P5 改名；新增 A2A 与三层 Agent Card |
| requirement.md | 第 10 节 | 访问规则的名单可写频道 ID；第 6 步改为按第 6.2 节判断可见性 |
| requirement.md | 第 12 节 | 增加 A2A 任务正文保密、推送回调 SSRF 校验、评论的内容检查与删除 |
| architecture.md | 第 4 节 | 代码组织：新模块用 asset、channel 命名，旧模块在 P5 统一改名；下线模块用开关隔离；删除 revenue、expert-libraries 模块 |
| architecture.md | 第 6 节 | 第 12 节的新增与删除；P5 的表与列改名 |
| architecture.md | 第 7、8 节 | 对象存储增加音频文件、文章图片；Ingestion 增加编辑器与音频来源 |
| architecture.md | 第 9 节 | 9.2 资产过滤放宽为一组；9.5 生成入口按第 7.7 节改写；9.6 画像上移到频道 |
| architecture.md | 第 10、11 节 | Policy Engine 按第 6.2 节过滤；现有 Paddle Webhook 增加频道订阅的收款、续费、退款与拒付事件；11.4 分成记账改为频道收入记账；容量按用户资格判断 |
| architecture.md | 第 12、13 节 | REST 契约保留；删除 MCP Server；新增 A2A Server：三层卡、路由、Postgres 任务存储、流式订阅、推送 |

## 12. 数据模型

新表从一开始就用 asset、channel 命名；对现有 `library` 表的改动先写在现有表上，P5 随表一起改名。

**新增**

| 表或字段 | 用途 | 关键字段 |
| --- | --- | --- |
| `library.kind` | 资产类型 | 第 3.2 节的七种 |
| `library.access` | 频道内资产是否付费 | `free` / `paid`，默认 `free`；移出频道时重置为 `free` |
| `workspace.handle` | 工作空间的公开名 | 唯一，用于 `/u/{handle}` 与用户卡。挂在工作空间而不是用户上：频道、资产与 A2A 调用身份都按工作空间，订阅与容量档位按用户（第 8.1 节），MVP 一人一个个人工作空间所以两者重合，团队工作空间出现时 handle 仍指工作空间 |
| `user.storage_tier` | 容量档位 | `base`（500 MB）/ `extended`（2 GB），首次订阅频道或购买 Additional Calls 时升级，不回退 |
| `channel` | 频道 | `slug`、`workspace_id`、`title`、`description`、`visibility`（public / private，默认 public）、`status`、`subscriber_daily_limit`（可空，默认不限）、`profile`（频道画像） |
| `channel_asset` | 资产归属 | `channel_id`、`asset_id`（**唯一**，保证一项资产最多属于一个频道）、`pinned_at`、`published_at`、`scheduled_at` |
| 保留 owner 名单 | GitHub 资产的 owner 不得与根路径下的其他命名空间同形 | 第 3.2 节的名单，放在 `lib/domain`，资产 ID 解析与路由共用 |
| `post_draft` | 文章草稿（发布前不进版本线） | `asset_id`、`body`、`updated_by`、`updated_at` |
| `audio_media` | 音频文件 | `asset_id`、`object_key`、`mime`、`bytes`、`duration_ms`、`sha256`。实施为 `asset_media`，同一张表也存文章图片（`kind`、图片说明、`state`），迁移 0064 |
| `comment` | 评论 | `asset_id`、`author_user_id`、`parent_id`、`body`、`state`（visible / hidden / deleted / removed）、`pinned_at`、`created_at` |
| `comment_report` | 评论举报 | `comment_id`、`reporter_user_id`、`reason`、`resolved_at` |
| `channel_plan_version` | 不可变订阅方案 | `channel_id`、`interval`、`price_minor`、`currency`、`fee_rate_bps`（2000）、`provider_price_id`、`effective_from` |
| `channel_subscription` | 订阅 | `channel_id`、`user_id`、`plan_version_id`、`status`、`current_period_end`、`cancel_at_period_end`、`provider_subscription_id` |
| `publisher_account` 增加字段 | 沿用现有的发布者账户作为创作者收款资料 | `tax_form_status`（缺失 / 已提交 / 已核验）、`tax_form_kind`（W-9 / W-8BEN 等）；PayPal 邮箱沿用现有字段 |
| `earning_event` 增加来源 | 收入来源从「一次可计分成的检索」改为「一笔频道订阅收款」 | `channel_id`、`channel_subscription_id`、`provider_transaction_id`、`gross_minor`、`share_bps`（8000）；退款与拒付记为负数；注销核销记为 `written_off` 事件，金额为负余额的绝对值 |
| `channel_question` | 待答列表 | `channel_id`、`asker_user_id`、`question`、`source`（分身未答 / 直接提问 / 评论转入）、`state`、`answer_asset_id`、`asker_name_consent` |
| `answer_endorsement` | 作者确认 | `channel_id`、`answer_ref`、`version_id`、`endorsed_by`、`created_at` |
| `agent_conversation` | 工作台对话 | `workspace_id`、`created_by`、`title`、`updated_at` |
| `agent_action` | 待确认操作（工作台与 A2A 共用） | `workspace_id`、`tool`、`params`、`estimated_calls`、`estimated_bytes`、`makes_public`、`state`（pending / confirmed / rejected / expired）、`a2a_task_id`、`confirmed_by`、`expires_at`；过期与拒绝都把关联的 A2A 任务转为 `FAILED`（第 7.6 节） |
| `a2a_task` | A2A 任务 | `id`、`context_id`、`workspace_id`、`api_key_id`、`tenant`、`skill`、`state`、`history`、`artifacts`、`workflow_run_id`、`body_purge_at` |
| `a2a_push_config` | 推送通知配置 | `task_id`、`url`、`token`（加密保存）、`created_at` |
| `api_key.scopes` 增加取值 | 允许 A2A 写操作 | `assets:write`；现有字段与取值不变 |

**删除**

| 表或字段 | 原因 |
| --- | --- |
| `library_eval_question` | 去掉自检问题 |
| `library.expert_tagged_at`、专家申请相关表 | 取消专家库 |
| 分成池与按检索计收益所用的字段（`share_rate` 等） | 取消发布者分成；`earning_event`、`settlement`、`payout`、`publisher_account` 与锚点类型 `earning_statement` 保留，改记频道收入 |
| `library.visibility`（`visibilityEnum`） | 可见性由资产所在频道与 `access` 决定 |
| `source_type` 的 `llms_txt`、`openapi` | 删除这两种来源 |
| 分享页线索相关表 | 分享页下线，线索删除 |

**停用（保留在开关之后）**：`site_key`、`library_showcase`、`library_showcase_daily` 及分享页域名相关表。

## 13. 分阶段与决定

### 13.1 分阶段

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| P0 文案与清理 | 中英 slogan、`metadata`、OG 图；界面文案改为资产（页面路径不动，随 P1 改）；删除 Pro、专家库、自检问题、按检索计的发布者分成、`llms.txt` 与 OpenAPI 来源；关闭网站插件、分享页、MCP 的开关；Additional Calls 对所有人开放；两级容量 | 用户可见的界面里不再出现「知识库」、Pro、专家库、分成；任何用户都能购买 Additional Calls，购买后容量升到 2 GB |
| P1 资产、频道与 A2A | 资产类型与数据重建（第 3.3 节）；保留 owner 名单；页面路径改为 `/assets/*`、`/channels/*`；频道、频道主页、频道目录、用户主页；三层 Agent Card；A2A `find_channels`、`search_context`，JSON-RPC 与 HTTP+JSON；Postgres 任务存储；首页改版；计量按第 8.2 节的总原则改（匿名不计、调用方付） | 先验证 `@a2a-js/sdk` v1.x 提供 `JsonRpcTransportHandler`、可替换的 `TaskStore` 与 v0.3 兼容模式（第 13.2 节）；用官方 A2A Inspector 跑通三层取卡、`SendMessage`、`GetTask`；集成测试断言不属于频道的资产对他人不可见、私有频道没有频道卡、匿名检索不产生 Usage Event、owner 为保留名的 GitHub 资产被拒 |
| P2 工作台与写操作 | Agent 工作台、第 5.1 节工具、确认门；A2A `ask`、`ingest`、`refresh`、`publish`、扩展卡、推送通知；`assets:write` | 集成测试覆盖「模型或调用方 Agent 试图自行确认」被拒；`ask` 的 k 值上线 |
| P3a 文章、评论、问答与订阅 | 文章的撰写、导入、版本与发布；评论；待答列表与问答资产；作者确认；Paddle 频道订阅商品、订阅方案与任一笔 $5 最低价、20% 管理费与订阅；频道收入记账、结算、120 天持有期、负余额与 PayPal 出账；`paid` 访问控制 | 开工前提：第 13.2 节的 Paddle 书面确认、手续费口径、税务与合规意见三项齐全。非订阅者经 Web、A2A、REST 都取不到 `paid` 正文；订阅到期后下一次调用即被拒；评论不出现在任何检索结果里；首次订阅后容量升到 2 GB；集成测试覆盖「拒付冲回已出账收入后余额为负、创作者不能提现也不能开新付费方案」 |
| P3b 音频 | 上传、签名播放地址、节目说明进检索 | 非订阅者拿不到付费音频的签名地址；音频大小计入容量 |
| P4 A2A 客户端 | re0 委托外部 Agent；四个场景落地页 | — |
| P5 内部改名 | 代码模块与标识符、REST 路径与字段、错误码、数据库表与列全部改为 asset，测试同步修改 | 除迁移历史外不再出现 library 标识符；全部测试通过 |

### 13.2 待决定与待核实事项

> 2026-10-30：第 1–4 条**仍待落实**；P3a 已按用户决定先行实施（第 6.9 节「先行实施」）。

1. **创作者税务信息**（P3a 开工前；待落实）：按 re0 主体所在地确认要收集的表格与申报义务（例如美国的 W-9 / W-8BEN 与 1099）；
2. **记录商户转售与代付的合规意见**（P3a 开工前；待落实）：re0 以自己的 Paddle 账户销售创作者内容并向创作者付款，取得法务或会计对资金保管、代收代付与申报义务的书面意见（第 6.9 节）；
3. **Paddle 可售范围的书面确认**（P3a 开工前；待落实）：把 Paddle 的书面答复或条款条目附到第 6.9 节；
4. **Paddle 手续费口径**（P3a 开工前；待落实）：核实 5% + $0.50 是按含税总额还是按小计计算，据此复核 $5 最低价；最低价已是控制台配置，答复到后在「频道收款设置」里调整即可；
5. **`@a2a-js/sdk` v1.x 能力**（P1 开工前）：仓库里尚未安装该包，本文对 `JsonRpcTransportHandler`、可替换的 `TaskStore`、v0.3 兼容模式的描述来自记忆，要装包核对；若没有兼容模式，只实现 v1.0。

### 13.3 已决定事项（2026-10-29）

1. **REST 接口 `/v1/*` 不下线**：网站内部与测试都依赖它——`tests/` 下的 contract、integration、security 测试共有 22 个文件提到 `/v1`；`/v1/api-keys` 等管理接口的常规调用方就是已登录的浏览器（`app/api/v1/api-keys/principal.ts` 同时接受站内会话与带 `admin:keys` 的 Key）。对外宣传的出口仍然只有频道、Agent Card 与 A2A；
2. **文档仓库只考虑 GitHub**，删除 `llms.txt` 与 OpenAPI 来源；
3. **不考虑兼容**：网站尚未运营，不设下线通知期，不保留旧路径、旧接口名与旧数据形态；
4. **API Key 保留**：用于 A2A 扩展卡的身份识别与 REST（第 7.4 节）；
5. **容量**：工作空间总容量默认 500 MB；订阅过任意频道或买过 Additional Calls 的用户提升到 2 GB；资产数与频道数不单独设上限；
6. **不补偿**现有 Pro 用户；
7. **取消发布者分成**：Pro 取消后没有分成来源；频道是订阅制，不存在刷量风险；
8. **平台收取频道订阅 20% 的管理费**（最初定为 15%，同日上调）；
9. **不考虑中国大陆**，支付与运营只面向海外；
10. **频道检索不设默认上限**，也不设覆盖率告警的默认阈值；前提是访客的检索不计入所有者（0.10 补上，第 8.2 节）；
11. **音频不做语音转文字**，只有标题与节目说明进检索；
12. **去掉自检问题**，不再有专家库的说法；
13. **不提供自定义域名**；
14. **P5 修改数据库表名**，不在 Drizzle 层映射旧表名；
15. **频道订阅用 re0 现有的 Paddle 账户收款**，Paddle 手续费由平台承担，创作者拿订阅金额的 80%，由 re0 按月结算、经 PayPal 出账；任一笔交易最低 $5，月付与年付都适用（0.10 由「月付最低 $5」扩展，理由见第 6.9 节）。re0 作为平台以自己的 Paddle 账户销售创作者内容，已确认可行，书面依据待附（第 13.2 节）；
16. **API Key 上限统一为 20 个**，不分容量档；
17. **A2A `ask` 每个答案计 10 Calls，每个工作空间每天最多 500 个答案**，上线一周后按生产成本复核（第 8.2 节）；
18. **频道目录「热门」排序 = 0.5 活跃度 + 0.25 新鲜度 + 0.25 质量**，订阅与收入不进入排序（第 6.4 节）。
