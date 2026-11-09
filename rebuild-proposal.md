# 推倒重来：Ree + 知识 的极简方案

- 日期：2026-10-30
- 状态：待确认；确认后取代 requirement.md / architecture.md / agent-first-proposal.md 成为唯一基线
- 一句话：**创建一个 Ree，给它一些知识，它只回答这些知识相关的问题。**

## 1. 为什么重来

现有 develop 分支：86 张表、69 个迁移、应用代码约 12.5 万行，外加 packages/ 下 13.5 万行 CLI / SDK / MCP / Verifier。功能覆盖频道与订阅、认领、Aptos 链上存证、Paddle 计费与结算、A2A 与三层 Agent Card、分享页与网站插件、管理后台、评论问答通知。这些都不在「Ree + 知识 + 问答」这条主线上，继续在上面做减法比从空壳开始更贵。

## 2. 产品只有三个概念

| 概念 | 含义 | 用户能做什么 |
| --- | --- | --- |
| Ree | 一个有名字、简介、可选人设提示词、绑定一组知识的问答体 | 创建、改名、删除、复制公开链接 |
| 知识 | 挂在某个 Ree 下的一条来源，六种：文档（PDF / Word / Markdown / TXT）、音频（MP3 / M4A / WAV，自动转写成文字）、GitHub 仓库、单个网页、整站、粘贴文本 | 添加、重新抓取、删除；看到处理状态 |
| 对话 | 用户和一个或多个 Ree 的一次问答，答案带引用（来自哪个 Ree 的哪条知识、哪一段） | 提问、追问、新开对话、把 Ree 拉进或移出对话、@ 某个 Ree 单独问、看历史 |

不做：频道、链上、A2A、Agent Card、分享页插件、评论、邮件与推送通知（只有站内通知）、CLI / SDK、公开 REST API、Notion 连接器（第二阶段再考虑）、视频类知识。管理后台保留但只有第 2.5 节的十页。认领只保留第 2.2 节的两种：网站域名确权、私有仓库授权；不再有频道级认领、认领审核和公开目录。计费只有第 2.3 节的 credit 一种：没有 Call、没有工作空间套餐、没有发布者现金分成与结算单。MCP 只做第 2.8 节的 Ree 查找与问答，用 API Key 鉴权；OAuth 连接器放到后续阶段。

### 2.1 六种知识怎么变成可检索的文字

| 类型 | 输入 | 处理 | 现有代码 |
| --- | --- | --- | --- |
| 文档 | 浏览器直传 Vercel Blob 的 PDF / DOCX / MD / TXT，单文件上限 20 MB | PDF 先在本地读文字层（`unpdf` 的 pdf.js），按字号、行距还原成每页 Markdown；有扫描页、字体加载失败或乱码时整份交给 Firecrawl Parse；DOCX 用 `mammoth` + `turndown` 在本地转成 Markdown；MD / TXT 直接读 | PDF、OCR、Markdown 可搬；**DOCX 新写**（约 50 行） |
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
| 整站 | 需要用户确权 | 用户先添加域名，二选一验证：DNS TXT 记录，或在站点 `/.well-known/` 放一个验证文件；通过后域名记入 `domain_claim`，该域名下的整站抓取才可添加；一个域名确权一次，多个 Ree 共用 | `lib/infrastructure/verification/challenge.ts` 与 `claims/verify.ts` 里的 DNS / well-known 校验可搬 |

确权只证明「这个来源是你的」，不做人工审核，也不公开展示认领状态。

### 2.3 Credit 与计费

所有消耗都以 credit 计，1 credit = 0.0001 美元（10 美元 = 100,000 credits）。

**充值两种**，都经 Paddle 支付，Paddle 作为 merchant of record 开票收税，平台不碰资金：

| 方式 | 价格 | 得到 | 有效期 |
| --- | --- | --- | --- |
| Plan | 每月 10 美元，Paddle 订阅 | 每个计费周期到账 100,000 credits | **当期有效**，周期结束未用完的作废；取消后用到周期末 |
| Pack | 10 美元一份，一次结账 1 到 10 份；**只有 Plan 订阅在有效期内的用户能买** | 每份 100,000 credits | **不过期**，Plan 取消或过期后已买的 Pack 仍可用 |

扣费顺序：当期 Plan → 注册赠送 → Pack → 收入 credits（见下），退款按相反顺序退回。没有有效 Plan 的用户在 `/billing` 只看到订阅入口，Pack 按钮不可用；接口侧 `checkout` 收到 pack 而用户无有效订阅时拒绝。新用户注册送 100,000 credits 用来试（默认值，可改）。

**消耗三类**：

| 事项 | 收费 | 说明 |
| --- | --- | --- |
| 上传 / 处理知识 | 每 1,000 字符提取文本 1 credit；音频转写另加每分钟 100 credits | 处理前按文件大小预估并冻结，处理完按实际结算；失败全额退回；重新处理再收一次 |
| 向 Ree 提问（平台基本使用费） | 每次提问 20 credits（平台常量，随模型成本可调） | 问自己的 Ree 也收；问题未成功回答不收 |
| 向别人的 Ree 提问（Ree 主的查询费） | Ree 主在设置里定，0 到 10,000 credits / 次，默认 0 | 提问者一次支付「基本使用费 + 查询费」，查询费**全额**进 Ree 主的余额 |

Ree 主收到的查询费是「收入 credits」：不过期，可用于自己的消耗，也可以**手动提现**：

| 规则 | 内容 |
| --- | --- |
| 可提现范围 | 只有收入 credits；Plan、Pack、赠送的 credits 不能提 |
| 门槛 | 累计收入 credits 折合 **≥ 50 美元**（500,000 credits）才能发起，按 1 credit = 0.0001 美元折算 |
| 前置：KYC | **首次提现前必须通过 KYC，由我们人工审核**（没有第三方验证服务商）。用户在 `/billing` 提交：法定姓名、国家、证件类型、证件照片、手持证件自拍，同一步填写税务信息（W-9 / W-8BEN 类型与已提交声明）。照片直传**私有** Blob，只有管理员能通过短时签名 URL 查看，每次查看记审计。管理员在后台「KYC 记录」页比对姓名与证件，通过或拒绝（必填原因）。通过后 30 天自动删除原图，只留证件类型、号码后四位、有效期、审核人与时间。未通过 KYC 的用户在 `/billing` 看得到收入余额，但提现按钮替换成「完成身份验证」 |
| 收款方式 | 用户填写 **PayPal 个人账户邮箱**（KYC 通过后才能填或改，改后 7 天内不能提现，防盗号）。**不接任何打款 API**：我们目前没有 PayPal Business account，Payouts API 和 Log in with PayPal 都用不了，打款由管理员在系统外操作 |
| 流程 | KYC 通过 → 用户发起 → 对应 credits 立即冻结 → 管理员在「提现审核」页批准或驳回 → 批准后管理员用 PayPal 向该邮箱转账 → 回到后台「标记已打款」，填 PayPal 转账 ID 与实付金额，冻结的 credits 记为已付；转账失败或被退回则「标记失败」，解冻退回用户 |
| 手续费 | PayPal 手续费由提现人承担：实付金额由管理员按实际填写，申请金额与实付的差额记为手续费 |
| 频率 | 同一用户同时只能有一笔进行中的提现 |
| 规模 | 人工流程只能支撑小量提现。日后拿到 Business account，把「标记已打款」换成调 Payouts API、由 webhook 写回状态即可，`payout` 表不变；接入第三方 KYC 时 `kyc_record.provider` 多一个取值，历史记录不作废 |

有了向用户付款的环节，原来频道结算要补的业务前提就回来了，而且人工 KYC 把证件数据放到了我们手上：隐私政策里要写明证件的用途、保留期与删除规则，访问要有审计；创作者税务信息（W-8 / W-9）与按年申报义务；用非 Business 账户向用户付款的资金性质与税务定性要和会计确认；对 Ree 主「出售查询服务」的合规口径。申请 PayPal Business account 这件事应尽早启动，它是从人工打款切到自动打款的唯一前提。这些在第 5 步上线提现前要落实；代码先把 KYC 状态、税务信息字段和「未通过不能提现」的门禁做出来。

**提问只在对话里发生，且必须登录**：公开页和 explore 卡片只展示 Ree 与价格，唯一动作是「加入对话」，匿名访客点它时要求登录。谁提问谁付费；余额不足时拒绝并引导到充值页，不透支。

### 2.4 怎么找到有我要的知识的 Ree

用户不翻目录，直接**拿问题找 Ree**。`/explore` 页只有一个输入框，输入一个问题或几个关键词：

1. **第一级，先找 Ree**：每个公开 Ree 有一份「知识画像」，是一小组向量（见下），全平台所有公开 Ree 的画像向量放在一张 `ree_profile_vector` 表里，一次 HNSW 检索取相似度最高的前 20 个 Ree。这张表的规模是 Ree 数 × 每个 Ree 十几条，一万个公开 Ree 也只有十几万条向量，毫秒级；
2. **第二级，只在这 20 个 Ree 里找段落**：按 `ree_id IN (...)` 过滤后在 chunk 表检索前 50 段，chunk 表按 `ree_id` 建分区或复合索引，命中范围只是这 20 个 Ree 的切块，与平台总量无关；
3. 按 Ree 聚合：每个 Ree 取最高相似度，乘以质量分（近 30 天答复率、点赞率、被拉进对话次数），排出前 10 个 Ree；
4. 每个结果卡片显示：Ree 名与简介、Ree 主的角色标识（认证 / 官方，见 2.7 节）、**命中的那段知识的摘录**（让用户一眼看出它是不是真知道）、知识来源列表（标题和类型，不显示正文）、每次提问价格、近 30 天答复数与点赞率；相关性相同的结果，官方、认证的 Ree 排在普通的前面，角色不改变相关性本身的排序；
5. 卡片本身就是入口：点封面或名字进入该 Ree 的公开页，问题随 `from` 参数带过去，公开页上「加入对话」把它加进当前或新建的对话。卡片上不放输入框和按钮。

**知识画像怎么来**：每个 Ree 处理完一条知识后重算，最多 16 条向量：Ree 简介与标签 1 条、系统生成的示例问题 3 条、其余是该 Ree 所有 chunk 向量做 k-means 后的质心（切块少于 12 条时直接用切块本身）。质心代表「这个 Ree 大概知道哪几块」，一个 Ree 的知识无论 100 段还是 10 万段，画像都只有 16 条。画像在知识处理的最后一步算，不额外收费。

**为什么不平铺**：1536 维向量一条 6 KB，HNSW 索引要常驻内存才快。单个 Ree 一个 500 页的整站约 5 千到 1 万段；一万个公开 Ree 就是上千万段、几十 GB 索引，Neon 上放不下也不划算，而且带 `is_public` 过滤的 HNSW 在过滤选择性低时会漏召回。两级之后：第一级表小，第二级范围小，两个都和平台总量脱钩。代价是第一级可能漏掉「画像没覆盖到、但某一段恰好相关」的 Ree，用取前 20 而不是前 5 来兜，后面可以再加关键词倒排做混合召回。

这一步只做检索不生成，**不收 credits**，按 IP 和账号限频。输入框为空时页面显示近 30 天最活跃的公开 Ree 和一组分类标签（Ree 主在设置里最多选 3 个标签），作为兜底的浏览入口。

**Ree 公开页 `/r/[slug]` 只做展示**：头像、简介、主分类与标签、知识来源**数量**（不列标题）、Ree 主与角色标识、价格拆分、累计回答与好评率、视频介绍，以及最多 3 个示例问题（Ree 主自己写；为空时系统在首条知识就绪后生成 3 条建议，Ree 主确认后展示）。页面没有输入框，唯一动作是「加入对话」。底部列「相关 Rees」与「作者的其他 Rees」，相关度只用公开的名称、简介、标签与分类算。页面可被搜索引擎索引，这样 Google 也能把人带进来。

**对话里的兜底**：多 Ree 对话中如果所有参与者都「没有相关知识」，在那条灰色提示下面直接列出「这些公开 Ree 可能知道」的前 3 个结果，一键拉进来追问。

**质量信号的来源**：每条 Ree 回答下有「有用 / 没用」两个按钮，写入 `ree_feedback`；答复率 = 作答次数 / 被问次数。Ree 主在自己的 Ree 页能看到这些数字。

### 2.5 管理后台

独立入口 `/admin`，和用户登录完全分开：管理员用密码加 TOTP 登录（旧后台的这套直接搬），空安装时第一个访问 `/admin/login` 的人注册为管理员，之后只能由已有管理员添加。十个页面：

| 页面 | 内容 |
| --- | --- |
| 概览 | 用户数、Ree 数、知识条数、近 30 天提问数与收入 credits、各模型本月调用次数与估算成本 |
| **模型** | 三类模型各一张卡：**生成**、**向量化**、**转写**。每类可以配多条（接入方式：AI Gateway 或 OpenAI 兼容端点；base URL；模型名；API key 加密存储、只显示尾号；超时），每类**有且只有一条启用**，有「测试连通」按钮真发一次请求。生成模型与转写模型随时可切，下一次请求即生效。**向量化模型切换要走重算**：切换时后台创建一个「全量重向量化」任务，按知识逐条重算并显示进度，完成前新旧两套向量并存、检索仍用旧的，完成后一次切换；任务跑着时不能再切 |
| 用户 | 列表与搜索，可按角色筛选；停用 / 恢复；**设为官方 / 取消官方**、**撤销认证**（必填原因，写审计）；用户详情页汇总该用户的一切：角色与角色变更历史、余额（Plan / Pack / 收入三栏）、credit 流水、**KYC 记录**、充值记录、订阅状态、提现记录、认证申请、名下 Ree；**手动调整 credits**（赠送或扣回，必填原因） |
| **认证申请** | 待审核的认证申请队列：申请人、申请时间、申请陈述与链接、系统自动算出的门槛指标（公开 Ree 数、知识条数、被提问次数、好评率、注册天数，达标项打勾）、名下公开 Ree 列表直达；批准（用户角色变为认证）或拒绝（必填原因，用户可见）。已处理的可按状态筛选查看 |
| **KYC 记录** | 全部 KYC 提交的列表：状态（待审核 / 通过 / 拒绝 / 已重置）、法定姓名、国家、证件类型、提交时间、审核人与时间、拒绝原因、税务表单类型与提交声明；可按状态筛选。待审核的进审核视图：通过短时签名 URL 查看证件照与自拍（每次查看写审计），对照用户填写的姓名，通过或拒绝（必填原因）。可对任何记录「要求重新验证」（新增一条待提交记录并通知用户）。通过 30 天后原图自动删除，页面显示「原图已删除」 |
| **充值记录** | Plan 与 Pack 的所有交易：用户、类型、金额、credits、Paddle 交易号、状态（已付 / 退款 / 拒付）、时间；订阅视图列出每个 Plan 的当前周期、续费与取消；可导出 CSV；退款在 Paddle 后台操作，这里只读并显示 webhook 冲回结果 |
| **提现记录** | 所有提现的完整列表（不只待处理）：用户、申请金额、实付金额、手续费、PayPal 邮箱、状态、审核人、打款人、PayPal 转账 ID、时间；按状态与时间筛选；可导出 CSV |
| Rees | 列表与搜索；把公开 Ree 下架（转私有并通知 Ree 主）或恢复 |
| 提现审核 | 第 2.3 节的处理页：只看待审核与待打款的。待审核：显示该用户的 KYC 结果与税务信息状态，批准或驳回；待打款：显示收款邮箱与金额，管理员在 PayPal 转账后点「标记已打款」填转账 ID 与实付金额，或「标记失败」解冻退回。处理完进入「提现记录」 |
| 审计 | 管理员所有操作的只读流水：谁、何时、改了什么 |

没有后台配置的套餐价格、credit 单价、Plan / Pack 规则：这些是代码常量，改了走发布。模型没在后台配置时回退到环境变量，保证第一次部署能跑。

### 2.6 每个 Ree 一段视频介绍

Ree 主可以为自己的 Ree 生成一段**固定 15 秒**的动画介绍，用 **Remotion**（React 写动画、按帧渲染成视频）做。分两层，先轻后重：

| 层 | 做法 | 成本 |
| --- | --- | --- |
| 在线播放 | 介绍是一个 Remotion composition，用 `@remotion/player` 直接在 Ree 公开页和 `/explore` 卡片里播放，**不渲染文件**。数据实时取自 Ree：名字、简介、知识来源、示例问题、价格、统计，知识变了视频自动跟着变 | 零渲染成本，只有前端包体 |
| 导出 MP4 | Ree 主点「导出视频」，**在 Ree 主自己的浏览器里渲染**：Remotion 官方的 `@remotion/web-renderer`，`renderMediaOnWeb()` 用 WebCodecs 把同一个 composition 编码成 H.264 MP4，拿到 Blob 后直传 Vercel Blob，再给出下载和分享链接。导出前先调 `canRenderMediaOnWeb()` 探测，不支持的浏览器（主要是旧版或手机浏览器）显示「请用桌面 Chrome 或 Edge 导出」。**不用 Remotion Lambda，不用任何 Remotion 托管服务，也不在服务端跑 Chromium** | 零服务器成本；一段 15 秒 720p 视频在桌面 Chrome 里约 10 到 30 秒；导出期间标签页需保持打开 |
| 分享链接 | 不导出也能分享：公开页链接本身就是视频页，Open Graph 预览图由 `next/og` 按 Ree 实时生成 | 零 |

**规格与缓存**：720p、24 fps、**固定 15 秒（360 帧）**，第一版不让用户改时长；只渲染用户点选的那个比例（竖版 9:16 或横版 16:9），不是两份都出；渲染结果按「Ree 内容版本 + 模板 + 比例」缓存在 Blob，知识和脚本没变就直接给已有文件，不重渲。

**内容怎么来**：模型根据 Ree 的知识画像、示例问题和简介生成一份脚本，固定 4 个镜头、每个镜头定长，合计 15 秒。看的人只需要知道三件事：它是谁、它懂什么、它真的能答。

| 镜头 | 时长 | 内容 | 文字上限（脚本生成器与编辑器都强制） |
| --- | --- | --- | --- |
| 1 开场 | 3 秒 | 名字与一句话定位 | 名字 ≤ 20 字，定位 ≤ 24 字 |
| 2 它知道什么 | 4 秒 | 知识来源逐条飞入，最多 4 条，多于 4 条显示「等 N 项」 | 每条标题 ≤ 20 字 |
| 3 一个真实问答 | 5 秒 | 从该 Ree 历史里挑一条点赞过的，没有则用示例问题现问一次；答案取第一句 | 问题 ≤ 30 字，答案 ≤ 50 字 |
| 4 结尾 | 3 秒 | 价格与「问它」二维码 / 链接 | 一句号召 ≤ 16 字 |

镜头之间转场各 0.4 秒，已含在时长里。中英文按字符数计，超出的由生成器重写而不是截断。示例问题仍在公开页展示，只是不进视频。Ree 主在生成后可以逐镜头改文字、换主题色、选 3 套模板之一，然后保存。第一版**没有配音**，只有字幕与一段内置的免版税背景音乐；配音（TTS）留到以后。

**收费**：生成或重新生成脚本按一次提问收 20 credits；导出 MP4 **每个 Ree 第一次免费**，之后每次 50 credits（平台只付 Blob 存储与流量，象征性收费，默认值可改）；命中缓存直接取已有文件的不算一次、不收费；在线播放与分享链接不收费。

**许可**：Remotion 对个人和 3 人以下公司免费，超过要买公司许可，上线前确认；浏览器端渲染要在 `renderMediaOnWeb()` 里传 `licenseKey`（符合免费条件传 `'free-license'`，否则传 remotion.pro 的公钥）。

处理一律异步：添加后状态为 pending，页面轮询直到 ready 或 failed；失败显示原因并可重试。音频转写和大仓库抓取可能超过几分钟，用一个带 `maxDuration` 的后台函数处理，不引入队列服务。

### 2.7 用户角色

每个用户有一个角色，三选一，默认普通：

| 角色 | 是谁 | 怎么获得 | 怎么失去 |
| --- | --- | --- | --- |
| 普通 | 所有用户的默认角色 | 注册即是 | 无 |
| 认证 | 经平台认证的优质用户 | 用户在 `/settings` 自己申请，达到门槛后才能提交，管理员在后台「认证申请」页批准或拒绝 | 管理员在后台撤销（必填原因），回到普通 |
| 官方 | 平台自己创建的用户，用来挂平台自营的 Ree | 不能申请，只能由管理员在后台「用户」页直接赋予 | 管理员取消 |

**认证门槛**（代码常量，不在后台配）：注册满 14 天；至少 1 个公开 Ree，其知识处理完成的条数合计 ≥ 5；名下公开 Ree 累计被他人提问 ≥ 100 次；有反馈的回答里「有用」占比 ≥ 80%。未达标时 `/settings` 的申请按钮灰掉并逐项显示差多少。申请时填一段陈述（≤ 500 字）和最多 3 个外部链接（个人主页、GitHub、文章等）。同一用户只能有一笔进行中的申请；被拒后 30 天内不能再申请。

**角色带来什么**：公开页 `/r/[slug]`、explore 结果卡片、对话参与者栏、回答的署名处显示「认证」或「官方」标识；explore 相关性同分时优先。角色不改变计费、credits、查询费和提现规则。官方用户不用走 KYC 门槛也不能提现（平台自己的钱不需要提给自己），它的收入 credits 只在后台统计里看。

角色与 Ree 无关：Ree 没有自己的认证状态，它的标识来自 Ree 主当时的角色；Ree 主被撤销认证，名下所有 Ree 的标识即时消失。

### 2.8 MCP 接入（第一阶段：API Key）

对外只开放一个远程 MCP 服务器 `/api/mcp`（Streamable HTTP，`mcp-handler` 2.x），不做公开 REST API。接入说明见 `docs/mcp.md`。

**鉴权**：用户在 `/settings?tab=api` 创建 API Key（名称、可选有效期 30 / 90 / 365 天或永不过期，每个账号最多 10 个有效 Key）。Key 形如 `re0_sk_` + 64 位十六进制，只在创建时显示一次；库里只存 SHA-256 摘要和末四位。客户端用 `Authorization: Bearer` 发送。已吊销、已过期的 Key 和已停用账号的任何 Key 一律 401。这条路径不读 cookie、不发 CORS 头，带其他来源 `Origin` 的浏览器请求直接 403。管理员可在后台用户详情的「API Key」页强制吊销，写审计（`user.api_key.revoke`）。

**四个工具**，别的都不开放：

| 工具 | 作用 | 计费 |
| --- | --- | --- |
| `search_rees {query, limit?}` | 用 explore 的两级检索找公开 Ree，返回卡片数据与命中段落 | 免费，沿用 explore 的按 IP / 账号限频 |
| `get_ree {ree}` | 按 id 或 slug 取一个公开 Ree 或自己的 Ree：简介、知识是否就绪、对你的单次价格、知识概况（按类型计数与示例问题；自己的 Ree 另给来源标题） | 免费 |
| `list_my_rees` | 自己名下的 Ree，私有的也在 | 免费 |
| `ask_ree {ree, question, conversation_id?, max_cost?}` | 提问，返回回答、引用、实际费用和 `conversation_id`（用于追问） | 与网页完全一致：冻结基础费 + 查询费，回答后按 20 + 查询费结算，查询费记入 Ree 主的收入 credits；未回答全额解冻 |

余额不足、或 `max_cost` 低于可能的费用时，工具返回明确的错误（附充值地址 `/settings?tab=balance`），不保存问题、不冻结、不扣费。工具描述写明提问会花 credits；返回内容是 JSON 数据，并注明 Ree 的内容是第三方数据、不是给模型的指令。

**对话与用量**：MCP 的提问存在 `conversation.kind = mcp` 的对话里（一个对话只对一个 Ree），不出现在网页的对话列表和接口里。每个问题记下发起它的 `api_key_id`，设置页按 Key 显示提问次数与花费。工具调用按 Key（每分钟 30 次）和按账号（每分钟 60 次）限频，用 `rate_bucket`。

**后续阶段**：OAuth 2.1（claude.ai、ChatGPT 网页版的连接器需要），届时 `/api/mcp` 增加受保护资源元数据，API Key 保留给命令行与本地客户端。

## 3. 页面与接口

页面（全部在一个 Next.js App Router 应用里）：

| 路由 | 内容 |
| --- | --- |
| `/`、`/pricing`、`/checkout`、`/legal/*` | 官网：首页、价格与消耗估算、Plan / Pack 结账页（Pack 1–10 份）、条款与隐私 |
| `/login` | Google / GitHub 登录（复用现有 OAuth 代码），登录后回到原页面 |
| `/dashboard` | 工作台：我的 Ree、知识、累计回答、收入四张指标卡，来源健康、回答排名、待处理事项、提现引导 |
| `/explore` | 找 Ree：问题输入框 + 7 个主分类 + 排序，16:9 封面卡片，24 / 48 / 96 分页；空输入时显示活跃 Ree |
| `/r/[slug]` | Ree 公开页：只展示，「加入对话」是唯一动作；相关 Rees 与作者的其他 Rees |
| `/rees` | 我的 Ree：卡片 / 列表、搜索、公开 / 私有筛选、排序、批量公开 / 私有、12 / 24 / 48 分页 |
| `/rees/new` | 四步创建向导，草稿可退出续做 |
| `/rees/[id]/settings` | Ree 设置：基本资料（头像、配色、名称、简介）、知识与个性（主分类、标签、人设提示词、示例问题）、发布与定价（公开、查询费）；删除 Ree |
| `/rees/[id]/knowledge`、`/rees/[id]/knowledge/[kid]` | 知识管理：文件夹、状态 tab、搜索、类型筛选、排序、批量、参与回答开关、回收站；独立预览页 |
| `/rees/[id]/chat` | 单 Ree 测试对话 |
| `/rees/[id]/statistics` | 使用统计：全部 / 日 / 周 / 月 / 自定义，趋势与明细 |
| `/rees/[id]/video` | 视频介绍：脚本、镜头编辑、模板与主题色、Player 预览、浏览器导出、分享 |
| `/videos` | 我的 Ree 视频列表 |
| `/talk` | 新建对话草稿页：选参与者、示例问题、费用预估，首次发送才建记录 |
| `/chats` | 搜索对话：全文搜索、Ree / 时间 / 排序筛选、最近 / 置顶 / 归档 / 回收站、批量 |
| `/chats/[id]` | 多 Ree 对话：提问对象选择器、管理参与者（≤ 5）、`@` 点名、每个 Ree 独立气泡并行流式、引用抽屉、反馈 |
| `/workspace/sources`、`/workspace/answers` | 跨 Ree 的来源明细与累计回答明细 |
| `/settings?tab=account|role|connections|billing|api` | 资料与头像、登录信息、语言；角色与申请认证；GitHub 连接、域名确权向导；余额、Plan / Pack、流水、订阅、收款与提现；站内通知；API Key 与 MCP 接入说明（第 2.8 节） |
| `/settings/identity` | KYC 资料提交与只读查看 |
| `/billing` | 302 到 `/settings?tab=billing` |
| `/admin/*` | 管理后台十页（第 2.5 节）及其详情页；独立的管理员登录 |

接口（只给自己的前端用，不对外宣传）：

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/rees` / `PATCH` / `DELETE /api/rees/[id]` | Ree 增删改 |
| `POST /api/rees/[id]/knowledge` | 添加知识：文件先由浏览器直传 Blob（绕开 4.5 MB 请求上限），再提交 blob 路径；GitHub / 单页 / 整站提交 URL；文本直接提交。后台异步解析、转写、切块、向量化 |
| `POST /api/rees/[id]/knowledge/[kid]/refresh` | 重新抓取或重新处理一条知识 |
| `GET` / `POST /api/auth/github/connect` | 绑定、解绑 GitHub 账号（仓库只读权限） |
| `POST /api/domains` / `POST /api/domains/[id]/verify` | 添加域名、发起并校验确权 |
| `POST /api/billing/checkout` | 创建 Paddle 结账（plan 或 pack），返回结账链接；pack 要求当前有有效 Plan 订阅 |
| `POST /api/billing/paddle` | Paddle webhook：到账发 credits、续费发当期 credits、退款与拒付冲回 |
| `POST /api/billing/kyc` | 提交 KYC 资料：证件照与自拍先直传私有 Blob，再提交姓名、国家、证件类型、文件引用与税务表单声明，建一条待审核记录 |
| `PUT /api/billing/paypal` | 填写或更换 PayPal 收款邮箱（需 KYC 已通过） |
| `POST /api/billing/payouts` | 发起提现：校验门槛、冻结 credits、建 pending 记录 |
| `POST /api/admin/payouts/[id]/approve` / `reject` | 管理员审核：批准进入待打款，驳回解冻 |
| `POST /api/admin/payouts/[id]/paid` / `failed` | 标记已打款（PayPal 转账 ID、实付金额）或标记失败（解冻退回） |
| `POST /api/admin/auth/login` | 管理员登录：密码 + TOTP |
| `GET` / `PUT /api/admin/models` | 读取与修改三类模型配置；`POST /api/admin/models/[id]/probe` 测试连通 |
| `POST /api/admin/models/reembed` | 切换向量化模型：创建全量重算任务；`GET` 看进度 |
| `POST /api/admin/users/[id]/credits` | 手动调整 credits，带原因 |
| `PUT /api/admin/users/[id]/role` | 设为官方、取消官方、撤销认证，带原因，写审计 |
| `GET /api/account/verification` / `POST` | 读取自己的门槛达成情况与申请状态；提交认证申请（服务端复核门槛） |
| `GET /api/admin/verifications` | 认证申请列表，支持按状态筛选 |
| `POST /api/admin/verifications/[id]/approve` / `reject` | 批准（用户角色变为认证）或拒绝（必填原因） |
| `POST /api/admin/rees/[id]/takedown` / `restore` | 下架 / 恢复公开 Ree |
| `GET /api/admin/kyc` | KYC 记录列表，支持按状态筛选 |
| `GET /api/admin/kyc/[id]/files` | 返回证件照与自拍的短时签名 URL，每次调用写审计 |
| `POST /api/admin/kyc/[id]/approve` / `reject` / `reset` | 人工审核通过、拒绝（必填原因）、要求重新验证 |
| `GET /api/admin/purchases` / `GET /api/admin/subscriptions` | 充值与订阅记录，支持 `?format=csv` |
| `GET /api/admin/payouts` | 全部提现记录，支持筛选与 `?format=csv` |
| `DELETE /api/rees/[id]/knowledge/[kid]` | 移到回收站（软删，30 天后定时清除切块与文件）；`POST .../restore` 恢复 |
| `POST /api/rees/[id]/knowledge/batch` | 批量：move / reprocess / pause / resume / trash / restore |
| `GET` / `POST /api/rees/[id]/folders`、`PATCH` / `DELETE /api/rees/[id]/folders/[fid]` | 知识文件夹 |
| `GET /api/rees/[id]/statistics`、`GET /api/workspace/sources`、`GET /api/workspace/answers` | 用户侧统计与明细，参数 `period`、`date`、`start`、`end`、`view`、`q`、`size`、`page` |
| `GET` / `PATCH /api/account`、`GET /api/account/notices` | 资料与头像；站内通知 |
| `GET /api/chats`、`PATCH /api/chats/[id]`、`POST /api/chats/batch` | 对话搜索列表；重命名 / 置顶 / 归档 / 回收站；批量 |
| `GET /api/admin/*?format=csv` | 六个后台列表导出全部筛选结果 |
| `GET /api/explore?q=` | 两级检索：先在 Ree 画像里取前 20 个 Ree，再在它们的切块里取前 50 段，聚合排序后返回 Ree 卡片数据；不收费，限频 |
| `POST /api/messages/[id]/feedback` | 对一条 Ree 回答点「有用 / 没用」 |
| `POST /api/rees/[id]/video/script` | 用模型生成或重新生成 4 镜头脚本，写入 `ree_video` |
| `PATCH /api/rees/[id]/video` | 保存镜头文字、模板、主题色 |
| `POST /api/rees/[id]/video/exports` | 导出开始：该 Ree 若还没有一条 `done` 的导出记录则免费，否则校验并冻结 50 credits；返回 Blob 直传令牌与一条 `video_export` 记录；若同版本同比例已有文件则直接返回其地址、不扣费也不占用首次免费 |
| `POST /api/rees/[id]/video/exports/[exportId]/complete` | 浏览器渲染并上传完成后回报 Blob 地址，结算 credits；浏览器中途关闭的记录由定时任务清理并解冻 |
| `POST /api/chats` / `DELETE /api/chats/[id]` | 新建、删除对话；新建时可带初始 Ree 列表 |
| `POST` / `DELETE /api/chats/[id]/rees/[reeId]` | 拉进、移出一个 Ree；只能拉自己的或公开的 |
| `POST /api/chats/[id]/messages` | 发一个问题，流式返回：每个作答 Ree 一段独立的回答流，事件带 `ree_id`；`/rees/[id]` 里的单 Ree 对话也是走这个接口，只是对话里只有一个 Ree |
| `GET` / `POST /api/account/api-keys`、`DELETE /api/account/api-keys/[id]` | 自己的 API Key：列表（含用量）、创建（完整 Key 只在这次响应里）、吊销 |
| `DELETE /api/admin/users/[id]/api-keys/[keyId]` | 管理员强制吊销用户的 API Key，写审计 |

对外的只有一个：`POST /api/mcp`，MCP 服务器（第 2.8 节），`Authorization: Bearer re0_sk_…`。

## 4. 数据模型（29 张表，取代 86 张）

```
user          id, email, name, avatar_blob, lang(zh|en), provider(google|github), provider_handle, last_login_at, role(normal|verified|official), role_changed_at, disabled_at, paypal_email, paypal_email_changed_at, ree_draft jsonb(创建向导草稿), created_at
session       id, user_id, expires_at
ree           id, owner_id, name, slug, description, avatar_blob, color(default|lilac|sand|sage|rose|slate), category(technology|design|business|learning|professional|life|other), tags text[](≤3), system_prompt(≤4000), sample_questions jsonb(≤3), is_public, query_fee, moderated_at, moderated_by, moderated_reason, rank jsonb(每小时物化的排序分), deleted_at, created_at, updated_at
knowledge     id, ree_id, folder_id, kind(document|audio|github|page|site|text), title, original_title, source(url、仓库或 blob 路径), file_name, file_size, status(pending|processing|ready|failed), error, enabled(参与回答), content(解析正文), children jsonb(整站子页面 / 仓库文件目录), activity jsonb(处理记录), consent_at(音频转写同意), deleted_at, created_at, updated_at
knowledge_folder  id, ree_id, name(≤40，同 Ree 内唯一), created_at
chunk         id, knowledge_id, ree_id(冗余，供跨 Ree 检索按公开过滤), ordinal, content, embedding vector(1536), locator jsonb（页码 / 时间戳 / 文件路径与行号 / 标题）
conversation  id, user_id, kind(normal|ree_test|mcp), ree_id(ree_test 时为该 Ree), title, pinned, archived_at, deleted_at, created_at, updated_at
conversation_ree  conversation_id, ree_id, added_at（一个对话里的参与者；Ree 转私有后自动移出，历史消息保留）
message       id, conversation_id, role(user|ree), ree_id(用户消息为空), content, citations jsonb(每条：knowledge_id、title、kind、locator、excerpt 快照), no_answer, no_answer_reason(no_sources|out_of_scope), request_id, cost_credits, api_key_id(经 MCP 提的问题：发起的 Key), created_at
github_connection  user_id, github_login, encrypted_token, scope, connected_at
domain_claim  id, user_id, domain, method(dns_txt|well_known), challenge, status(pending|verified|failed), verified_at
credit_grant  id, user_id, source(welcome|plan|pack|earned), amount, remaining, expires_at(plan 为周期末，其余空), created_at
credit_entry  id, user_id, delta, reason(knowledge_hold|knowledge_settle|knowledge_refund|query_base|query_fee_paid|query_fee_earned|purchase|refund|expire|payout_hold|payout_release|payout_paid|video_script|video_export|admin_adjust), ref_id, ree_id, note, created_at
credit_hold   id, user_id, kind(chat|knowledge|video|payout), amount, allocations jsonb(从哪些 grant 各冻了多少), status(held|settled|released), ref_id, created_at, closed_at
purchase      id, user_id, kind(plan|pack), quantity, paddle_transaction_id, status(paid|refunded|chargeback), amount_minor, credits, created_at
subscription  id, user_id, paddle_subscription_id, status(active|cancelled|expired), cancel_at_period_end, current_period_start, current_period_end
payout        id, user_id, credits, amount_minor, paid_amount_minor, fee_minor, paypal_email, status(pending|approved|paid|failed|rejected), paypal_transaction_id, reviewed_by, reviewed_at, paid_by, paid_at, failed_by, failed_at, note, created_at（人工打款：approved 后由管理员标记 paid / failed；日后接 Payouts API 时同一张表由 webhook 写）
ree_feedback  message_id, user_id, vote(up|down), created_at
ree_profile_vector  id, ree_id, kind(profile|sample_question|centroid), embedding vector(1536), updated_at（只含公开 Ree，转私有时删除）
ree_video     ree_id, generated, revision, template(editorial|blueprint|spotlight), accent_color, aspect(16:9|9:16), music, scenes jsonb(4 个镜头的文字), exports_count(首次免费判定), updated_at
video_export  id, ree_id, content_version, template, aspect(9:16|16:9), status(started|done|abandoned), blob_url, cost_credits, created_at, finished_at
kyc_record    id, user_id, provider(manual，留枚举给日后的第三方), status(pending|verified|rejected|reset), legal_name, country, document_kind(passport|id|residence), document_last4, document_expires_on, document_blob, selfie_blob, files_deleted_at, rejected_reason, tax_form_kind(W-8BEN|W-9), tax_form_declared_at, consent_at, submitted_at, decided_by, decided_at（一个用户可有多条，最新一条为当前状态；重新验证即新增一条；document_blob / selfie_blob 指向私有 Blob，通过 30 天后删除并记 files_deleted_at）
administrator  id, name, email, role(owner|administrator), password_hash, totp_secret_cipher, disabled_at, created_by, created_at
admin_session  id, administrator_id, expires_at
model_config  id, name, kind(generation|embedding|transcription), transport(gateway|openai_compatible), base_url, model, api_key_cipher, api_key_tail, timeout_ms, enabled, last_probe_at, last_probe_ok, updated_by, updated_at
reembed_job   id, from_model_config_id, to_model_config_id, status(running|done|failed), total, done, started_at, finished_at
verification_request  id, user_id, statement(≤500), links text[](≤3), metrics jsonb(提交时的门槛指标快照), status(pending|approved|rejected|closed), rejected_reason, closed_by_role_change, reviewed_by, created_at, decided_at（同一用户同时只有一条 pending；角色变更历史从这张表和 admin_audit 里查）
notice        id, user_id, kind(takedown|restore|credits_adjust|kyc|payout|role|verification), text, ref_id, read_at, created_at
admin_audit   id, administrator_id, action, target, before jsonb, after jsonb, created_at
api_key       id, user_id, name(≤60), key_digest(SHA-256，唯一), key_tail(末四位), last_used_at, expires_at(可空), revoked_at, created_at（MCP 鉴权，第 2.8 节；只吊销不删除）
```

chunk 表按 `ree_id` 做 hash 分区（或先只建 `(ree_id, embedding)` 的复合 HNSW 索引，分区留到单表过千万段再做），单 Ree 对话和第二级检索都只碰自己的那一片。

Ree 的答复率、点赞率、近 30 天被问次数不单独建表，从 message 与 ree_feedback 聚合，`/explore` 用的排序分每小时物化到 ree 表的一个 jsonb 列里。

余额 = 该用户所有 `credit_grant.remaining` 之和；`credit_entry` 是只追加的流水，用来对账和显示明细。扣费在一个事务里按顺序减 grant 的 remaining 并写 entry。

向量检索用 Neon 的 pgvector（现有库已在用 1536 维 embedding），不引入新的向量服务。

## 5. 问答逻辑

一个对话里有一个或多个 Ree，问题默认发给所有参与者；输入框旁可以选「只问这个 Ree」（不移出其他参与者，只影响这一问），`@Ree名` 优先级更高、只发给被点名的；`@` 了不存在的名字不发送。每个 Ree 独立作答，各用各的知识和人设，互不看对方的回答，像群聊里几个人分别回复。

对每个被问到的 Ree：

1. 用户问题 → embedding → 在该 Ree 的 chunk 里取 top-k（k=8），可选按关键词混合排序；
2. 命中为空或相似度低于阈值 → 该 Ree **不作答也不收费**，界面显示「某某 Ree：没有相关知识」的灰色一行；只有一个 Ree 时则正常回复「不在我的知识范围内」；
3. 否则把命中的段落连同 Ree 的 system_prompt 和本对话里**该 Ree 自己**的历史轮次送给模型，要求回答并标注引用编号；
4. 多个 Ree 并行生成，流式返回，每条回答单独一个气泡，带 Ree 头像；前端把引用编号映射到知识标题与段落。

计费：按**实际作答**的 Ree 逐个收「基本使用费 + 该 Ree 的查询费」，用户消息发出前先冻结所有参与者的最高可能费用，作答结束按实际结算，没作答的退回。发送前输入框旁显示「最多 N credits」。对话里 Ree 的上限 5 个。

## 6. 从现有代码里保留什么

直接搬过来、尽量不改：

- 登录与 GitHub 绑定：`lib/application/auth`（含 `github-connection.ts`）、`app/api/auth/*`、`lib/infrastructure/identity/github.ts`
- 管理后台：`lib/application/administration` 里的 `sign-in-admin.ts`（密码 + TOTP）、`resolve-admin-session.ts`、`password.ts`、`manage-administrators.ts`、`manage-llm-config.ts` 与 `probe-llm-config.ts`（API key 加密、连通性探测）、`audit.ts`、`payouts.ts`，约 2k 行；用户与 Ree 管理、重算任务新写
- 确权：`lib/infrastructure/verification/challenge.ts`，以及 `claims/verify.ts` 里 DNS TXT 与 well-known 的校验函数
- 解析：`lib/infrastructure/connectors` 里的 `pdf.ts`、`ocr.ts`、`markdown.ts`、`web.ts`、`http.ts`、`github.ts`
- 切块与向量化：`lib/application/ingestion/build-version.ts` 里的 chunk + embed 部分
- 排序：`lib/application/retrieval/rank.ts`
- 模型接入：`lib/infrastructure/ai/llm.ts`、`providers.ts`（新增一个转写 adapter）
- 支付：`lib/infrastructure/payment/paddle.ts` 的签名校验、下单与 webhook 解析（约 1k 行）；原来按 Call 和工作空间走的额度、结算、分成代码不搬，credit 账本重写
- 收款资料：`lib/application/revenue/payout-profile.ts` 里 PayPal 邮箱与税务表单类型的校验可搬；人工 KYC 的提交、私有文件签名 URL 与到期删除、提现的人工打款标记新写（旧代码里没有）；**不接 PayPal 的任何 API**
- 视频：全部新写。新增依赖 `remotion`、`@remotion/player`、`@remotion/web-renderer`，**不引入 `@remotion/renderer`、`@remotion/lambda` 或 `@remotion/vercel`，服务端没有任何渲染进程**；composition 放在 `video/` 目录，被 Player 与 web-renderer 共用。实现时按 Remotion 官方 Agent Skills 做（仓库 `remotion-dev/skills`，与 Neon 的 skill 一样用 `npx skills add remotion-dev/skills` 装进 `.agents/skills/`，记入 `skills-lock.json`）：`remotion-markup` 写 composition 与动画，`remotion-render` 里关于客户端渲染的部分定导出流程，`remotion-best-practices` 作为总路由。做第 6 步的 session 先装 skill 再动手。若日后要给不支持 WebCodecs 的浏览器兜底，再加一条 satori + resvg + ffmpeg 的幻灯片式服务端导出，不回到 Chromium
- 基础设施：Neon + drizzle、Vercel Blob、Tailwind、现有 UI 基础组件（按钮、输入框、布局）
- 文案：保留中英双语，但 i18n 词条只保留新页面用到的

其余全部不带过去。

## 7. AI 调用框架

全部模型调用走 **Vercel AI SDK 7**（仓库里已是 `ai` 7.0.x），不引入 LangChain、LlamaIndex 或任何单家厂商的 SDK。理由：Next.js 原生、流式和前端 hook 一体、一套接口换任何模型、本仓库已有经验。各处用到的能力：

| 用途 | AI SDK 能力 | 说明 |
| --- | --- | --- |
| 问答生成 | `streamText` + `createUIMessageStream` | 多 Ree 对话里每个 Ree 一条独立的流，用自定义 data part 带 `ree_id` 与引用，合并进同一个 UI 消息流 |
| 前端对话 | `@ai-sdk/react` 的 `useChat` | 直接消费上面的消息流，按 `ree_id` 分气泡 |
| 向量化 | `embedMany` | 切块与问题都用它，1536 维；画像质心在数据库侧算 |
| 音频转写 | `transcribe`（7.0 起稳定） | 带时间戳的转写结果，按时间段切块 |
| 结构化输出 | `generateObject` / `Output.object` + zod | 视频脚本（4 镜头、字数上限）、示例问题、Ree 简介建议 |
| 问答流水线 | 普通函数：检索 → 过滤 → 生成 | **第一版不用 `ToolLoopAgent`**，问答是固定两步，不需要模型自己规划；等有「跨 Ree 追问」这类需求再引入 |

**模型从哪里来**：通过 **Vercel AI Gateway**，模型用 `"provider/model"` 字符串指定，一个 key 用所有厂商，带回退、限额与用量统计；同时保留 `@ai-sdk/openai-compatible`，环境变量 `LLM_BASE_URL` / `LLM_API_KEY` 一配就能指向任何 OpenAI 兼容端点（自建或别家），两种方式由一个 `modelFor(kind)` 函数统一返回，业务代码不感知。模型配置存在 `model_config` 表，**在管理后台的「模型」页修改**（第 2.5 节），`modelFor(kind)` 读启用的那条并缓存 60 秒；表里没有配置时回退到环境变量（`GENERATION_MODEL`、`EMBEDDING_MODEL`、`TRANSCRIPTION_MODEL` 与对应的 key），保证首次部署能跑。切换向量化模型必须经后台的全量重算任务，不能直接改。

**计费对接**：`streamText` 的 `usage` 只进日志和成本看板，不进用户账单；用户按第 2.3 节的固定 credits 收费，与 token 无关。

## 8. 怎么做

在同一个仓库开新分支 `rebuild`：新建空的 Next.js 骨架，只把第 6 节的模块复制进来，迁移从 `0001` 重新开始，Neon dev 分支重置。`develop` 与 `main` 原样保留作参考，`rebuild` 跑通后再决定替换 `main`。不在 develop 上做删除，避免 90% 的删文件 diff 淹没真正的新代码。

### 8.1 原型是什么、怎么用

`rebuild-prototype/` 是一个纯浏览器原型（哈希路由、localStorage、所有外部服务都是模拟），覆盖官网、用户工作台、管理后台三块。它的角色是**交互规格**：

- **页面结构、文案、字段上限、状态与空态、URL 参数、键盘与手机行为**，全按原型做。本节下面的每一步都按原型的路由列页面，实现时打开对应路由对照。
- **后端规则**（检索、计费与结算、确权、存储、权限）按本方案第 2 到 7 节；原型里模拟出来的数字和流程只在两者一致时才算规格，不一致处见 8.2 的取舍表。
- 原型 `tests/*.test.mjs` 是行为说明书，一个文件对应一块功能的断言。每一步实现完，把对应测试文件里的断言改写成这边的集成测试或 Playwright 用例，不是照抄代码，是照抄「应该发生什么」。
- 原型的样式文件（`styles.css`、`suite.css`、`knowledge.css`、`conversations.css`、`navigation.css`）是视觉参考：配色（电光蓝、海军蓝、纸白、浅薰衣草）、间距、固定顶栏与可折叠侧栏的布局规则照搬，用 Tailwind 重做，不引入原型的 CSS 文件。
- 原型里的「规模演示」（600 个我的 Ree、1,000 条 explore、六个后台列表各千余条）是在说**每个列表都要服务端分页**：列表接口统一接受 `q`、`status`、`sort`、`size`（20 / 50 / 100，我的 Ree 为 12 / 24 / 48，explore 为 24 / 48 / 96）、`page`，返回 `total`；筛选条件写进 URL，刷新与前进后退可恢复，越界页码归位。
- 原型为了兼容旧数据保留的 `/dots`、`/d/:slug`、`dot:` 存储键，**不带过去**。
- 原型 README 的「原型边界」一节列了所有模拟项（认证、AI、DNS、支付、KYC、PayPal、视频导出），这些正是本方案各步要真做的部分。

### 8.2 原型与方案不一致处的取舍

| 事项 | 原型 | 方案此前 | 定稿 |
| --- | --- | --- | --- |
| 路由命名 | `/dots`、`/d/:slug`、`/settings?tab=billing` | `/rees`、`/r/[slug]`、`/billing` | Ree 用 `/rees`、`/r/[slug]`；计费并入 `/settings?tab=billing`，`/billing` 302 过去；KYC 资料页独立为 `/settings/identity` |
| Ree 设置 | 独立设置页，Ree 内页五个 tab：设置、知识管理、视频介绍、使用统计、对话 | `/rees/[id]` 里一个抽屉 | 原型 |
| 创建 Ree | 四步向导（基本资料 → 知识与个性 → 添加知识 → 发布与确认），草稿可退出续做，最终确认才创建 | 一个表单 | 原型；草稿存服务端 `ree_draft` 列（user 表一列 jsonb），换设备也能续 |
| Ree 字段 | 头像（裁 512×512）、六色配色、7 个主分类、≤ 3 标签、人设提示词 ≤ 4,000、名称 ≤ 40、简介 ≤ 240、示例问题 ≤ 3 条各 ≤ 160 | 名称、简介、提示词、≤ 3 标签 | 原型；头像存 Blob 不存 data URL |
| 示例问题 | Ree 主自己写 | 知识处理完成后系统生成 3 条 | 合并：Ree 主可写；为空时在首条知识就绪后系统生成 3 条建议，Ree 主确认后才展示 |
| 公开页提问 | 公开页只展示，唯一动作「加入对话」（选已有对话或新建）；explore 卡片点进详情，没有「问它 / 拉进对话」按钮 | 公开页内提问、需登录 | 原型：提问统一在对话里。公开页与 explore 卡片都不带输入框，`/r/[slug]` 不再是问答页 |
| explore 排序 | 无问题时整表按角色优先 | 角色只在同分时优先 | 方案：无问题时按近 30 天活跃排序，角色只作同分优先；有问题时按 2.4 节两级检索 |
| explore 匹配 | 关键词打分，「命中摘录」是首条来源前 103 字 | 两级向量检索，摘录是真命中的段落 | 方案 |
| 知识删除 | 回收站，可恢复，没有永久删除 | `DELETE` 硬删 | 原型 + 回收站里的知识 30 天后由定时任务连同切块一起清除 |
| 知识处理费 | 固定预估直接扣，不结算：文档 / 单页 20、GitHub 120、整站 500、音频 300、文本每千字 1 | 预估冻结、按实结算（每千字 1，音频另加每分钟 100） | 方案；原型的数字改作**冻结上限**：文档 / 单页冻 20、GitHub 冻 120、整站冻 500、音频按文件大小估时长（每 MB 约 1 分钟）冻结，处理完按实结算、多退少不补 |
| 重新处理 | 固定 20 | 再收一次 | 方案 |
| 扣费顺序 | Plan → 赠送 → Pack → 收入 | Plan → Pack 与收入 | 原型 |
| Pack 数量 | 一次结账 1 到 10 份 | 单份 | 原型 |
| 引用 | 每条回答 1 条，带标题 / 定位 / 摘录快照 | 多条编号引用 | 方案的多条编号 + 原型的快照：`message.citations` 每条存知识 id、标题、定位、摘录，知识被删后仍能展示 |
| 多 Ree 回答 | 顺序逐个 | 并行流式 | 方案 |
| 单 Ree 无答 | 一张卡片，区分「知识未就绪」与「超出知识范围」，注明未收费 | 一句文字回复 | 原型 |
| 提问对象 | 输入框旁选「全部 Ree」或「只问这个 Ree」（不移出参与者），显式 `@` 优先；`@` 了不存在的名字不发送 | 只有 `@` | 原型 |
| 对话列表 | 独立搜索页：标题 / 正文 / Ree 全文搜索与高亮、Ree / 时间 / 排序筛选、置顶、归档、回收站、批量、重命名 ≤ 120 | 一个列表 | 原型；回收站 30 天后清除 |
| 通知 | 站内通知：下架、credits 调整、审核结果、角色变更 | 不做通知 | 原型，只做站内（设置页一个列表 + 侧栏小红点），不发邮件 |
| 设为官方的限制 | 有进行中提现时不可；自动关闭该用户待审的认证申请 | 无 | 原型 |
| KYC 表单 | 用户填证件后四位与有效期；图片各 ≤ 10 MB；两个勾选（已提交税表、同意用途与保留期） | 只列字段 | 原型；后台通过时要勾「已比对」且证件未过期 |
| 提现金额 | 用户选 ≥ 500,000 的整数，默认全额 | 全额 | 原型 |
| 视频 | 音乐开关、脚本 JSON 下载、`/videos` 列表、`?video=1` 自动播放、全屏；超限文字直接报错 | 无 | 原型；超限文字：生成器重写、编辑器报错 |
| 后台 Rees 列表 | 只有示例数据 | 真 Ree | 方案 |
| 后台初始化 | `/admin/setup` 不可达 | 空安装时首个访问 `/admin/login` 的人注册 | 方案 |
| 后台 CSV | 六个列表都能导出全部筛选结果：UTF-8 BOM、CRLF、全字段加引号、以 `= + - @` 开头的单元格前置 `'` | 两个列表 | 原型 |
| 后台 Ree 详情 | 四 tab（概览、知识来源、使用统计、管理记录）+ 来源只读预览 + 上一条 / 下一条 | 无 | 原型 |
| 后台财务图表 | 充值 / 提现页按日 / 周 / 月 / 自定义的金额与笔数图 | 无 | 原型（§8.5 验收时补上）；状态名沿用后台列表的「已打款 / 打款失败」；充值金额按 `amount_minor` 直接相加，不做币种换算（目前只有 USD） |
| Ree 删除 | 软删，历史对话仍能显示名字 | 删除 | 原型 |
| 用户侧统计 | `/dashboard`、`/rees/[id]/statistics`、`/workspace/sources`、`/workspace/answers`，UTC+8，日 / 周 / 月 / 自定义 | 无 | 原型 |
| 审计动作码 | 写入与筛选用的两套不一致 | 未定 | 统一一份枚举（8.3 节），写入与筛选共用 |
| 视频脚本镜头数 | 4 | 接口表写了 5 | 4 |
| 旧兼容入口与演示数据 | `#/workspace`、`#/welcome` 进工作台；`?sample=scale` 规模演示；「测试 Ree / 测试对话」标记与说明；URL 参数 `dot=` | 未提 | 同 8.1 不带过去：只保留 `/workspace` → `/dashboard`（它的子页是明细页）；`/welcome`、`sample=scale`、测试标记都不做；URL 参数一律 `ree=`（`/chats`、`/workspace/*`） |
| 登录回跳参数 | `?next=` | 未定 | `?returnTo=`，沿用旧 auth 模块；白名单（`lib/domain/auth.ts`）覆盖全部工作台入口与官网可回跳页 |
| 官网「创建你的 Ree」 | 去 `/dots`（未登录先登录） | 未定 | 直接去 `/rees/new` 向导，按钮说的就是创建 |
| 首页问答示例 | 静态窗口，按钮弹出「示例回答」，引用弹窗 | 可交互问答示例 | 页内脚本演示三问（带页码引用、带代码行号、超出范围不收费），不调模型、不弹窗 |
| 首页示例 Ree 与 15 秒位 | 前 3 个公开 Ree，每张卡一个 15s 按钮 | 15 秒介绍位 | 近 30 天最活跃的 3 个公开 Ree + 独立 16:9 介绍位（播放其中有视频的第一个）；没有公开 Ree 时 3 张不可点的示例卡 |
| 公开页的来源信息 | FAQ 与隐私写「展示知识来源标题」 | 2.4：只给数量 | 方案：公开页、卡片、FAQ、条款都只说来源数量，不露标题 |
| 结账确认 | 勾「我了解这是模拟购买」，模拟提交与到账 | Paddle | 勾选同意条款与隐私，并写明 Plan 自动续费、Pack 不过期不可提现；真实 Paddle 状态：加载、关闭后重新打开、到账轮询、支付不可用 |
| 法律页 | 设计评审用的占位说明 | 条款与隐私 | 完整文本（目录、更新日期、以中文为准）；隐私另承诺未通过或被要求重新验证的 KYC 原图在结论后 30 天内删除（上线前仍需法务审阅） |
| 价格页估算 | 一句「100 次成功回答消耗 2,000 credits」 | 消耗估算滑块 | 同原型，另加一行「约占 Plan 当期额度的 N%」 |
| explore 带问题时 | 全目录打分后分页 | 2.4 两级检索 | 最多 10 个结果，24 / 48 / 96 只在浏览时起作用，「回答最多 / 查询费最低」在这 10 个里重排；免费搜索按分钟限流，超限退回浏览并提示 |
| explore 卡片视频 | 封面只进详情，静态「含视频介绍」标记 | 卡片播放弹窗 | 封面进详情，封面上单独的「视频介绍」按钮开播放弹窗；弹窗与 `?video=1` 静音自动播放，声音按钮加音乐 |
| 卡片与公开页的数字 | 全部回答与评价；自己的 Ree 只显示基本费 | 未定 | 只算他人的提问与投票，Ree 主测试自己的不计；公开价对所有人都按基本费 + 查询费 |
| 公开页「加入对话」与下方列表 | 弹层列全部可加入对话；列表页码在内存里 | 未定 | 列最近 20 个可加入的对话；访客点「加入对话」登录后回到 `?join=1` 自动打开；两组列表页码写进 URL（`rp` / `ap`）；「相关 Rees」候选只取同分类或有共同标签的公开 Ree（≤ 300 个）再按原型相似度排 |
| 视频编辑器门禁 | 无就绪知识时点生成才提示；默认草稿可直接改；非 Ree 主跳回 `/dots` | 未定 | 无就绪知识时生成按钮禁用并引导添加；生成脚本前只能改样式（模板、颜色、比例、音乐），镜头文字、脚本 JSON 与分享在有脚本后开放；有未保存修改时不能导出（导出用已保存内容）；非 Ree 主 404 |
| 视频导出 | 无 VideoEncoder 时提示 | 第 7 步验收 | Safari 与手机按 UA 直接拒绝，其余走 `canRenderMediaOnWeb()`；缓存键是画面内容 + 模板 + 比例 + 合成版本，不含 revision；取消或离开页面立即解冻，cron 30 分钟兜底；导出的 MP4 以不可猜的 URL 公开，便于分享 |
| 脚本 JSON | `dot` 字段，来源是换行拼接的字符串 | 未定 | `ree` 字段，来源是数组，每个镜头带起点与时长 |
| `/videos` | 卡片列表 | 未定 | 服务端分页 12 / 24 / 48 + 搜索 + 播放弹窗；侧栏没有入口，从「我的 Ree」的「视频工作室」进入，侧栏保持「我的 Ree」高亮 |
| 视频第 3 镜头与超限 | 示例问答 | 取被点赞的历史回答 | 只取 Ree 主在自己对话里点赞的回答（不在公开视频里露他人问题）；没有则用首条示例问题问一次，再不行由模型据知识写；生成器超限字段最多重写两轮，仍超限则失败并退 20 credits，从不截断 |
| 对话搜索 | 关键词 `maxlength` 4000；只搜当前参与者 | 未定 | 关键词 ≤ 200；搜索与 Ree 筛选也覆盖回答过但已移出的 Ree |
| 侧栏历史 | 全部置顶与最近 | 未定 | 全部置顶 + 最近 200 条 |
| 对话内页补充 | 参与者只在输入框选择器管理；回答中禁用输入框；402 按全部目标估；无答建议取前 3 个公开 Ree | 未定 | 顶栏第二行参与者栏（带角色标识）；回答中可继续输入但不能发送；402 的「最多需要」只算有就绪知识、真会冻结的 Ree；「这些公开 Ree 可能知道」用 explore 的检索；引用抽屉对 Ree 主多一个「打开来源」；参与者选择器按搜索取前 30 个 |
| `/talk` 示例问题 | 两条固定示例 | 未定 | 取所选 Ree 的示例问题，不足时补两条通用问题，最多 4 条 |
| 知识管理补充 | 状态计数只按文件夹；「选择全部」不限 | 未定 | 状态计数随搜索、类型、文件夹变化；跨页全选上限 5,000（`KNOWLEDGE_BATCH_MAX`），超出显示「选择前 N 个」；预览详情多文件大小与添加时间、无「定位」行；PDF 与音频的原文件 tab 由私有存储按需读取 |
| GitHub 与网站来源 | 「这是私有仓库」勾选 | 只读授权 | 服务端判断是否私有（先匿名读，失败再用连接）；只读要 GitHub App，未配置时退回 `repo` scope；重新处理再次核对访问权；整站抓取 150 秒预算；抓到的页面标题替换 URL 标题（Ree 主改过名的除外） |
| 向导首份文件 | 刷新后需重新选文件 | 未定 | 选中即直传 Blob，路径存进草稿，刷新不丢 |
| 音频冻结与切片 | 固定冻结 300 | 每分钟 100 | 冻结 = 每 MB 约 1 分钟 ×（100 + 约 1,000 字的千字费）；按开始的分钟与千字计价；超过 24 MB 的 MP3 / WAV 按帧切片并发转写，M4A 整段送；音频段落最长 120 秒 |
| 域名验证 | 待验证 / 已验证两态；只有已验证的可删 | 未定 | 多「未通过」与「最近检查」，可继续验证；两种方式任一通过即验证，并覆盖子域名；未验证的也可删除 |
| 账户头像 | 弹窗拖动裁剪，「保存头像」即时生效 | 未定 | 与 Ree 头像共用内嵌裁剪：拖动（含触屏）与方向键调整位置、滑块缩放、「重置位置」；随「保存资料」一起保存，不单独即时生效 |
| 余额与计费页 | 流水前 12 条、三列；「取消自动续费」 | 未定 | 流水服务端分页 20 / 50 / 100，多「来自」列（每笔对到 grant）；有负债时显示「待抵扣 N」；续费弹窗「关闭自动续费 / 保持订阅」并写明周期结束日 |
| 收款卡 | 用户侧无提现进度 | 未定 | 有进行中提现时显示三步进度；被要求重新验证时说明原因并暂停提现；历史行带申请时间与驳回 / 失败原因 |
| 通知入口 | （行 19） | （行 19） | 设置页第五个 tab `?tab=notices`；有未读时侧栏账户行带红点并直达该 tab |
| 角色申请补充 | 「设为官方」关闭的申请记为 rejected；历史只有「审核说明」 | 未定 | 状态 `closed`（因设为官方而关闭），不进 30 天冷却；陈述与审核原因 1–500 字（调整 credits、下架仍 3–300）；历史显示拒绝原因与链接 |
| 工作台布局 | 主列：我的 Ree、来源状态、回答排名；侧列：待处理、收入 | 未定 | 第一行我的 Ree + 待处理，第二行来源状态、回答排名、收入；已下架的待处理项去 Ree 设置页（公开状态在那里） |
| 个人空间明细 | 来源 4 列；回答汇总链到 Ree 设置 | 未定 | 来源多「更新时间」列；回答汇总链到该 Ree 的使用统计 |
| 后台管理员 | 弹层填姓名邮箱即添加；密码 ≥ 8 | 已有管理员添加 | 不发邮件：添加后得到 7 天一次性邀请链接，受邀人在 `/admin/login?invite=…` 设密码与 TOTP；不能停用自己或所有者；密码 ≥ 12（2.5 沿用旧后台） |
| 模型配置补充 | 超时 5–600 秒 | 未定 | 名称 ≤ 50、模型 ≤ 120 按原型；超时 5–300 秒（Vercel 函数上限）；Key 留空复用同端点已存的 Key 或环境变量；首条向量化配置在尚未建索引时可直接启用；每次调用记 `model_call` 供概览算成本 |
| 后台用户补充 | KYC 筛选含「处理中」；会员无「未订阅」 | 未定 | 人工 KYC 没有「处理中」，状态为待审 / 通过 / 拒绝 / 待重新验证，「未提交」只在用户列表筛；会员筛选加「未订阅」；详情多「赠送」「待还」余额卡；Plan 桶调整需有效 Plan |
| KYC 重新验证与清理 | 任一已处理记录可「要求重新验证」 | 通过后 30 天删原图 | 只对最新的通过或拒绝记录；重新验证期间进行中的提现不能批准或打款；拒绝与重置的原图也在 30 天后删除；提交前上传的孤儿文件 24 小时后清除 |
| 提现审核补充 | 无 | 未定 | 申请时快照 PayPal 地址，之后改地址不改去向、审核页提示；同一转账 ID 只能登记一次；手续费以 credits 记（申请 − 实付 × 100） |
| 充值记录详情 | 只读字段 | 未定 | 只读详情多该笔的账本行、负债与每条 Paddle 通知原文；`purchase` 只在到账后写，没有 pending |
| 计费表与退款 | 未定 | 4 节的表 | 加 `billing_event`（按 event id 去重）、`credit_debt`（退款不足记负债，新到账先还债）、`paddle_checkout`（1 小时内复用未完成的 Plan 结账）；退款先收回该笔购买的 grant 再按扣费顺序；Paddle `past_due` / `paused` 视为 expired |
| 无答判定 | 关键词打分 | 相似度阈值 | 阈值（含关键词覆盖兜底）之外，模型可回 `[[NO_ANSWER]]`，同样走无答卡片并退款；提问时先去掉 `@名字` 再检索 |
| 定时任务频率 | 未定 | 8.3 | Plan 作废每日一次（以续费 webhook 为准）；向量重算每 10 分钟兜底；中断导出每 15 分钟；排序分每小时 |
| 其他小差异 | 后台与工作台各自记折叠状态；后台来源预览默认显示第一个子页面 / 文件；「知识管理」tab 的数量是独立徽标 | 未定 | 后台与工作台共用一个折叠状态（同一个 cookie）；后台来源预览未选子项时显示全文，选中后只显示该段；数量直接写在 tab 文字后（「知识管理 12」）；模型超时下限 5 秒对已有配置在下次编辑时才校验；后台 Ree 详情与充值的 tab 放在顶栏第二行（原型是第一行里的小胶囊），手机上更宽松 |

第 33 行起是合并后按 8.5 做原型对照时补记的取舍（逐路由结果见 `docs/acceptance/prototype-parity.md`），其中一部分是各步 PR 与交接文档里已经做出、此前没进本表的决定。

### 8.3 工程约定

- **目录**：`app/`（App Router，用户侧与 `app/admin`）、`lib/domain`（账本、检索、问答、确权等纯逻辑）、`lib/infra`（Neon、Blob、AI、Paddle、GitHub）、`db/`（drizzle schema 与迁移）、`video/`（Remotion composition）、`tests/`（集成与 Playwright）、`i18n/`（按页面拆的 zh / en 词条）。
- **常量**：价格、费率、上限、门槛全部在 `lib/constants.ts` 一个文件里，和本方案一一对应；改常量就是改方案。
- **迁移**：从 `0001` 开始，每步只新增迁移不改旧的；`scripts/test-integration.sh` 逐条自动提交执行迁移，迁移里不能写事务语句。
- **列表接口约定**：见 8.1；服务端做筛选、排序、分页，返回 `{items, total, page, size}`；CSV 导出接口和列表共用同一套参数，导出全部筛选结果。
- **审计动作码**（写入与筛选共用）：`admin.bootstrap` `admin.login` `admin.create` `admin.disable`；`model.create` `model.update` `model.probe` `model.activate` `model.reembed.start` `model.reembed.done` `model.reembed.failed`；`user.disable` `user.restore` `user.credits.adjust` `user.role.official` `user.role.cancel_official` `user.role.revoke`；`verification.approved` `verification.rejected`；`kyc.verified` `kyc.rejected` `kyc.reset` `kyc.files.view`；`payout.approved` `payout.rejected` `payout.paid` `payout.failed`；`ree.takedown` `ree.restore`。
- **环境变量**：`DATABASE_URL`、`BLOB_READ_WRITE_TOKEN`、`AUTH_SECRET` 与 Google / GitHub OAuth 四个、`GITHUB_APP_*`（仓库只读授权）、`AI_GATEWAY_API_KEY` 或 `LLM_BASE_URL` / `LLM_API_KEY`、`GENERATION_MODEL` / `EMBEDDING_MODEL` / `TRANSCRIPTION_MODEL`（后台没配置时的回退）、`PADDLE_*`、`CRON_SECRET`、`ADMIN_SECRET_KEY`（API key 与 token 的加密密钥）。每步新增的变量在该步 PR 描述里列出。
- **定时任务**（Vercel Cron，都幂等）：回收站知识与对话 30 天清除；KYC 原图通过 30 天删除；中断的视频导出解冻；Plan 周期末作废当期 credits（以 Paddle 续费 webhook 为准，cron 只兜底）；explore 排序分每小时物化。
- **验收**：每步 PR 必须过 `typecheck` 与 `./scripts/test-integration.sh`（跑在 Neon dev 分支），并附该步「验收清单」里每条的 Playwright 用例或人工录屏；所有页面在手机宽度下无横向溢出。
- **PR**：每步一个 PR 进 `rebuild`，由人合并；大步允许拆成同一步的多个 PR，但每个 PR 都能单独部署到 Preview。
- **会话**：每一步由一个独立 session 在 worktree 里做，brief 就是本节对应小节加 8.1 / 8.2 / 8.3；第 7 步的 session 开工前先装 Remotion 的 skills。

### 8.4 七步交付

每一步写清：目标、页面（按原型路由）、接口、表、搬运的旧模块、验收清单、明确不含。

#### 第 1 步 骨架与核心闭环

**目标**：登录 → 四步向导新建 Ree → 上传 PDF / Word / Markdown / TXT 或粘贴文本 → 在 Ree 的「对话」tab 提问，得到带编号引用的回答；管理员能登录并配置三类模型。

**页面**：`/login`；`/dashboard`（只有四张指标卡与我的 Ree 前 5 个，其余区域留空态）；`/rees`（卡片 / 列表、搜索、公开 / 私有筛选、排序、12 / 24 / 48 分页）；`/rees/new` 四步向导（第 3 步只开放文档与粘贴文本两种）；`/rees/[id]/settings`（基本资料、知识与个性、发布与定价三段，删除 Ree 为软删）；`/rees/[id]/knowledge`（列表、状态 tab、搜索、类型筛选、分页、单条预览的「内容预览 / 检索片段 / 处理记录」三个 tab；文件夹、批量、回收站留第 2 步）；`/rees/[id]/chat`（单 Ree 测试对话：就绪状态、示例问题弹层、「最多 N credits」、无答卡片、清空对话）；`/settings?tab=account`（头像、显示名、登录信息、语言）；统一侧栏与固定顶栏、可折叠、手机抽屉；`/admin/login`（空安装首个访问者注册，密码 + TOTP）、`/admin/models`（完整规则：多条配置、唯一启用、启用的不能改模型与端点、探测、生成与转写即时切换；向量化切换按钮先做成「创建重算任务」占位，任务本身第 5 步）。

**接口**：`/api/rees` 增删改与草稿保存；`/api/rees/[id]/knowledge`（Blob 直传令牌 → 提交）、`[kid]`（预览、处理记录）、`[kid]/refresh`；`/api/chats/[id]/messages`（流式，单 Ree）；`/api/account`（资料、头像）；`/api/admin/auth/*`、`/api/admin/models/*`；`/api/upload-token`（Blob 直传，按用途限制类型与大小）。

**表**：user、session、ree、knowledge、chunk、conversation（含 kind）、conversation_ree、message、credit_grant、credit_entry、credit_hold、administrator、admin_session、model_config、admin_audit。

**搬运**：auth 与 OAuth；pdf / ocr / markdown 连接器 + 新写 DOCX；`build-version.ts` 的切块与向量化；`rank.ts`；`llm.ts` / `providers.ts` 改成 `modelFor(kind)`；administration 里的登录、密码、TOTP、模型配置、探测、审计。

**验收清单**：新用户注册得到 100,000 赠送 credits；向导四步可退出续做，确认前不建 Ree；上传 30 页 PDF 后状态 processing → ready，知识页能看到切块与处理记录，扣费等于按实结算的数字且账本有冻结与结算两条；提问得到带编号引用的流式回答，点引用打开抽屉显示摘录；问「明天火星的天气」得到无答卡片且未扣费；余额不足时弹窗引导充值；管理员首次访问注册、再访问只能登录；切换生成模型后下一次提问走新模型；全部页面手机宽度可用。

**不含**：其余知识类型、文件夹与回收站、多 Ree、公开、充值、角色、后台其它页。

#### 第 2 步 知识全类型与知识管理

**目标**：六种知识都能进来并被引用；知识管理达到原型完整度。

**页面**：`/rees/[id]/knowledge` 补齐文件夹栏（新建 / 重命名 / 删除，名称 ≤ 40 唯一）、参与回答开关、批量（移动、重新处理、暂停、恢复、移到回收站）、回收站与恢复、重命名 ≤ 200、排序、跨页选择、「选择全部 N 个筛选结果」；`/rees/[id]/knowledge/[kid]` 独立预览页：正文查找高亮、整站子页面与 GitHub 文件目录（搜索、30 项分页、行号）、音频时间戳转写与跳转、下载解析文本、上一条 / 下一条；`/settings?tab=connections`（连接 / 断开 GitHub；域名列表、添加、DNS TXT 或 well-known 验证向导、移除）；向导第 3 步开放全部六种。

**接口**：`/api/rees/[id]/folders`；`/api/rees/[id]/knowledge/batch`（move / reprocess / pause / resume / trash / restore）；`/api/auth/github/connect`；`/api/domains`、`/api/domains/[id]/verify`；`/api/cron/purge-trash`。

**表**：knowledge 增 enabled、folder_id、deleted_at、children jsonb、activity jsonb、file_name、file_size、consent；knowledge_folder；github_connection；domain_claim。

**搬运**：`github.ts`（加用户 token 分支）、`web.ts`、`http.ts`、`challenge.ts`、`claims/verify.ts`；新写：站内遍历与 sitemap、音频转写 adapter、DOCX。

**验收清单**：公开仓库粘贴即可添加，私有仓库未连接 GitHub 时被拒并引导；单页抓取不需确权，整站在域名未验证时被拒，DNS TXT 与 well-known 两种都能通过；100 MB 音频转写后引用显示「第 12:34」并能跳转；暂停的知识不再参与回答且历史引用仍可打开；移到回收站的知识 30 天后连切块一起消失；重新处理再收一次费、失败全额退回；文件名含「失败」只在测试环境触发失败路径（生产没有这个开关）。

**不含**：多 Ree 对话、公开、充值。

#### 第 3 步 充值与计费闭环

**目标**：钱进得来，账本对得上，官网能看懂价格。

**页面**：`/`（首页：可交互问答示例、六类来源、流程、示例 Ree、15 秒介绍位、价格摘要、FAQ）；`/pricing`（三档卡片、费用表、消耗估算滑块、无 Plan 时 Pack 按钮禁用）；`/checkout?kind=plan|pack&quantity=`（账户卡、订单摘要、Pack 数量 1–10、同意勾选，确认后拉起 Paddle 结账）；`/settings?tab=billing`（总余额、赠送条、Plan / Pack / 收入三卡、流水 tab 全部 / 消耗 / 收入、管理订阅：关闭 / 恢复续费）；侧栏底部 Plan 用量条（本期已用 / 100,000，≥ 90% 标红）；`/legal/terms`、`/legal/privacy`。

**接口**：`/api/billing/checkout`、`/api/billing/paddle`（webhook：到账、续费、取消、退款、拒付）、`/api/billing/entries`（分页流水）、`/api/billing/subscription`（关闭 / 恢复续费）。

**表**：purchase（含 quantity）、subscription（含 cancel_at_period_end）；credit_grant 的 plan 周期逻辑；`/api/cron/expire-plan`。

**搬运**：`paddle.ts` 签名、下单、webhook 解析。

**验收清单**：Paddle 沙盒买 Plan 到账 100,000 当期 credits；无 Plan 买 Pack 接口拒绝、页面按钮禁用；买 3 份 Pack 到账 300,000 不过期；扣费顺序 Plan → 赠送 → Pack → 收入，账本每笔能对到 grant；关闭续费后当期可用、周期末作废、Pack 仍在；退款 webhook 冲回且余额不为负（不足部分记负债行）；流水分页与筛选 URL 可恢复。

**不含**：收入 credits 的产生（第 4 步）、提现。

#### 第 4 步 对话、发现与公开页

**目标**：多 Ree 对话、拿问题找 Ree、公开页与查询费收入。

**页面**：`/talk`（新建对话草稿页：参与者选择、示例问题、费用预估，首次发送才建记录）；`/chats`（搜索对话页：全文搜索与高亮、Ree / 7–30–90 天 / 排序筛选、最近 / 置顶 / 归档 / 回收站 tab、20 / 50 / 100 分页、行菜单与批量、⌘K）；`/chats/[id]`（居中消息流、底部输入框、提问对象选择器与「管理参与者 N/5」、`@` 菜单、每个 Ree 独立气泡并行流式、无答灰行与「这些公开 Ree 可能知道」建议、引用抽屉、有用 / 没用、复制）；侧栏历史（当前 / 置顶 / 最近，按日期分组）；`/explore`（输入框、7 个主分类、排序 推荐 / 回答最多 / 查询费最低、24 / 48 / 96 分页、16:9 封面卡片：简介、角色标识、命中摘录、来源数、价格、累计回答、好评率）；`/r/[slug]`（访客用官网壳、登录后用工作台壳；头像、名称、简介、分类与标签链接、Ree 主与角色标识、视频位占位、示例问题；右栏就绪状态、累计回答、来源数、好评率、价格拆分、「加入对话」；底部「相关 Rees」与「作者的其他 Rees」各 4 条分页）；`/rees/[id]/settings` 的公开开关与查询费生效；Open Graph 预览图。

**接口**：`/api/chats`（新建、列表搜索、重命名、置顶、归档、回收站、批量）、`/api/chats/[id]/rees/[reeId]`、`/api/chats/[id]/messages`（多 Ree 并行流，data part 带 `ree_id`）、`/api/messages/[id]/feedback`、`/api/explore`、`/api/rees/[id]/profile-vector`（知识就绪后重算）、`/api/cron/rank`。

**表**：conversation 增 pinned、archived_at、deleted_at；ree_feedback；ree_profile_vector；ree 增 moderated 字段组与排序分 jsonb；credit_entry 的 query_base / query_fee_paid / query_fee_earned。

**搬运**：无新搬运；检索与生成沿用第 1 步。

**验收清单**：一个对话拉 5 个 Ree 后第 6 个被拒；问题默认发给全部，`@` 某个只它答，`@` 不存在的名字不能发送；「只问这个 Ree」不改变参与者；三个 Ree 并行流式各自气泡；无相关知识的 Ree 不答不扣费，全部无答时出现建议；提问别人的 Ree 扣「20 + 查询费」，Ree 主收入余额同步增加且账本有 query_fee_earned；explore 输入问题后前 10 个结果的摘录确实来自命中段落，空输入显示活跃 Ree 与分类；公开页访客可看、点「加入对话」要求登录；Ree 转私有后从他人对话里移出、历史保留；归档的对话收到新消息回到最近；回收站 30 天清除。

**不含**：角色申请与标识的后台侧（标识的前端展示在这一步做，读 user.role）、统计、后台其它页。

#### 第 5 步 角色、统计与后台扩展

**目标**：认证与官方角色跑通；用户侧统计；后台除 KYC / 提现外的全部页面。

**页面（用户）**：`/settings?tab=role`（门槛五项各显示「值 / 目标、还差多少」、申请表单、申请与角色变更历史、拒绝原因与 30 天冷却提示）；`/rees/[id]/statistics`（成功回答、留存记录、就绪来源、查询收入四项；全部 / 日 / 周 / 月 / 自定义，UTC+8、周一起始，日历弹层、近 7 / 30 / 90 天；小时 / 每日 / 分组趋势；明细表 搜索、20 / 50 / 100）；`/dashboard` 补齐（来源健康条、回答排名、待处理事项、提现引导状态）；`/workspace/sources`、`/workspace/answers`；站内通知列表与小红点。

**页面（后台）**：`/admin/overview`（真实口径：近 30 天提问与收入、待办、模型本月调用与成本取自日志）；`/admin/users`（角色 / 会员 / KYC / 状态 / 时间 组合筛选、CSV）、`/admin/users/[id]`（summary / roles / credits / kyc / purchases / payouts / rees 七个 tab；调整 credits 只动 Pack 或 Plan 桶、1–10,000,000、原因 3–300、不为负；停用 / 恢复；设为官方 / 取消官方 / 撤销认证带原因）；`/admin/verifications` 与 `[id]`（陈述、链接、提交时快照与当前指标、名下公开 Ree、批准 / 拒绝）；`/admin/purchases`（交易 / 订阅两个 tab、`[id]` 只读详情、CSV）；`/admin/rees`（真数据，公开 / 私有 / 已下架筛选，下架与恢复必填原因 3–300）、`/admin/rees/[id]`（四 tab）、`/admin/rees/[id]/sources/[kid]`（只读预览、上一条 / 下一条）；`/admin/audit`（动作码筛选、`[id]` 变更前后 JSON）；「管理员」弹层（添加、停用）；`/admin/models` 的向量化重算任务（进度、失败回退、跑着不能再切）。

**接口**：`/api/account/verification`、`/api/account/notices`；`/api/rees/[id]/statistics`、`/api/workspace/*`；`/api/admin/users*`、`/api/admin/verifications*`、`/api/admin/purchases*`、`/api/admin/rees*`、`/api/admin/audit*`、`/api/admin/administrators`、`/api/admin/models/reembed`；所有列表带 `?format=csv`。

**表**：verification_request；notice；reembed_job；user 增 role 变更历史走 admin_audit。

**搬运**：`manage-administrators.ts`；其余新写。

**验收清单**：门槛未达时申请按钮灰且逐项显示差额，服务端复核拒绝伪造请求；批准后 Ree 公开页、explore 卡片、对话参与者栏、回答头部立即出现「认证」标识，撤销后立即消失；有进行中提现的用户不能设为官方，设为官方关闭其待审申请且不进冷却；统计按日 / 周 / 月 / 自定义与 UTC+8 的边界正确（跨月、跨年、同一天）；后台六个列表千条数据下筛选 + 分页 + CSV 一致，CSV 以 `=` 开头的单元格被转义；切换向量化模型期间检索仍用旧向量，完成后一次切换，中途失败旧配置仍启用；每个后台写操作都有审计且筛选得到。

**不含**：KYC、提现、财务图表。

#### 第 6 步 提现（人工）

**目标**：收入 credits 能变成钱，全程人工可控。

**页面（用户）**：`/settings/identity`（三张卡：身份信息 法定姓名 ≤ 100、国家 ≤ 80、证件类型 护照 / 身份证 / 居留许可、后四位恰 4 位、有效期不早于今天；证明材料 证件照与手持自拍 JPG / PNG / WebP ≤ 10 MB 直传私有 Blob；税务 W-8BEN / W-9、已提交声明、同意用途与 30 天保留；提交后只读、显示待审 / 拒绝原因 / 重新验证要求）；`/settings?tab=billing` 的收款卡（KYC 门禁 → PayPal 邮箱 ≤ 254、改后 7 天保护 → 提现：金额 ≥ 500,000 整数默认全额、单笔进行中限制、状态三步）；`/dashboard` 的提现引导状态。

**页面（后台）**：`/admin/kyc`（状态筛选、最早优先、CSV）、`/admin/kyc/[id]`（身份信息、两张图签名 URL 并排、60 秒失效与重新获取、每次查看写审计、「已比对」勾选、证件未过期校验、通过 / 拒绝 3–300、要求重新验证、通过 30 天后「原图已删除」）；`/admin/payouts`（待审核与待打款）、`/admin/payouts/[id]`（批准需 KYC 通过且非官方；驳回 3–300 解冻）、`/admin/payouts/[id]/payment`（转账 ID 必填、实付 > 0 且 ≤ 申请、两位小数、手续费实时 = 申请 − 实付、标记失败解冻一次、处理后只读）；`/admin/payout-history`（五种状态、CSV）；财务图表（充值 / 提现 / 提现记录页，日 / 周 / 月 / 自定义，金额 / 笔数）作为本步最后一项，可延后。

**接口**：`/api/billing/kyc`、`/api/billing/paypal`、`/api/billing/payouts`；`/api/admin/kyc*`（含 `[id]/files` 签名 URL）、`/api/admin/payouts*`；`/api/cron/purge-kyc-files`。

**表**：kyc_record；payout；credit_entry 的 payout_hold / payout_release / payout_paid。

**搬运**：`payout-profile.ts` 的邮箱与税表校验、`payouts.ts` 的状态机骨架；**不接 PayPal 任何 API**。

**验收清单**：未通过 KYC 看得到收入余额但提现按钮是「完成身份验证」；KYC 待审期间不能重复提交、不能填 PayPal；后台看图每次都有 `kyc.files.view` 审计，60 秒后链接失效；通过 30 天后原图从 Blob 消失、记录仍在；改 PayPal 邮箱后 7 天内提现被拒；申请 600,000 后收入余额立即减少且账本有冻结；驳回解冻、批准不解冻、登记实付 55.00 对申请 60.00 记手续费 5.00；同一用户第二笔申请在第一笔结束前被拒；官方账户进不了 KYC 与提现页。

**不含**：自动打款、第三方 KYC。

#### 第 7 步 视频介绍

**目标**：每个 Ree 一段 15 秒介绍，在线播放免费，浏览器导出 MP4。

**页面**：`/rees/[id]/video`（脚本生成 20 credits、需至少一条就绪知识；四镜头逐镜头编辑与字数上限；模板 简洁叙事 / 知识蓝图 / 聚光时刻；主题色；16:9 / 9:16；音乐开关；Remotion Player 预览与镜头时间轴；导出：`canRenderMediaOnWeb()` 探测、进度条、取消、首次免费后 50 credits、缓存命中免费且不占首次；下载、分享链接；脚本 JSON 下载）；`/videos`（我的 Ree 视频列表）；公开页内嵌播放器（播放 / 暂停 / 进度 / 重播 / 全屏，`?video=1` 自动播放）；explore 与我的 Ree 卡片 16:9 封面与播放弹窗；首页 15 秒入口；Open Graph 图换成视频首帧。

**接口**：`/api/rees/[id]/video/script`、`PATCH /api/rees/[id]/video`、`/api/rees/[id]/video/exports`、`[exportId]/complete`、`/api/cron/abandon-exports`。

**表**：ree_video（含 generated、revision、exports_count、music）；video_export。

**搬运**：无；全部新写。session 开工先 `npx skills add remotion-dev/skills`，按 `remotion-best-practices`、`remotion-markup`、`remotion-render` 做。

**验收清单**：没有就绪知识时生成按钮禁用；生成的脚本每项都在字数上限内，手改超限即时报错；Player 播放与导出的 MP4 画面一致，时长 15.0 秒、720p、24 fps；Safari 导出给出「请用桌面 Chrome 或 Edge」；第一次导出免费、第二次扣 50、内容不变再导出命中缓存不扣费且不计次；导出中关闭标签页，定时任务解冻；公开页 `?video=1` 自动播放，未生成视频的 Ree 显示默认占位；导出文件可下载、分享链接可打开。

**不含**：配音、服务端渲染、用户改时长。

### 8.5 步与步之间

- 第 1 到 3 步严格串行，后面的都依赖它们。
- 第 4 与第 5 步可以并行开两个 session：第 4 步只碰对话、explore、公开页；第 5 步只碰角色、统计、后台；两边都要的「角色标识」由第 4 步先读 `user.role` 展示，第 5 步负责写。
- 第 6 与第 7 步互不依赖，可并行；第 6 步依赖第 5 步的后台框架与用户详情页，第 7 步依赖第 4 步的公开页。
- 每一步合并后在 Preview 上用原型同路由对照一遍，差异要么改代码，要么写进 8.2 的表。
