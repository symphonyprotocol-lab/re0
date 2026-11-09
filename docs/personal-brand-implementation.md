# Ree 个人品牌功能实施方案

日期：2026 年 11 月 4 日  
状态：待实施  
目标版本：首批 10 位个人品牌用户试点

为有作品、正在提供专业服务的人新增“个人主页模式”。本人提供并审核可公开的资料，访客在主页直接了解作品、提问和联系合作，问答费用由本人承担。

首版复用现有 Ree、资料导入、检索、引用、积分账户及模型管理能力。开发重点是个人主页、匿名问答、主人预算、资料公开确认和转化统计。本文中的限额是首版默认配置，可在试点后调整；不代表现有功能或已验证的商业结果。

## 1 产品目标和范围

### 1.1 核心用户和任务

首批在独立设计师、独立开发者和品牌顾问中选择最容易触达的一类，集中完成 10 个主页。优先选择有作品资料、正在接受合作、已有个人展示渠道的人。

主人要完成的任务是：整理可公开资料，确认主页和回答准确，分享链接，了解访客兴趣及合作意向。访客要完成的任务是：判断这个人能提供什么帮助、查看相关证据，并决定是否联系。

主路径：创建个人主页 → 添加资料 → 确认公开范围 → 访客视角试问 → 发布分享 → 访客直接提问 → 查看作品或联系本人。

### 1.2 首版包含

- 新增个人主页模式及专用创建入口，保留通用 Ree 的现有用途。
- 本人身份、服务范围、代表作品、外部联系方式和示例问题。
- 未登录访客在公开页内进行单个 Ree 的连续问答。
- 主人承担问答费用，设置每个 Ree 的月度预算，访客无需购买积分。
- 按资料明确确认是否可用于对外回答，发布前以访客视角试问。
- 分享卡片、复制链接，以及访问、提问、作品和联系点击统计。
- 配套的异常处理、费用回收、权限、限流和中英文文案。

### 1.3 后续版本

自定义 slug、自定义域名、网站嵌入、语音和形象克隆、预约系统、站内私信、CRM、联系人表单、完整聊天导入注册账户、多套主题、自动发布访客问答、按问题语义生成兴趣报告，均不纳入首版。

首版以外部邮箱或 HTTPS 预约页面承接联系，不保存访客联系方式。保留现有视频介绍作为可选展示，不把生成视频设为发布条件。

## 2 现有能力和实施入口

以下路径相对于仓库根目录。实施以工作区当前代码为准；新增迁移在开始编码时读取最新 migration journal 后生成，不预占迁移编号。

| 能力 | 当前入口 | 本次处理 |
| --- | --- | --- |
| Ree 创建 | `components/rees/setup-wizard.tsx`、`lib/domain/ree.ts`、`lib/services/rees.ts` | 增加 personal 模式及草稿字段，复用资料导入 |
| 公开页 | `app/(discover)/r/[slug]/page.tsx` | 按模式渲染；personal 直接显示问答及联系入口 |
| 加入对话 | `components/discover/join-button.tsx` | 保留通用模式；personal 首屏主操作变为直接提问 |
| 检索及问答 | `lib/services/chat.ts`、`lib/domain/answer.ts`、`lib/services/answer.ts` | 抽取生成核心；独立实现访客授权、历史及结算 |
| 资料和索引 | `lib/services/knowledge*.ts`、`lib/services/profile.ts`、`lib/services/explore.ts` | 增加个人模式的公开资料过滤，覆盖全部召回路径 |
| 积分 | `lib/services/credits.ts`、`lib/domain/credits.ts` | 复用冻结、结算和释放；新增访客问答账目原因 |
| 模型选择和成本 | `lib/services/generation.ts`、`lib/domain/model-calls.ts` | 按付费主人选择模型，记录访客请求关联 |
| 数据统计 | `lib/services/statistics.ts`、`components/statistics/owner/` | 新增个人主页统计，不混入现有问答收入 |
| 数据结构 | `db/schema.ts`、`db/migrations/` | 增量增加字段和表，不修改既有对话的用户归属约束 |
| 社交分享 | `app/(discover)/r/[slug]/opengraph-image.tsx` | 个人模式生成姓名、职业和头像卡片 |
| Cookie 和客户端 IP | `lib/http/cookies.ts`、`lib/http/conversations.ts` | 访客 cookie 沿用 `cookieOptions` 和 `__Host-` 前缀规则；IP 直接复用 `clientIp`（`x-real-ip` 优先） |
| 定时任务 | `vercel.json`、`app/api/cron/` | 注册回收任务；沿用 `CRON_SECRET` 保护 |
| 管理后台 | `app/admin/(console)/rees/`、`components/admin/` | Ree 列表和详情显示 mode；下架同样作用于个人主页；访客请求和成本可筛选 |
| 平台配置 | `model_config` 的后台配置模式 | 个人模式开关、访客开关和允许名单存库并由管理员切换，不走环境变量 |

通用常量：时间口径统一引用 `lib/constants.ts` 的 `REPORT_TIME_ZONE`（当前为 Asia/Shanghai），示例问题限制引用 `REE_LIMITS.sampleQuestions` 和 `REE_LIMITS.sampleQuestion`（当前 3 条、每条 160 字符），基础费引用 `QUERY_BASE_FEE`。本文不再另行定义这些数值。

当前公开页没有直接问答输入框；访客通过“加入对话”先登录。现有问答按提问者账户冻结基础费和查询费，并可能向主人记收入。个人模式必须把“访问者身份”和“付费账户”分开，不能通过把匿名访客伪装成主人来复用旧接口。

## 3 创建和管理流程

### 3.1 创建入口

新增 `/personal` 落地页，主文案为“让别人通过对话，认识你的经历、作品和想法”。主按钮进入 `/rees/new?mode=personal`，未登录时保留该返回地址。

原创建入口默认 general。`mode` 写入服务端草稿；四步流程内前进、后退、刷新和登录后返回都不丢失。首版只在创建时选择模式，已有通用 Ree 不自动转换。

个人模式在第一步提交后通过专用幂等接口创建 `isPublic=false` 的 Ree 和 profile，并把 `personalReeId` 写入现有服务端草稿；第二步因此可以复用真实资料导入和索引，第三步可以真实试问。返回前一步或恢复草稿始终更新同一个 Ree，不重复创建或扣资料处理费。第四步只做发布，不再次创建 Ree。通用模式仍沿用最终一步才创建的现有规则。

现有草稿是 `user.ree_draft` 上一人一份的 JSON，两种模式共用这一个槽位，规则如下：

- 草稿只是向导进度的指针，个人 Ree 本身是正式数据。草稿清空（`DELETE /api/rees/draft`、通用模式最终创建、或主人改开通用向导）只删除进度，不删除已创建的个人 Ree；该 Ree 继续留在 `/rees` 列表，标记“未发布的个人主页”，主人可从列表继续设置或删除。
- 已存在未发布的个人 Ree 时，再次进入 `/rees/new?mode=personal` 先让主人选择“继续已有主页”或“新建一个”，不默认覆盖。首版不限制一个主人拥有的个人 Ree 数量，但发现页和试点名单按 Ree 计。
- `personalReeId` 指向的 Ree 必须属于当前用户、mode 为 personal 且未删除，否则视为无效草稿并提示重新开始。
- 个人 Ree 在未发布期间同样出现在 Ree 列表、总数统计和管理后台，`readySources` 计数和首份资料就绪后的建议问题生成照常运行。

### 3.2 四步创建

1. **身份和合作**：姓名、头像、职业简介、服务范围、联系按钮。公开姓名独立于账户昵称，不修改账户身份。通用 Ree 的 category、tags、description 和 systemPrompt 在个人向导中不出现：category 固定为 `other`，tags 为空，description 由 headline 填充，systemPrompt 为空并由个人模式的固定指令（第 5 节）接管；`validateReeFields` 按 mode 分支，personal 跳过分类和提示词校验。
2. **作品和资料**：添加作品卡片并上传资料。资料先进入私人管理区，主人逐项确认可用于对外回答；确认说明包含“回答和引用可能展示资料原文片段”。新资料默认未确认。
3. **预览和试问**：展示与真实访客一致的主页和资料过滤结果。系统提出最多三个候选问题，本人编辑采用后显示。至少有一份 ready、enabled 且已确认公开的资料，才允许开启问答。
4. **预算和发布**：设置预算、试问典型问题、确认 AI 身份说明，再发布。发布后跳转到主页管理页，给出预览、复制链接和查看统计三个动作。

准备不足的主页可保存草稿。主页发布允许 `guestEnabled=false`，此时仍展示本人、作品和联系方式，并明确显示问答尚未开启。

### 3.3 主页字段

| 字段 | 首版限制和行为 |
| --- | --- |
| 姓名和头像 | 复用 Ree name、avatar；personal 名称上限 40 字符，统一前后端校验 |
| 职业简介 headline | 必填，最多 80 字符 |
| 个人介绍 bio | 最多 1,000 字符，纯文本，不执行 HTML |
| 服务范围 services | 最多 5 项，每项最多 80 字符 |
| 作品卡片 works | 最多 6 项；标题 80、本人贡献或说明 300 字符、HTTPS 链接；首版不新增封面上传 |
| 联系按钮 contact | 一个主要入口；标签 20 字符；只允许 HTTPS 或合法 mailto 地址 |
| 外部账号 links | 最多 5 个 HTTPS 链接，标签 20 字符 |
| 示例问题 | 复用现有 `sampleQuestions` 字段和 `REE_LIMITS` 限制（3 个、每个 160 字符），不另设个人模式上限 |
| slug | 创建时沿用随机唯一 slug；首版不新增修改 slug，避免旧链接失效。可自定义 slug 列入后续版本（第 1.3 节） |

创建/修改服务范围、介绍、作品和联系信息时，在同一事务同步生成一份“个人公开介绍”text 资料，内容只包含本人明确填写的事实。这份资料由系统管理、默认确认公开，用于回答身份、作品和联系问题；手工资料管理页只允许查看，修改通过主页表单进行。

更新后沿用资料切分和索引流程，但系统介绍不走 `knowledge_hold`：它篇幅固定、由表单保存触发、改一句话就重新处理，若按上传资料收费会让主人每次改简介都扣积分。实现上为系统介绍单独走免费处理路径（`createKnowledgeInTx` 和 `reprocessInTx` 按 `managedKind` 跳过冻结），其 embedding 调用仍记入模型调用日志和平台成本。该资料正在重新处理时，暂停整页问答并显示更新中，防止回答旧的合作信息；静态作品和联系入口继续可用。主人自行上传的资料仍按原有规则收处理费，表单保存前展示预估费用和余额不足状态。

## 4 公开主页和访客体验

### 4.1 页面结构

个人模式沿用 `/r/[slug]`，对登录和未登录访问者都使用个人展示布局，不把已登录访客直接带进多 Ree 工作区。

页面顺序为：姓名、职业简介和头像 → 服务范围 → 代表作品 → 可点击示例问题和提问框 → 外部联系方式。移动端保持提问和联系易于找到。视频介绍可选；不展示按次查询价格和收入数据，相关 Ree 推荐默认不显示。

个人 Ree 首版不进入发现页：`explore.ts` 的 `publicRee()` 增加 `mode = 'general'` 条件，列表、分类、搜索、`activeRees`、多 Ree 对话的 `suggestRees` 以及通用公开页的“相关 Ree”“作者的其他 Ree”都不返回 personal。原因是发现卡片展示查询费和回答数，与个人主页“不展示价格”冲突，试点期也只靠主人自己分享。主页只能通过直接链接访问；收录发现页列入后续版本。

提问区固定说明：“这是 AI 根据本人提供的资料生成的回答。报价、档期和合作承诺请向本人确认。对话用于提供服务及汇总统计，主页主人不会在首版后台直接查看你的完整聊天。”详细说明链接到同步更新的隐私政策。

### 4.2 问答行为

- 访问页面不创建会话、不调用模型；首次提问时才创建访客会话。
- 点击示例问题直接发送，可连续追问。只回答当前主页 Ree，不执行 @ 指派、不推荐其他 Ree。
- 公开页上的所有访客都走主人承担费用的路径；登录状态不改变这条路径的扣费人。首版 personal 不提供加入多 Ree 工作区的操作，候选列表排除 personal，参与者 API 同样拒绝添加。通用 Ree 的已登录付费问答继续使用原流程。
- 匿名会话保留 7 天，浏览器 cookie 有效 30 天。换浏览器、清 cookie 或 cookie 失效后，不自动恢复历史。
- “清除此页对话”删除当前会话的文本、答案和引用；账务及无文本统计保留。若仍有请求运行，先关闭会话并使请求终止，再执行清理。
- 首版不提供匿名会话导入注册账户；页面可提供“创建我的个人主页”入口。
- 主人登录后点击“访客视角试问”，走相同检索和生成规则，标记为测试；实际扣主人基础费，但不计入获客统计或访客预算。只有绑定该主人登录态的测试会话可以绕过未公开和 guestEnabled=false；仍需灰度开关、资料就绪和公开确认。测试会话接口可在发布前使用。
- 个人 Ree 只保留这一条试问路径。现有的单 Ree 试问对话（`conversation.kind = ree_test`，`/rees/[id]/chat`）对 personal Ree 关闭：`chat.ts` 的 `testConversation` 拒绝 personal，Ree 详情页的试问入口改为跳到访客视角试问。这样公开过滤、费用和统计只需在访客路径实现和验收一次，主人看到的也和访客完全一致。

### 4.3 降级状态

| 状态 | 访客表现 |
| --- | --- |
| 没有可公开资料或资料更新中 | 保留作品及联系；关闭输入框并解释暂不能回答 |
| 主人预算耗尽或余额不足 | 显示“本页暂时无法提供 AI 问答，你仍可查看作品或联系本人”；不要求访客充值，不暴露主人余额 |
| 限流 | 显示稍后再试，HTTP 返回 Retry-After；不扣费 |
| 资料无法回答 | 提示当前资料未涉及，可联系本人；不猜测经历、报价或档期 |
| 生成失败或超时 | 明确失败，允许重新提问，不把半段答案标成成功 |
| 主人关闭公开、管理员下架或删除 | 新访问、历史及问答接口均返回 404；不能仅隐藏前端 |

## 5 公开资料和回答边界

新增 `knowledge.publicApprovedAt`，默认为 null。个人 Ree 的对外问答只检索同时满足 ready、enabled、未删除、已确认公开的资料。通用 Ree 保持原有检索规则。

该限制同样适用于访客视角试问、示例问题生成、profile vectors 以及 `profile.ts` 中直接编写的 SQL。个人 Ree 进不了多 Ree 对话、单 Ree 试问对话和发现页（第 4 节），因此登录问答和发现搜索不会命中 personal 的资料；但 `answerableKnowledge` 一类的共用过滤仍要按 mode 分支并加测试，防止以后某条路径放开时漏掉。不能只给匿名 API 增加过滤。主人在资料管理页查看私人原文件继续使用原有所有权权限。

撤销公开确认、禁用、删除、刷新内容、开始重新处理资料或修改主页公开信息时，递增个人主页的 `publicRevision`。内容刷新后取消原公开确认，由本人检查新内容后重新确认；系统管理的公开介绍由表单确认替代逐项确认。

访客请求保存启动时的 revision，在生成开始和成功结算前再次检查。期间 revision 改变则停止请求，标记失败并释放冻结。不能撤回已发送到浏览器的文字，但之后不再返回已失效的答案或引用。

引用接口仅返回当前可公开资料的标题、定位信息和最多 300 字符片段，不返回私有 Blob 路径、访问签名、整份原文或内部文件位置。只显示系统校验过的公开 HTTPS 原文链接；旧引用在资料撤销后变为“来源已撤回”。历史答案所属 revision 与当前不一致时隐藏答案正文，要求重新提问；后台账务不受影响。

个人模式增加高优先级指令：只说明资料中的本人事实，不能自行补充本人经历、模拟当前意愿、承诺价格和档期或代表本人签约。该规则和现有证据及引用规则共同生效，主人自定义语气不能覆盖。回答前端渲染继续转义文本，链接采用安全协议校验和 `noopener noreferrer`。

## 6 访客身份和限额

首次访问统计或首次提问时签发高熵浏览器 cookie，名称沿用 `lib/http/cookies.ts` 的规则：HTTPS 下为 `__Host-re0_guest`，本地为 `re0_guest`；属性复用 `cookieOptions`（HttpOnly、Secure、SameSite=Lax、path `/`），只改过期时间。首次 page_view 由 events 接口签发 cookie 后记入同一 visitor key；签发 cookie 不创建聊天会话或调用模型。服务端仅保存使用专用 `GUEST_SESSION_SECRET` 计算的 HMAC visitor key，不保存原始 cookie。会话 ID 不能独立作为访问凭证，读取和写入必须同时匹配 cookie、Ree 和有效期。

访客写接口校验 Origin 为站点自身；不开放跨站 CORS。公开能力只能来自服务端查询到的 personal、公有、未下架、未删除且灰度已开启的 Ree。客户端不能提交 ownerId、付款人、费用、模型或任意历史消息作为可信数据。

首版所有实例共享数据库限流，不用进程内 Map。现有 `rate_bucket` 只有发现页搜索在用，并且由每小时的 rank 任务删除一小时前的窗口，放不下按日计数。因此分钟级窗口复用 `rate_bucket` 的 `guest:` 命名空间，按日计数存新表 `ree_guest_rate`（key、day、hits，主键 key+day），由回收任务按 7 天清理；两张表的清理不互相影响。只有 `POST .../messages` 和 `POST .../sessions` 计尝试，`GET` 会话查询和事件上报各自有宽松的独立限额，不计入尝试。默认配置如下：

| 限制 | 默认值 |
| --- | --- |
| 单次问题 | 1 至 1,000 Unicode 字符，最多 8 KB 请求体 |
| 单次输出 | 1,000 output tokens，上下文最多最近 6 轮成功问答 |
| 访客加 Ree | 同时只运行 1 次；每分钟 5 次尝试，每日 20 次尝试 |
| IP 全站 | 每分钟 30 次尝试，每日 200 次尝试 |
| 每个 Ree | 同时 3 次运行，每日最多 300 次尝试 |
| 单请求 | 总时限 120 秒；每 15 秒续租，租约 45 秒 |

IP 直接复用 `lib/http/conversations.ts` 的 `clientIp`（`x-real-ip` 优先，再取 `x-forwarded-for` 首项），不另写取法；存储按日轮换的 IP HMAC，7 天后清理。共享网络可能触发 IP 限额，记录拒绝率后再调整。清 cookie 不能绕过 IP、Ree 次数及费用上限。无答案和失败也计尝试限额，以限制模型实际成本；限流发生在 embedding 和生成之前。

`GUEST_SESSION_SECRET` 缺失、限流或预算存储不可用时关闭访客问答并保留静态主页；不放行无限请求。

## 7 主人预算和结算

### 7.1 价格和资金来源

成功访客回答只收 `QUERY_BASE_FEE`，首版当前值为 20 credits；请求创建时保存价格快照，不硬编码散落数值。`queryFee` 在 personal 中固定为 0，后端拒绝非零设置，不向主人产生 `query_fee_earned`，避免自付费用形成收入循环。

沿用主人的积分账户和可用积分顺序；预算只是消费上限，不是额外积分。模型通过 `generationForUser(ownerId, 'guest_answer')` 按主人当前会员状态选择，访客是否有会员不影响模型选择。`CALL_PURPOSES` 增加 `guest_answer`，同步 `model_call` 的 purpose 约束和后台筛选。`model_call` 现有的 `requestId` 是供应商侧请求标识，不能挪用；新增 `reeId` 和 `guestRequestId` 两列（可空，带索引）把调用关联到 Ree 和访客请求。日志 userId 表示付费主人，不表示访客身份。

试点补贴通过现有管理员积分调整功能人工发放，流水备注试点用途，不新增购买套餐。补贴在现有账户中与其他消费共用，不宣称为专用问答余额。首版不新增自动扣款或自动购买积分。

每个个人 Ree 默认月预算为 2,000 credits，主人必须确认后才能开启；设置为 0 表示关闭。预算按 `REPORT_TIME_ZONE` 自然月计，不与订阅账期混用。多 Ree 共享主人余额，各自有预算。导入费用和主人试问不计访客预算。

### 7.2 原子冻结和幂等

访客接口以 `(sessionId, clientRequestId)` 唯一约束去重，同时保存问题 hash。相同 key 加不同问题返回 409；运行中返回 409 和状态地址；终态请求返回原状态和结果，不再次调用模型或扣费。

创建请求的短事务按固定顺序锁定 session、profile 和当月 usage 行，检查公开状态、revision、单会话及 Ree 并发、预算和限额，再调用现有 `placeHold` 锁定主人积分。写入请求、holdId、费用快照及预算 `reserved` 后提交。事务中不进行网络或模型调用。并发上限检查通过锁定 profile 串行化请求准入；额度检查使用 `spent + reserved + fee <= monthlyLimit`。

锁顺序对所有触碰 `ree_personal_profile` 的事务统一为：session → profile → usage → 积分（`placeHold` / `settleHold` / `releaseHold` 内部的 grant 和 hold 行）。主人侧的操作也要遵守：资料刷新、重新处理和批量操作既递增 `publicRevision`（锁 profile）又放处理费冻结（锁积分行），必须先更新 profile 再调用 `placeHold`，否则与访客请求形成相反锁序而死锁。实现时在 `personal-profiles.ts` 提供唯一的 `lockProfile(tx, reeId)` 入口，访客和主人路径都通过它取锁，并用集成测试并发跑访客提问与资料刷新。

由服务端确认的 isTest 请求跳过访客月预算和 usage 的冻结、结算计数，仍执行主人余额冻结、请求幂等、租约及尝试限流。其余正常访客请求不得通过任何客户端标志绕过预算。

结算规则：

| 结果 | 主人积分 | 月预算 | 请求终态 |
| --- | --- | --- | --- |
| 完整回答成功且 revision、租约仍有效 | settleHold 一次 | reserved 减少、spent 增加 | succeeded |
| 无证据、模型拒答 | releaseHold 一次 | reserved 释放 | no_answer |
| 模型失败、超时、资料撤回、租约丢失 | releaseHold 一次 | reserved 释放 | failed 或 expired |
| 访客关闭页面但服务端完整生成成功 | 正常结算 | 正常计费 | succeeded |

结算事务保持与冻结一致的锁顺序，条件更新请求状态并调用积分结算或释放；积分和预算变化与状态写入同一事务提交。已终态请求不能再次结算。请求保留自己的月份，跨月完成仍结算到创建时月份。

新增账目原因 `guest_query_hold`、`guest_query_base`、`guest_query_refund`，复用 hold kind=chat 并增加专用 ledger 映射。账单展示“个人主页访客问答”，关联 requestId、Ree；保留现有登录问答流水和统计口径。积分 grant 已过期后的释放继续遵循原到期规则，不能把已到期积分重新变成可用。

### 7.3 超时恢复和上限调整

新增清理任务每分钟处理租约过期且仍运行的请求，锁定后释放冻结及预算、标记 expired。生成工作持有唯一 lease token；续租和成功结算必须同时匹配 token、运行状态和有效租约。清理后恢复的旧工作不能重新写入成功结果或再次结算。不得只依赖流关闭或 finally 执行释放。

调低预算不撤销已经冻结的请求；低于 `spent + reserved` 时仅禁止新请求。关闭问答停止新请求，已获准请求允许按上述规则结束；撤销公开或下架则同时撤销活动请求。余额与预算分别检查，主人管理页明确显示限制来自哪一项。

无答案和失败虽然不向主人扣积分，也可能产生供应商成本。后台将 embedding、生成和失败调用关联到访客请求，统计真实成本和未解析成本；免费不等于供应商没有计费。达到每日次数或平台灰度总成本阈值后停止新请求，不把未知成本按零计算。

## 8 数据结构

新增名称为建议实现名，实际编码时沿用项目 snake_case SQL 和 camelCase TypeScript 约定。所有变更通过增量迁移、数据库约束和服务端校验实现。

| 位置 | 字段和约束 |
| --- | --- |
| `ree` | `mode: general \| personal`，默认 general；personal 查询费必须为 0 |
| `ree_personal_profile` | `reeId` 主键外键；headline、bio、services、works、contact、links；guestEnabled 默认 false；monthlyLimit 非负整数；publicRevision 非负；publicIntroKnowledgeId；createdAt、updatedAt；草稿允许缺少 contact，发布必须有效 |
| 现有 Ree 草稿 | 扩展 mode、personalReeId 及个人表单字段；personalReeId 必须属于当前用户，按草稿加行锁防止重复创建 |
| `knowledge` | publicApprovedAt、publicApprovedBy；`managedKind: personal_intro \| null`；系统介绍每个 Ree 至多一份，审批者必须是主人 |
| `ree_guest_session` | UUID id、reeId、visitorKey、isTest、createdAt、expiresAt、closedAt；索引 reeId/visitorKey/expiresAt；会话仅绑定一个 Ree |
| `ree_guest_request` | UUID id、sessionId、reeId、payerUserId、clientRequestId、questionHash；question、answer、citations；status、outcomeCode；publicRevision、feeCredits、monthStart、holdId；leaseToken、leaseExpiresAt；startedAt、completedAt、contentExpiresAt、isTest |
| `ree_guest_usage` | `(reeId, monthStart)` 联合主键；spent、reserved 非负整数；createdAt、updatedAt；不存主人可用余额副本 |
| `ree_personal_event` | UUID id、reeId、visitorKey、sessionId 可空；eventType、targetId、source、requestId 可空、clientEventId、isTest、createdAt；不保存问题正文或完整来源 URL |
| `ree_guest_rate` | key、day 联合主键；hits 非负整数；按 7 天清理；与 `rate_bucket` 的小时级清理分开 |
| `platform_setting` | key 主键、value jsonb、updatedAt、updatedBy；存 personal 模式开关、访客开关、允许名单和每日供应商成本上限；管理员后台可改 |
| 现有积分和模型日志 | 新 ledger 原因和 `CREDIT_ENTRY_REASONS` 的 DB check；`guest_answer` purpose；`model_call` 新增 reeId、guestRequestId；同步类型、后台筛选和成本报表 |

请求状态为 `running | succeeded | no_answer | failed | expired`。无资料或准入失败直接返回错误，不创建可收费请求。请求 id 是账务关联，匿名会话不复用 `conversation.userId`，不创建虚假 user 或把主人塞进访客会话。

session 闭合或到期后拒绝读取和写入。问答正文和引用 7 天后清空，保留请求状态、金额及账务关联；会话在无活动请求后清理。清空对话遵循相同规则。事件保留 90 天后删除或转为不含 visitorKey 的日汇总。首版主人后台只提供汇总及固定示例问题的统计，不开放访客聊天全文或自由输入问题列表。

## 9 接口合同

所有写接口复用现有 JSON 解析、Origin 校验、错误格式和限流工具。主人接口沿用 apiUser 及 ownedRee 权限，访客接口使用 guest cookie 权限。列表和统计默认按 `REPORT_TIME_ZONE` 日期聚合。

| 接口 | 输入和权限 | 返回和副作用 |
| --- | --- | --- |
| `POST /api/rees/personal-draft` | 第一步个人表单，主人权限；绑定当前服务端草稿 | 幂等创建私有 personal Ree、profile 和系统介绍，返回 `{id}` 并保存 personalReeId；事务内检查资料处理费用 |
| 草稿及 `PATCH /api/rees/[id]` | 扩展 personalProfile；发布时按步骤完整校验，主人权限 | 更新既有 personal Ree；最终发布清除向导草稿；保留 `POST /api/rees` 的通用创建合同 |
| `PATCH /api/rees/[id]/knowledge/[kid]` | `publicApproved: boolean`，主人权限 | 更新确认、revision 和索引；同时补齐批量启停、删除、恢复、刷新路径 |
| `POST /api/public/rees/[slug]/sessions` | 空体，签发或检查 guest cookie | `{sessionId, expiresAt}`；设 Cache-Control: no-store；限流 |
| `POST /api/public/rees/[slug]/sessions/[sid]/messages` | `{clientRequestId, question, sampleQuestionId?}` | 新请求返回 AI SDK UI stream；重复终态返回 JSON 原结果，客户端同时支持两种 Content-Type |
| `GET /api/public/rees/[slug]/sessions/[sid]` | 同一 cookie、未过期、主页仍公开 | 返回该会话可见请求及状态；过滤撤回资料和失效 revision；no-store |
| `DELETE /api/public/rees/[slug]/sessions/[sid]` | 同一 cookie | 关闭会话、终止活动请求并释放费用、清除内容；返回 204 |
| `POST /api/public/rees/[slug]/events` | `{clientEventId, eventType, targetId?, source?}` | 只允许白名单事件；服务端解析合法目标，去重、限流；返回 204 |
| `GET /api/rees/[id]/personal-statistics` | 主人、时间范围最长 90 天 | 返回统计、预算、成本可用性及质量指标，不返回对话正文 |
| `POST /api/rees/[id]/personal-test-session` | 主人权限 | 签发绑定主人登录态的 isTest 会话；访客不能通过请求字段伪造测试身份 |
| `GET /api/cron/expire-guest-requests` | 现有 CRON_SECRET 保护；在 `vercel.json` 注册为每分钟 | 回收超时请求、按保留期清理内容和 `ree_guest_rate` 旧行，报告处理数量 |

流式结果复用现有 text、citation、outcome 部件，新增 guest request id 和状态信息；不返回主人余额。页面刷新只读取已落库结果，不自动重跑请求。流中断时客户端以 2 秒间隔 GET 会话查询该 request 的状态，直到终态或 120 秒总时限；这些 GET 不计尝试限额（第 6 节）。失败后主动重试使用新的 clientRequestId。

错误沿用 `{error: code}`，需要重试时附 retryAfterSeconds：400 无效请求体；422 字段不合法；403 Origin 或 cookie 不合法；404 主页或会话不可用；409 重复运行或同 key 不同问题；410 会话已过期；429 限流；503 问答关闭、预算或余额不足、更新中及暂时服务错误。访客预算与余额不足统一用 `guest_unavailable`，管理端保留详细原因。

会话和事件接口不能用 Cookie 以外的客户端字段决定付费人或身份。联系链接直接使用经过校验的静态 href，点击统计异步尽力发送，统计失败不阻止外跳，也不增加开放重定向接口。

主人测试会话由专用创建接口签发，随后读写还必须验证主人登录态；不能仅凭 guest cookie 访问私人草稿。所有访客会话与主人管理 API 响应均设 no-store。未公开草稿的预览和管理使用主人鉴权页面，不复用公开页的未授权查询。

## 10 统计和归因

事件类型限定为 page_view、question_started、answer_succeeded、answer_no_answer、answer_failed、work_click、contact_click、share_copy。问答结果事件由服务端在结算事务中写入，前端不能伪造；点击事件由前端发出，只代表行为信号。

page_view 按 visitorKey、Ree、30 分钟窗口去重；问答按 requestId 去重；其他事件按 visitorKey、Ree、clientEventId 去重并限流。主动对抗脚本可以伪造访客行为，因此访问量不是审计或财务依据。主人登录访问、主人测试和管理员预览标记 isTest，不进入增长数据。

source 只接受 direct、website、social、email、community、other 枚举，可由分享参数映射；不保存完整 referrer、搜索词或任意 UTM 文本。来自匿名浏览器的 UV 只代表 cookie 标识数量，不等于真实人数。

主人后台首版展示：

- 访问浏览器数、发起提问的浏览器数、提问转化率；分母为零显示无数据。
- 完整回答、无法回答、失败次数和比例，固定示例问题的点击分布。
- 作品点击和联系点击的浏览器数，以及其占访问浏览器数的比例。
- 当月预算上限、已消费、冻结、剩余预算和主人账户可用余额，分别展示。
- 分享来源分布。联系点击明确标注“意向信号，不代表已形成合作”。

实际合作询问和是否成交由试点访谈记录，首版不开发归因或 CRM。主人连续保留主页、更新资料及愿意付费，比访客日活更适合判断这个场景是否成立。

## 11 开发任务和依赖

| 阶段 | 交付 | 完成条件 |
| --- | --- | --- |
| A 数据和规则 | mode、personal profile、审批字段、访客表；字段校验和纯规则 | 旧数据均为 general；旧创建、查询费及账单仍符合原规则 |
| B 创建和静态主页 | personal 四步创建、作品、联系、公开介绍、预览、分享卡片 | 手机上可完成创建，分享链接能直接看作品和联系本人；问答开关保持关闭 |
| C 公开资料过滤 | 检索、发现、向量、建议问题及引用撤回 | 未确认、撤回和新版本资料不会从任意个人 Ree 对外入口泄露 |
| D 访客费用和会话 | cookie 权限、幂等、限流、预算、租约、成本关联、清理任务 | 并发不超支、不重复扣费；无答案及失败不扣主人积分；清理后无悬挂冻结 |
| E 页面内问答和统计 | 流式问答、历史恢复、测试身份、事件、管理统计 | 完成从外链访问到联系的移动端路径；试问排除在增长数据外 |
| E2 管理后台、配置和法务 | `platform_setting` 及后台开关页、允许名单、每日成本上限；admin Ree 列表和详情的 mode、下架、访客请求和成本筛选；隐私政策和服务条款更新（访客 cookie、visitorKey 和 IP HMAC 保留期、AI 回答声明）；`vercel.json` 注册回收任务 | 不重新部署即可关闭访客问答；管理员能按 Ree 看到访客请求和真实成本；法务页面中英文同步 |
| F 小范围试点 | 灰度允许名单、10 个主页、访谈记录 | 达到技术验收后逐步开启，按第 13 节记录实际数据 |

B、C 完成后可用于静态展示；正式让公众提问必须等 D、E、E2 及全部 P0 验收通过。每阶段建立独立可审查的改动，不将界面上线和结算修复拆成无法安全运行的中间状态。

建议新增 `lib/domain/personal.ts`、`lib/services/personal-profiles.ts`、`lib/services/guest-sessions.ts`、`lib/services/guest-answer.ts`、`lib/services/guest-statistics.ts`、`lib/services/platform-settings.ts`、`components/personal/` 及 `i18n/pages/personal.ts`。从 `answer.ts` 抽取共用的检索与生成核心；登录问答和访客问答分别保留准入、存储及结算适配，避免把不同身份逻辑堆入旧 API。

## 12 验收和测试

### 12.1 P0 必须通过

1. 原有 general Ree 创建、单 Ree 试问、多 Ree 对话、查询费收入和账单回归通过。已有用户不自动开启主人付费。
2. personal 主人能完成创建、添加作品和公开资料、试问、确认预算及分享；返回、刷新和恢复草稿不重复创建；发布前即可试问，外部访客不能读取私人草稿，未准备好的资料不会开启问答。
3. 未登录访客在手机上打开主页即可提问、追问及点击联系，不经过充值和加入工作区。
4. 新上传或刷新后的资料默认未确认公开；访客问答、主人试问、建议问题、向量及引用均无法访问未确认资料。覆盖 profile.ts 的原生 SQL。personal Ree 不出现在发现页、搜索、推荐和相关 Ree 中，也不能加入多 Ree 对话或打开单 Ree 试问对话。
5. 问题运行期间撤回资料或主页下架，成功结算被拒绝，冻结释放，历史接口不再返回旧正文或片段。
6. 使用不同 cookie 请求同一 session、替换 slug、伪造 ownerId/isTest、跨站提交、访问删除或过期会话均被拒绝。
7. 两次并发发送相同幂等 key 只运行一次；相同 key 不同问题返回 409；刷新和重放不重复扣费。
8. 同一主人余额跨多个 Ree 并发、同一 Ree 剩余一次预算时并发、跨月完成及运行期间调低预算，都不产生负余额、负 reserved 或超额准入。访客提问与主人资料刷新并发不死锁。
9. 无证据、拒答、供应商失败、超时和进程中断可释放冻结；租约回收后晚到工作不能结算；客户端断开后完整生成仍只正常结算一次。
10. 访客回答不向主人增加收入；账单可追到请求；试问扣主人积分但排除访客预算和增长统计。
11. 伪造成功事件不进入统计；重复事件、主人访问和预览不会抬高试点数字；联系点击与实际商机明确区分。
12. 清除会话及保留期清理会删除正文和引用，保留必要账务；访客无权读取别人会话，主人统计接口不返回聊天全文。
13. 恶意文本和链接不执行脚本；仅允许合法联系协议；引用不暴露 Blob 地址及下载凭证。
14. 后台关闭 `personal_guest_enabled` 后，无需重新部署，新的访客提问在数秒内被拒绝；清空草稿不删除已创建的个人 Ree。

### 12.2 验证方式

字段校验、预算月份和状态转换使用单元测试；身份隔离、公开过滤、并发扣费、幂等和租约恢复使用现有数据库集成测试及 fake model。冻结后进程终止、供应商延迟和重复结算必须有故障注入用例。

实施后执行 `npm run typecheck` 和 `./scripts/test-integration.sh`。使用本地假模型人工检查桌面和移动端的创建、匿名试问、断网重连、来源撤回、限额耗尽和联系外跳。费用验收核对积分流水、guest usage、request 和供应商成本日志四方关联，不只验证页面数字。

## 13 首批用户和推广执行

### 13.1 招募和资料准备

先整理 40 至 50 位候选人，记录职业、作品链接、是否接业务、已有展示渠道、联系状态及实际反馈。优先从熟人和现有用户介绍获得前 3 位，再从个人网站、技术博客、小红书、即刻及相关社群邀请同行。

邀请时说明：帮助搭建一个可提问的个人主页；本人决定资料和公开内容；先审核再发布；提供明确的试用问答预算。试点默认免费体验 30 天，补贴额度以实际发放积分为准，不承诺无限量或自动续补。联系和发布案例需本人同意，不提前抓取候选人的资料代建公开页。

每位主人完成一次 20 至 30 分钟资料访谈，提供至少两个代表项目、本人贡献、服务范围和有效联系方式。验收时试问三类问题：相关项目经历、工作方式、如何合作。

### 13.2 发布与反馈

主人将链接放在一个已有真实访问的渠道，例如个人网站、作品集、邮件签名或社交简介。试点记录来源枚举，不要求群发推广。获得同意后制作展示案例，内容包括原展示难点、可直接提问的问题和实际体验；没有发生的合作结果不能写进推广材料。

前 30 天观察目标：10 位完成发布、5 位实际挂出链接、3 位明确愿意继续使用。它们是内部试验目标，不是增长承诺。每周记录主人是否保留链接、访客提问及联系点击、无法回答率、单个有效回答成本、失败成本和本人确认的真实合作询问。

若主人完成创建却不愿分享，优先改善主页展示和价值表达；有访问但没有提问，调整示例问题和入口；有问答但没有合作意向，检查用户选择、资料和联系路径。根据实际反馈选择下一轮人群。

## 14 灰度发布和回退

开关不放在环境变量：在 Vercel 上改环境变量要重新部署才生效，和“发现扣费异常立即关闭”的应急目标不符。新增 `platform_setting` 表存 `personal_brand_enabled`、`personal_guest_enabled`、`personal_guest_allowlist`（Ree id 列表）和 `personal_guest_daily_cost_usd`，管理员在后台配置页切换，每次写入记审计。第一项控制个人模式创建及展示，第二项与允许名单共同控制付费访客问答，默认关闭。服务端在每次请求内读取（可做数秒级进程内缓存，不跨请求长期缓存），所有相关路由统一执行检查，不能只依赖前端按钮。

先在本地及隔离测试环境完成验证；遵守根目录 AGENTS.md：**不创建或触发 Preview 部署**。生产发布沿用项目既有发布流程，本文不授权部署。

灰度顺序为：内部自有主页 → 3 位受邀主人 → 10 位试点。平台通过 `personal_guest_daily_cost_usd` 设置访客功能每日供应商成本上限，默认 USD 5；使用实际费用及有效保守估计计算，未解析成本请求超过 5 个时暂停新增问答并提示管理员检查。此限制是保护性停机线，单次请求仍可能使实际费用略超阈值；主人积分预算、尝试限流及输出上限提供额外控制。

发现扣费、数据越权或公开资料过滤异常时，先在后台关闭 `personal_guest_enabled`，保留静态主页和联系；回收活动请求冻结后核对账务。资料泄露场景同时暂停对应个人主页公开读取。迁移采用新增字段和表，回退功能开关不删除业务数据或账务，不把 personal 数据强制转换为 general。

试点结束依据主人分享、持续使用、真实合作询问和服务成本决定扩展人群、增加品牌定制或调整收费。
