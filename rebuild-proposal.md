# 推倒重来：Dot + 知识 的极简方案

- 日期：2026-10-30
- 状态：待确认；确认后取代 requirement.md / architecture.md / agent-first-proposal.md 成为唯一基线
- 一句话：**创建一个 Dot，给它一些知识，它只回答这些知识相关的问题。**

## 1. 为什么重来

现有 develop 分支：86 张表、69 个迁移、应用代码约 12.5 万行，外加 packages/ 下 13.5 万行 CLI / SDK / MCP / Verifier。功能覆盖频道与订阅、认领、Aptos 链上存证、Paddle 计费与结算、A2A 与三层 Agent Card、分享页与网站插件、管理后台、评论问答通知。这些都不在「Dot + 知识 + 问答」这条主线上，继续在上面做减法比从空壳开始更贵。

## 2. 产品只有三个概念

| 概念 | 含义 | 用户能做什么 |
| --- | --- | --- |
| Dot | 一个有名字、简介、可选人设提示词、绑定一组知识的问答体 | 创建、改名、删除、复制公开链接 |
| 知识 | 挂在某个 Dot 下的一条来源，六种：文档（PDF / Word / Markdown / TXT）、音频（MP3 / M4A / WAV，自动转写成文字）、GitHub 仓库、单个网页、整站、粘贴文本 | 添加、重新抓取、删除；看到处理状态 |
| 对话 | 用户和一个或多个 Dot 的一次问答，答案带引用（来自哪个 Dot 的哪条知识、哪一段） | 提问、追问、新开对话、把 Dot 拉进或移出对话、@ 某个 Dot 单独问、看历史 |

不做：频道、链上、A2A、Agent Card、分享页插件、评论、通知、管理后台、CLI / SDK / MCP、Notion 连接器（第二阶段再考虑）、视频。认领只保留第 2.2 节的两种：网站域名确权、私有仓库授权；不再有频道级认领、认领审核和公开目录。计费只有第 2.3 节的 credit 一种：没有 Call、没有工作空间套餐、没有发布者现金分成与结算单。

### 2.1 六种知识怎么变成可检索的文字

| 类型 | 输入 | 处理 | 现有代码 |
| --- | --- | --- | --- |
| 文档 | 浏览器直传 Vercel Blob 的 PDF / DOCX / MD / TXT | PDF 走 pdf.js，扫描件走 OCR；DOCX 用 `mammoth` 转成 Markdown；MD / TXT 直接读 | PDF、OCR、Markdown 可搬；**DOCX 新写**（约 50 行） |
| 音频 | 直传 Blob 的 MP3 / M4A / WAV，单文件上限 100 MB | 调语音转写接口（OpenAI 兼容的 `audio/transcriptions`，带时间戳），按时间段切块，引用显示「第 12:34」 | 现有只存文件不转写，**转写新写**；旧产品承诺音频不出第三方，新产品**要把音频发给转写服务**，需要你认可 |
| GitHub | 仓库 URL，公开或私有 | 读默认分支的文件树，取 Markdown、文档和源码文件，按文件切块，引用显示文件路径与行号。公开仓库匿名读，**不需要确权**；私有仓库要先绑定 GitHub 账号授权（第 2.2 节），用用户自己的 token 读 | `fetchGithubSnapshot` 可搬，加一条带用户 token 的分支 |
| 单个网页 | 一个 URL | 只抓这一页，正文转 Markdown，**不需要确权** | `web.ts`、`http.ts` 可搬 |
| 整站 | 站点根 URL 或某个路径前缀 | 按 sitemap 与站内链接抓同域名下的所有页面（上限 500 页），每页一条切块来源，引用显示页面 URL。**抓取前用户必须完成该域名的确权**（第 2.2 节） | `web.ts` 可搬，站内遍历与 sitemap 解析**新写** |
| 文本 | 直接粘贴 | 原样切块 | 无需连接器 |

### 2.2 确权与授权

| 来源 | 规则 | 怎么做 | 现有代码 |
| --- | --- | --- | --- |
| GitHub 公开仓库 | 不需要确权 | 粘贴 URL 即可 | — |
| GitHub 私有仓库 | 需要绑定授权 | 用户在设置里「连接 GitHub」，OAuth 申请仓库只读权限，token 加密存在 `github_connection`；添加私有仓库时校验该账号对仓库有读权限，抓取用该 token；解除连接后相关知识停止刷新 | `lib/application/auth/github-connection.ts`、`lib/infrastructure/identity/github.ts` 的 connect 流程可搬 |
| 单个网页 | 不需要确权 | 粘贴 URL 即可，和公开仓库一样 | — |
| 整站 | 需要用户确权 | 用户先添加域名，二选一验证：DNS TXT 记录，或在站点 `/.well-known/` 放一个验证文件；通过后域名记入 `domain_claim`，该域名下的整站抓取才可添加；一个域名确权一次，多个 Dot 共用 | `lib/infrastructure/verification/challenge.ts` 与 `claims/verify.ts` 里的 DNS / well-known 校验可搬 |

确权只证明「这个来源是你的」，不做人工审核，也不公开展示认领状态。

### 2.3 Credit 与计费

所有消耗都以 credit 计，1 credit = 0.0001 美元（10 美元 = 100,000 credits）。

**充值两种**，都经 Paddle 支付，Paddle 作为 merchant of record 开票收税，平台不碰资金：

| 方式 | 价格 | 得到 | 有效期 |
| --- | --- | --- | --- |
| Plan | 每月 10 美元，Paddle 订阅 | 每个计费周期到账 100,000 credits | **当期有效**，周期结束未用完的作废；取消后用到周期末 |
| Pack | 10 美元一次，可多买；**只有 Plan 订阅在有效期内的用户能买** | 100,000 credits | **不过期**，Plan 取消或过期后已买的 Pack 仍可用 |

扣费顺序：先扣当期 Plan 的 credits，再扣 Pack 与收入 credits（见下）。没有有效 Plan 的用户在 `/billing` 只看到订阅入口，Pack 按钮不可用；接口侧 `checkout` 收到 pack 而用户无有效订阅时拒绝。新用户注册送 2,000 credits 用来试（默认值，可改）。

**消耗三类**：

| 事项 | 收费 | 说明 |
| --- | --- | --- |
| 上传 / 处理知识 | 每 1,000 字符提取文本 1 credit；音频转写另加每分钟 100 credits | 处理前按文件大小预估并冻结，处理完按实际结算；失败全额退回；重新处理再收一次 |
| 向 Dot 提问（平台基本使用费） | 每次提问 20 credits（平台常量，随模型成本可调） | 问自己的 Dot 也收；问题未成功回答不收 |
| 向别人的 Dot 提问（Dot 主的查询费） | Dot 主在设置里定，0 到 10,000 credits / 次，默认 0 | 提问者一次支付「基本使用费 + 查询费」，查询费**全额**进 Dot 主的余额 |

Dot 主收到的查询费是「收入 credits」：不过期，可用于自己的消耗，也可以**手动提现**：

| 规则 | 内容 |
| --- | --- |
| 可提现范围 | 只有收入 credits；Plan、Pack、赠送的 credits 不能提 |
| 门槛 | 累计收入 credits 折合 **≥ 50 美元**（500,000 credits）才能发起，按 1 credit = 0.0001 美元折算 |
| 前置：KYC | **首次提现前必须通过 KYC**。走第三方托管验证（Stripe Identity 或 Persona 一类，证件 + 人脸，平台不保存证件原件），结果经 webhook 写入 `user.kyc_status`；同一步填写税务信息（W-9 / W-8BEN 类型与已提交声明）。未通过 KYC 的用户在 `/billing` 看得到收入余额，但提现按钮替换成「完成身份验证」 |
| 渠道 | **PayPal**：用户在 `/billing` 绑定 PayPal 收款邮箱，平台用 PayPal Payouts API 打款，美元结算；PayPal 邮箱须在 KYC 通过后绑定或更换，更换后 7 天内不能提现（防盗号） |
| 流程 | KYC 通过 → 用户发起 → 对应 credits 立即冻结 → 平台审核（一个极简的 `/admin/payouts` 列表页，显示 KYC 结果与税务信息状态，人工点批准或驳回）→ 批准后调 Payouts API → PayPal webhook 回报成功记为已付，失败则解冻退回 |
| 手续费 | PayPal 手续费由提现人承担，从打款金额中扣除（默认值，可改） |
| 频率 | 同一用户同时只能有一笔进行中的提现 |

有了向用户付款的环节，原来频道结算要补的业务前提就回来了：KYC 服务商的选型与合同、创作者税务信息（W-8 / W-9）、按年申报义务、对 Dot 主「出售查询服务」的合规口径。这些在第 5 步上线提现前要落实；代码先把 KYC 状态、税务信息字段和「未通过不能提现」的门禁做出来。

**公开页提问必须登录**：谁提问谁付费，匿名访客看得到 Dot 和价格，点提问时要求登录。余额不足时拒绝并引导到充值页，不透支。

### 2.4 怎么找到有我要的知识的 Dot

用户不翻目录，直接**拿问题找 Dot**。`/explore` 页只有一个输入框，输入一个问题或几个关键词：

1. **第一级，先找 Dot**：每个公开 Dot 有一份「知识画像」，是一小组向量（见下），全平台所有公开 Dot 的画像向量放在一张 `dot_profile_vector` 表里，一次 HNSW 检索取相似度最高的前 20 个 Dot。这张表的规模是 Dot 数 × 每个 Dot 十几条，一万个公开 Dot 也只有十几万条向量，毫秒级；
2. **第二级，只在这 20 个 Dot 里找段落**：按 `dot_id IN (...)` 过滤后在 chunk 表检索前 50 段，chunk 表按 `dot_id` 建分区或复合索引，命中范围只是这 20 个 Dot 的切块，与平台总量无关；
3. 按 Dot 聚合：每个 Dot 取最高相似度，乘以质量分（近 30 天答复率、点赞率、被拉进对话次数），排出前 10 个 Dot；
4. 每个结果卡片显示：Dot 名与简介、**命中的那段知识的摘录**（让用户一眼看出它是不是真知道）、知识来源列表（标题和类型，不显示正文）、每次提问价格、近 30 天答复数与点赞率；
5. 卡片上两个按钮：「问它」进入该 Dot 的公开页并把问题带过去；「拉进对话」加到当前或新建的多 Dot 对话里，可以一次勾选几个。

**知识画像怎么来**：每个 Dot 处理完一条知识后重算，最多 16 条向量：Dot 简介与标签 1 条、系统生成的示例问题 3 条、其余是该 Dot 所有 chunk 向量做 k-means 后的质心（切块少于 12 条时直接用切块本身）。质心代表「这个 Dot 大概知道哪几块」，一个 Dot 的知识无论 100 段还是 10 万段，画像都只有 16 条。画像在知识处理的最后一步算，不额外收费。

**为什么不平铺**：1536 维向量一条 6 KB，HNSW 索引要常驻内存才快。单个 Dot 一个 500 页的整站约 5 千到 1 万段；一万个公开 Dot 就是上千万段、几十 GB 索引，Neon 上放不下也不划算，而且带 `is_public` 过滤的 HNSW 在过滤选择性低时会漏召回。两级之后：第一级表小，第二级范围小，两个都和平台总量脱钩。代价是第一级可能漏掉「画像没覆盖到、但某一段恰好相关」的 Dot，用取前 20 而不是前 5 来兜，后面可以再加关键词倒排做混合召回。

这一步只做检索不生成，**不收 credits**，按 IP 和账号限频。输入框为空时页面显示近 30 天最活跃的公开 Dot 和一组分类标签（Dot 主在设置里最多选 3 个标签），作为兜底的浏览入口。

**Dot 公开页 `/d/[slug]` 承担展示**：简介、标签、知识来源列表、Dot 主、价格、统计，以及 3 个由系统在知识处理完成后自动生成的示例问题（Dot 主可改）。页面可被搜索引擎索引，这样 Google 也能把人带进来。

**对话里的兜底**：多 Dot 对话中如果所有参与者都「没有相关知识」，在那条灰色提示下面直接列出「这些公开 Dot 可能知道」的前 3 个结果，一键拉进来追问。

**质量信号的来源**：每条 Dot 回答下有「有用 / 没用」两个按钮，写入 `dot_feedback`；答复率 = 作答次数 / 被问次数。Dot 主在自己的 Dot 页能看到这些数字。

### 2.5 每个 Dot 一段视频介绍

Dot 主可以为自己的 Dot 生成一段 30 秒左右的动画介绍，用 **Remotion**（React 写动画、按帧渲染成视频）做。分两层，先轻后重：

| 层 | 做法 | 成本 |
| --- | --- | --- |
| 在线播放 | 介绍是一个 Remotion composition，用 `@remotion/player` 直接在 Dot 公开页和 `/explore` 卡片里播放，**不渲染文件**。数据实时取自 Dot：名字、简介、知识来源、示例问题、价格、统计，知识变了视频自动跟着变 | 零渲染成本，只有前端包体 |
| 导出 MP4 | Dot 主点「导出视频」，用 **Remotion Lambda** 在 AWS 上并行渲染成 1080p MP4（竖版 9:16 与横版 16:9 各一份），存到 Vercel Blob，给出下载和分享链接，用来发社交媒体 | 每次约 0.01 到 0.05 美元 Lambda 费用；Vercel Functions 装不下 Chromium 且渲染时长不可控，所以不在 Vercel 上渲染 |

**内容怎么来**：模型根据 Dot 的知识画像、示例问题和简介生成一份脚本，固定 5 个镜头：开场（名字与一句话定位）→ 它知道什么（知识来源逐条飞入）→ 你可以问它什么（3 个示例问题打字机效果）→ 一个真实问答片段（从该 Dot 历史里挑一条点赞过的，没有则用示例问题现问一次）→ 结尾（价格与「问它」二维码 / 链接）。Dot 主在生成后可以逐镜头改文字、换主题色、选 3 套模板之一，然后保存。第一版**没有配音**，只有字幕与一段内置的免版税背景音乐；配音（TTS）留到以后。

**收费**：生成或重新生成脚本按一次提问收 20 credits；导出 MP4 每次 500 credits（覆盖 Lambda 费用，默认值可改）；在线播放不收费。

**许可**：Remotion 对个人和 3 人以下公司免费，超过要买公司许可，上线前确认。

处理一律异步：添加后状态为 pending，页面轮询直到 ready 或 failed；失败显示原因并可重试。音频转写和大仓库抓取可能超过几分钟，用一个带 `maxDuration` 的后台函数处理，不引入队列服务。

## 3. 页面与接口

页面（全部在一个 Next.js App Router 应用里）：

| 路由 | 内容 |
| --- | --- |
| `/login` | Google / GitHub 登录（复用现有 OAuth 代码） |
| `/explore` | 找 Dot：一个问题输入框，返回最可能知道答案的公开 Dot 及命中摘录；空输入时显示活跃 Dot 与标签 |
| `/dots` | 我的 Dot 列表 + 新建 |
| `/dots/[id]` | 左侧知识列表与添加入口，右侧是只有这一个 Dot 的对话；设置抽屉里改名、提示词、公开开关、查询费 |
| `/dots/[id]/video` | 视频介绍：生成脚本、逐镜头编辑、选模板与主题色、在线预览（Remotion Player）、导出 MP4 与下载 |
| `/chats` | 我的对话列表 + 新建对话 |
| `/chats/[id]` | 多 Dot 对话：右侧参与者栏列出已拉进的 Dot（自己的和别人公开的都能拉），可增删；输入框支持 `@Dot名` 只问某一个；发送前显示本次要花的 credits |
| `/settings` | 连接 GitHub 账号；我的域名列表与确权向导 |
| `/billing` | 余额（分 Plan / Pack / 收入三栏）、订阅 Plan、购买 Pack、消费与收入明细；绑定 PayPal 邮箱、发起提现、提现记录 |
| `/admin/payouts` | 唯一的后台页：待审核的提现列表，批准或驳回；只对管理员账号开放 |
| `/d/[slug]` | 公开问答页：Dot 开启公开后任何人可见，显示每次提问的价格；提问需登录并用自己的 credits 付费 |

接口（只给自己的前端用，不对外宣传）：

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/dots` / `PATCH` / `DELETE /api/dots/[id]` | Dot 增删改 |
| `POST /api/dots/[id]/knowledge` | 添加知识：文件先由浏览器直传 Blob（绕开 4.5 MB 请求上限），再提交 blob 路径；GitHub / 单页 / 整站提交 URL；文本直接提交。后台异步解析、转写、切块、向量化 |
| `POST /api/dots/[id]/knowledge/[kid]/refresh` | 重新抓取或重新处理一条知识 |
| `GET` / `POST /api/auth/github/connect` | 绑定、解绑 GitHub 账号（仓库只读权限） |
| `POST /api/domains` / `POST /api/domains/[id]/verify` | 添加域名、发起并校验确权 |
| `POST /api/billing/checkout` | 创建 Paddle 结账（plan 或 pack），返回结账链接；pack 要求当前有有效 Plan 订阅 |
| `POST /api/billing/paddle` | Paddle webhook：到账发 credits、续费发当期 credits、退款与拒付冲回 |
| `POST /api/billing/kyc/start` | 创建 KYC 验证会话，返回服务商托管页链接 |
| `POST /api/billing/kyc-webhook` | KYC 服务商 webhook：写入通过 / 拒绝 |
| `PUT /api/billing/paypal` | 绑定或更换 PayPal 收款邮箱（需 KYC 已通过） |
| `POST /api/billing/payouts` | 发起提现：校验门槛、冻结 credits、建 pending 记录 |
| `POST /api/admin/payouts/[id]/approve` / `reject` | 管理员审核；批准即调 PayPal Payouts API |
| `POST /api/billing/paypal-webhook` | PayPal webhook：打款成功记已付，失败解冻 |
| `DELETE /api/dots/[id]/knowledge/[kid]` | 删除知识及其切块 |
| `GET /api/explore?q=` | 两级检索：先在 Dot 画像里取前 20 个 Dot，再在它们的切块里取前 50 段，聚合排序后返回 Dot 卡片数据；不收费，限频 |
| `POST /api/messages/[id]/feedback` | 对一条 Dot 回答点「有用 / 没用」 |
| `POST /api/dots/[id]/video/script` | 用模型生成或重新生成 5 镜头脚本，写入 `dot_video` |
| `PATCH /api/dots/[id]/video` | 保存镜头文字、模板、主题色 |
| `POST /api/dots/[id]/video/render` | 冻结 credits，调 Remotion Lambda 渲染两种比例，完成后写 Blob 地址 |
| `GET /api/dots/[id]/video/render/[renderId]` | 轮询渲染进度 |
| `POST /api/chats` / `DELETE /api/chats/[id]` | 新建、删除对话；新建时可带初始 Dot 列表 |
| `POST` / `DELETE /api/chats/[id]/dots/[dotId]` | 拉进、移出一个 Dot；只能拉自己的或公开的 |
| `POST /api/chats/[id]/messages` | 发一个问题，流式返回：每个作答 Dot 一段独立的回答流，事件带 `dot_id`；`/dots/[id]` 里的单 Dot 对话也是走这个接口，只是对话里只有一个 Dot |

## 4. 数据模型（19 张表，取代 86 张）

```
user          id, email, name, avatar, is_admin, kyc_status(none|pending|verified|rejected), kyc_provider_ref, kyc_verified_at, paypal_email, paypal_email_changed_at, tax_info jsonb, created_at
session       id, user_id, expires_at
dot           id, owner_id, name, slug, description, system_prompt, model, is_public, query_fee, tags text[], sample_questions jsonb, created_at
knowledge     id, dot_id, kind(document|audio|github|page|site|text), title, source(url、仓库或 blob 路径), status(pending|processing|ready|failed), error, created_at
chunk         id, knowledge_id, dot_id(冗余，供跨 Dot 检索按公开过滤), ordinal, content, embedding vector(1536), locator jsonb（页码 / 时间戳 / 文件路径与行号 / 标题）
conversation  id, user_id, title, created_at
conversation_dot  conversation_id, dot_id, added_at（一个对话里的参与者；Dot 转私有后自动移出，历史消息保留）
message       id, conversation_id, role(user|dot), dot_id(用户消息为空), content, citations jsonb, cost_credits, created_at
github_connection  user_id, github_login, encrypted_token, scope, connected_at
domain_claim  id, user_id, domain, method(dns_txt|well_known), challenge, status(pending|verified|failed), verified_at
credit_grant  id, user_id, source(welcome|plan|pack|earned), amount, remaining, expires_at(plan 为周期末，其余空), created_at
credit_entry  id, user_id, delta, reason(knowledge|query_base|query_fee_paid|query_fee_earned|purchase|refund|expire|payout_hold|payout_release|payout_paid), ref_id, created_at
purchase      id, user_id, kind(plan|pack), paddle_transaction_id, status, amount_minor, credits, created_at
subscription  id, user_id, paddle_subscription_id, status, current_period_start, current_period_end
payout        id, user_id, credits, amount_minor, fee_minor, paypal_email, status(pending|approved|paid|failed|rejected), paypal_batch_id, reviewed_by, created_at, paid_at
dot_feedback  message_id, user_id, vote(up|down), created_at
dot_profile_vector  id, dot_id, kind(profile|sample_question|centroid), embedding vector(1536), updated_at（只含公开 Dot，转私有时删除）
dot_video     dot_id, template, accent_color, scenes jsonb(5 个镜头的文字), music, updated_at
video_render  id, dot_id, aspect(9:16|16:9), status(queued|rendering|done|failed), lambda_render_id, blob_url, cost_credits, created_at, finished_at
```

chunk 表按 `dot_id` 做 hash 分区（或先只建 `(dot_id, embedding)` 的复合 HNSW 索引，分区留到单表过千万段再做），单 Dot 对话和第二级检索都只碰自己的那一片。

Dot 的答复率、点赞率、近 30 天被问次数不单独建表，从 message 与 dot_feedback 聚合，`/explore` 用的排序分每小时物化到 dot 表的一个 jsonb 列里。

余额 = 该用户所有 `credit_grant.remaining` 之和；`credit_entry` 是只追加的流水，用来对账和显示明细。扣费在一个事务里按顺序减 grant 的 remaining 并写 entry。

向量检索用 Neon 的 pgvector（现有库已在用 1536 维 embedding），不引入新的向量服务。

## 5. 问答逻辑

一个对话里有一个或多个 Dot，问题默认发给所有参与者，`@Dot名` 则只发给被点名的。每个 Dot 独立作答，各用各的知识和人设，互不看对方的回答，像群聊里几个人分别回复。

对每个被问到的 Dot：

1. 用户问题 → embedding → 在该 Dot 的 chunk 里取 top-k（k=8），可选按关键词混合排序；
2. 命中为空或相似度低于阈值 → 该 Dot **不作答也不收费**，界面显示「某某 Dot：没有相关知识」的灰色一行；只有一个 Dot 时则正常回复「不在我的知识范围内」；
3. 否则把命中的段落连同 Dot 的 system_prompt 和本对话里**该 Dot 自己**的历史轮次送给模型，要求回答并标注引用编号；
4. 多个 Dot 并行生成，流式返回，每条回答单独一个气泡，带 Dot 头像；前端把引用编号映射到知识标题与段落。

计费：按**实际作答**的 Dot 逐个收「基本使用费 + 该 Dot 的查询费」，用户消息发出前先冻结所有参与者的最高可能费用，作答结束按实际结算，没作答的退回。发送前输入框旁显示「最多 N credits」。对话里 Dot 的上限 5 个。

## 6. 从现有代码里保留什么

直接搬过来、尽量不改：

- 登录与 GitHub 绑定：`lib/application/auth`（含 `github-connection.ts`）、`app/api/auth/*`、`lib/infrastructure/identity/github.ts`
- 确权：`lib/infrastructure/verification/challenge.ts`，以及 `claims/verify.ts` 里 DNS TXT 与 well-known 的校验函数
- 解析：`lib/infrastructure/connectors` 里的 `pdf.ts`、`ocr.ts`、`markdown.ts`、`web.ts`、`http.ts`、`github.ts`
- 切块与向量化：`lib/application/ingestion/build-version.ts` 里的 chunk + embed 部分
- 排序：`lib/application/retrieval/rank.ts`
- 模型接入：`lib/infrastructure/ai/llm.ts`、`providers.ts`（新增一个转写 adapter）
- 支付：`lib/infrastructure/payment/paddle.ts` 的签名校验、下单与 webhook 解析（约 1k 行）；原来按 Call 和工作空间走的额度、结算、分成代码不搬，credit 账本重写
- 收款资料：`lib/application/revenue/payout-profile.ts` 里 PayPal 邮箱与税务表单类型的校验可搬；KYC 接入与 PayPal Payouts API 调用新写（旧代码里没有）
- 视频：全部新写。新增依赖 `remotion`、`@remotion/player`、`@remotion/lambda`；composition 放在 `video/` 目录，Lambda 用独立的 AWS 账号与 `REMOTION_AWS_*` 环境变量。实现时**按 Remotion 官方 Agent Skills 做**（仓库 `remotion-dev/skills`，与 Neon 的 skill 一样用 `npx skills add remotion-dev/skills` 装进 `.agents/skills/`，记入 `skills-lock.json`）：`remotion-saas` 定产品集成与 Lambda 渲染的架构，`remotion-markup` 写 composition 与动画，`remotion-render` 定导出流程，`remotion-best-practices` 作为总路由。做第 6 步的 session 先装 skill 再动手
- 基础设施：Neon + drizzle、Vercel Blob、Tailwind、现有 UI 基础组件（按钮、输入框、布局）
- 文案：保留中英双语，但 i18n 词条只保留新页面用到的

其余全部不带过去。

## 7. 怎么做

在同一个仓库开新分支 `rebuild`：新建空的 Next.js 骨架，只把第 6 节的模块复制进来，迁移从 `0001` 重新开始，Neon dev 分支重置。`develop` 与 `main` 原样保留作参考，`rebuild` 跑通后再决定替换 `main`。不在 develop 上做删除，避免 90% 的删文件 diff 淹没真正的新代码。

分六步交付：

1. **骨架与核心闭环**：登录 → 新建 Dot → 上传 PDF / Word / Markdown 或粘贴文本 → 提问得到带引用的回答。只有 `/dots` 和 `/dots/[id]` 两个页面；对话表从一开始就是多参与者结构，但界面只做单 Dot；credit 账本从这一步就有，用注册赠送的额度扣费，但还没有充值。
2. **其余知识类型**：GitHub 公开仓库、GitHub 绑定与私有仓库、单个网页、域名确权与整站抓取、音频转写（含时间戳引用）、删除与重新处理。
3. **充值**：credit 账本与扣费、Paddle 结账与 webhook（Plan 订阅、Pack 一次性、退款冲回）、`/billing` 页；在此之前只有注册赠送的 credits。
4. **公开页、发现、多 Dot 对话与收尾**：`/d/[slug]` 公开问答与示例问题、`/explore` 拿问题找 Dot、回答反馈与质量分、查询费与收入 credits、`/chats` 多 Dot 对话与 @ 点名、空状态与错误态、集成测试。
5. **提现**：KYC 接入与门禁、PayPal 绑定、提现申请与冻结、`/admin/payouts` 审核、Payouts API 与 webhook、税务信息。上线前要先落实上面列的业务前提。
6. **视频介绍**：Remotion composition 与 3 套模板、脚本生成与编辑、公开页与 explore 卡片在线播放、Remotion Lambda 导出 MP4 与计费。

每一步一个 PR 进 `rebuild` 分支。
