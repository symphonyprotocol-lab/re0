import type { Shape } from '@/i18n/format';

/**
 * `/legal/terms` and `/legal/privacy`. The privacy notice states what
 * rebuild-proposal.md 2.3 requires before payouts open: what identity
 * documents are for, how long they are kept, when they are deleted, and the
 * tax information we collect. Paragraphs are separated by blank lines.
 */
export const zh = {
  updated: '最近更新：2026 年 11 月 21 日',
  /* 第 7 节的邀请奖励规则，按后台当前设置填入；任一数量为 0 时使用 none。 */
  inviteRule: {
    withdrawable:
      '全站按注册先后计算的前 {withdrawableInvites} 位受邀注册，其邀请奖励以收入 credits 发放，无需等待 30 天，计入即可提现，但同样须满足下一段的全部提现条件。每个账号以收入 credits 获得的邀请奖励，最多对应 {withdrawableInvitesPerInviter} 位受邀注册，超出部分不占用上述全站名额。这两个数量为平台当前的设定，可能调整。超出全站名额或个人上限的邀请奖励以赠送 credits 发放，不能提现。调整这两个数量不改变已经发放的奖励属于哪一类。',
    none: '按平台当前的设定，邀请奖励全部以赠送 credits 发放，不能提现。平台可以调整设定，让一定数量的受邀注册的奖励以收入 credits 发放并可提现；调整不改变已经发放的奖励属于哪一类。',
  },
  contents: '目录',
  footnote: '若中文版本与其他语言版本存在歧义，以中文版本为准。条款在正式开放提现前会再次审阅。',
  terms: {
    title: '服务条款',
    lede: '本条款适用于 RE0 网站与工作台。注册或使用 RE0，即表示你同意本条款与隐私政策。',
    s1: {
      title: '服务与账号',
      body: 'RE0 让你创建 Ree、为它添加知识，并获得只基于这些知识、带有引用的回答。你通过 Google 或 GitHub 登录，需对账号下的所有操作负责。\n\n我们可能因违反本条款、欺诈或法律要求停用账号；停用前已购买且未使用的 Pack credits 按第 5 节处理。',
    },
    s2: {
      title: 'Credits',
      body: 'RE0 的所有消耗以 credit 计，1 credit = 0.0001 美元。Credits 是预付的使用额度，不是货币，不能转让，除第 7 节所述可提现的 credits 外不能兑换为现金。\n\n新用户注册赠送 {welcomeCredits} credits，不过期。完成新手任务、每日打卡获得的奖励，以及超出可提现名额的邀请奖励（见第 7 节），同样以赠送 credits 发放，不过期、不能提现。各项赠送的数额与条件以平台当时公布的为准，平台可以调整或停止，已经发放的不受影响。消耗的先后顺序为：当期 Plan → 赠送 → Pack；退还时按相反顺序退回。收入 credits（第 7 节）不会被自动消耗，只能提现、按平台公布的比例转换为 Pack credits，或在购买 Plan、Pack 时抵扣价格；退款或拒付时的收回见第 5 节。余额不足时操作会被拒绝，不会透支。',
    },
    s3: {
      title: 'Plan 与 Pack',
      body: 'Plan 按月订阅。新订阅的价格和积分额度以结账时显示为准，续费按发放时的月度积分额度到账。每期积分仅在当期有效，周期结束时未用完的部分作废。Plan 按月自动续费，你可以随时在「余额与计费」中关闭续费；关闭后当期 credits 仍可使用至周期末，之后不再扣款，也不再到账。\n\nPack 为一次性购买，每份价格和积分额度以结账时显示为准，一次可买 1 到 10 份，积分永不过期。只有 Plan 订阅在有效期内的用户可以购买 Pack；Plan 取消或到期后，已购买的 Pack 仍可使用。',
    },
    s4: {
      title: '付款与 Paddle',
      body: '付款由 Paddle.com 作为经销商（merchant of record）处理，Paddle 负责收款、开具发票并依法计算和代缴税费，结账时适用 Paddle 的买家条款。RE0 不接触也不保存你的银行卡信息。显示的价格不含税，税费在结账时计算。',
    },
    s5: {
      title: '退款与拒付',
      body: '退款通过 Paddle 处理，可发送邮件至 support@re0.io 申请。退款或拒付生效后，对应购买所到账的 credits 按退款比例收回：先从该笔购买尚未使用的额度中收回，再从你的其他余额（包括收入 credits）中收回。余额不会因此变为负数；已经用掉、无法收回的部分记为待抵扣额度，从你下一次到账的 credits 中优先扣除。',
    },
    s6: {
      title: '消耗与结算',
      body: '向 Ree 提问时，每个实际作答的 Ree 收取 20 credits 基本使用费，提问他人的 Ree 时另付该 Ree 主设定的查询费；没有相关知识、未作答的不收费。私密帖子及其追问的这些费用在发送时按显示的价格预留（见第 9 节）。知识处理按实际调用的 Firecrawl、embedding、语音转文字等第三方服务成本计费，不另收字符费；各项美元费用汇总后按 1 credit = $0.0001 换算，最后统一向上取整。发布公开帖子不收费，每天最多 {postDailyLimit} 个，按回答收费（见第 10 节）：其他人的免费 Ree 每个回答向发帖人收取 {postBaseFee} credits 基本使用费，一个帖子自动回答的费用最多 {postMaxAutoCost} credits；付费 Ree 经发帖人同意后另收基本使用费和查询费。可用余额不足 {postBaseFee} credits 时不能发帖。没有任何 Ree 回答时的 AI 通用回答收取 {postBaseFee} credits，生成失败时退还（见第 10 节）。帖子的圆桌总结收取 {postSummaryFee} credits，生成失败或未通过审核时退还；总结依据的回答不再显示后，作者可以重新生成，只要不再显示的回答都不属于作者自己的 Ree，每个帖子最多免费重写 {postSummaryFreeRewrites} 次。初始预留可退、不是总价上限，实际费用自动补足、多余退回；余额不足则停止；处理失败时按已发生的成本结算，只退回没用掉的预留，余额不够支付的部分记为欠款，下次到账时先还。第三方单价随供应商及所选模型调整，实际用量与费用可在处理记录中查看。已添加的知识在保存期间按实际占用的存储空间和时长计费（上传的文件，以及解析后的文本、片段与向量），每天结算一次，余额不足的部分同样记为欠款；Ree 删除后停止计费。',
    },
    s7: {
      title: '收入 credits、邀请奖励与提现',
      body: '他人向你的 Ree 提问时支付的查询费，全额计入你的收入 credits；免费 Ree 回答公开帖子不产生查询费；付费 Ree 经发帖人同意后回答帖子时，查询费按向它提问的规则计入（见第 10 节）。收入 credits 不过期，不会被自动消耗，但并非全部可以提现：\n\n提问人用付费购买的额度（Plan、Pack，或本身可提现的收入 credits）支付的部分，自计入之日起满 30 天后可以提现；提问人用免费额度（注册赠送、新手任务、每日打卡、不可提现的邀请奖励等赠送 credits，兑换码，后台发放的额度，或由这些额度换来的收入 credits，以及由这类收入转换得到的 Pack credits）支付的部分，只能转换为 Pack credits 后使用，不能提现，也不能抵扣购买。若支付查询费的那笔购买在这 30 天内退款或拒付，RE0 会先向提问人收回（见第 5 节）；只有无法从提问人处全部收回、形成待抵扣额度时，才会在未收回的金额以内，作废由这笔购买支付、尚未满 30 天且尚未使用的收入 credits，以及由这类收入转换得到、尚未使用的 Pack credits（在原收入满 30 天之前）。提问人之后补足欠款（或拒付被撤销）时，作废的收入 credits 会按已补足的比例恢复，保留原来的可提现日期。已满 30 天、已用于提现申请或已经用掉的部分不会因此收回。\n\n他人通过你的邀请链接注册新账号后，计入你的邀请，你获得平台当时设定的邀请奖励。{inviteRule}\n\n可提现的收入 credits（包括可提现的邀请奖励）达到提现门槛后可申请提现。统一提现门槛目前为 {payoutMinCredits} credits（{payoutMinUsd}），由平台设定并可能调整；平台也可以为个别账号设定不同的门槛，以该账号提现页面显示的为准。调整门槛只影响之后提交的申请。申请处理期间相应 credits 会被冻结，经人工审核后打款。首次提现前须通过人工身份验证并提交税务信息声明，收款方式为你本人的 PayPal 账户，PayPal 手续费由提现人承担。账号有未清的待抵扣额度或已被停用时，不能申请提现，已提交的申请也不会被批准或打款。Plan、Pack 与赠送 credits（注册赠送、新手任务、每日打卡与不可提现的邀请奖励）不能提现。你需自行承担所得相关的纳税义务。\n\n收入 credits 也可以在余额页按平台公布的比例转换为 Pack credits：转换后的 credits 不过期、不能提现，按第 2 节的顺序与其他 credits 一起消耗，转换不可撤销。购买 Plan 或 Pack 时，可以用已可提现的收入 credits 抵扣价格，按结账页显示的比例换算，以整美分为单位，上限与最低应付金额同样以结账页显示为准；尚未满 30 天或由免费额度换来的收入 credits 只能转换，不能抵扣。全额抵扣的 Plan 为一个月、不自动续费；部分抵扣的 Plan 只抵扣首期，之后按原价续费。转换或抵扣用掉的收入 credits 不再能提现，也不计入提现门槛。抵扣过的购买发生退款或拒付时，用于抵扣的收入 credits 按退款金额占实付金额的比例退回；若这次退款形成待抵扣额度，退回的收入 credits 先用于抵扣。全额用收入 credits 支付的购买不经过 Paddle，不能通过 Paddle 申请退款。',
    },
    s8: {
      title: '知识与内容',
      body: '你只能添加你有权使用的知识。整站抓取前须完成域名确权，私有仓库须经你的 GitHub 授权。你保留所添加内容的权利，并授予 RE0 为提供服务所需的处理许可（解析、转写、向量化与生成回答）。公开的 Ree 主页展示简介、来源数量，以及它回答的公开帖子；回答中的引用只展示来源标题与相关片段，不展示完整的知识内容。违反法律或本条款的公开内容可能被管理员转为私有或下架。',
    },
    posts: {
      title: '公开帖子、私密帖子、引用与举报',
      body: '登录用户可以发布公开帖子提问。帖子一经公开，任何人（包括未登录的访客）都能看到它的问题、补充说明和回答，其他登录用户可以收藏、标记有帮助或引用它。发帖时可以选择匿名：帖子页、信息流、引用卡片和 Ree 主页都不显示你的名字和头像；但平台仍会记录发帖的账号，用于你管理自己的帖子、计费、防止滥用和处理举报。\n\n帖子公开前，问题与补充说明会先自动隐去看起来像手机号、邮箱、证件号、链接或 QQ、微信号的内容，再经过自动审核；未通过审核的帖子不会公开，只有你自己能看到。自动隐去和审核都可能遗漏或误判，不能保证帖子中不含个人信息，请不要在帖子里写入你或他人的联系方式与身份信息。Ree 的回答不经过这一步自动隐去。\n\n任何人都可以举报帖子或回答。一个帖子被 {postReportThreshold} 个不同的举报人举报后自动下架，一个回答被 {answerReportThreshold} 个不同的举报人举报后自动隐藏；管理员也可以下架帖子或隐藏回答，并可以恢复由管理员或举报下架、隐藏的内容；Ree 主可以隐藏自己 Ree 的回答，Ree 主隐藏的回答不会被恢复。下架的帖子不再出现在信息流、搜索、站点地图、Ree 主页和分享页中，作者本人仍可看到。\n\n其他登录用户可以在自己的公开帖子里引用公开的帖子或其中的一条回答，引用卡片显示被引用的问题、作者（按原帖的匿名设置）和回答摘要。被引用的内容被删除、下架、隐藏，或回答它的 Ree 不再公开后，卡片只显示“被引用的内容已不可见”，引用它的帖子仍然保留。原帖被下架或被引用的回答被隐藏时，引用它的帖子会交给管理员复核，复核前它们的回答保持公开，管理员可以保留或隐藏这些回答。\n\n你可以把自己的帖子移到回收站，它会立即对他人不可见，30 天内可以恢复，之后连同它的回答、收藏与举报记录永久删除。已被搜索引擎收录的页面，在搜索引擎更新前可能仍出现在其搜索结果中。账号被停用不会撤下它已经公开的帖子与回答，需要时由管理员下架。\n\n登录用户也可以发布私密帖子（私密提问）。私密帖子只有你自己能看到，不经过审核，不出现在信息流、搜索、站点地图、Ree 主页和分享页中，其他人不能收藏、举报或引用它；发送前，问题与补充说明同样会自动隐去上述内容。你为它选择最多 {privatePostMaxRees} 个 Ree，费用按第 6 节计算，在发送时按显示的价格预留；价格高于显示的价格或余额不足时不会发送。之后你可以在同一个帖子里向其中任意 Ree 追问，或加入新的 Ree（一个帖子合计最多 {privatePostMaxRees} 个），每次追问同样在发送时按显示的价格收费。你可以置顶、归档、重命名私密帖子，或把它移到回收站（规则同上）。你也可以把它转为公开：问题、补充说明和第一轮的回答会复制成一个新的公开帖子，与其他公开帖子一样经过审核后公开，复制的回答按公开帖子的规则显示（例如回答它的 Ree 须为公开）；追问和 AI 通用回答不会复制，原来的私密帖子保持不变。Ree 主的试问和通过 MCP 的提问也保存为私密帖子。\n\n改版前，登录用户可以把自己与某个 Ree 的私密对话中的第一个问题及其回答公开。私密对话已随改版删除，当时位于回收站中的对话所公开的问答一并删除；其余已经公开的问答保留为公开帖子，仍显示为“一位用户”，不显示你的名字，平台仍记录提问的账号。Ree 主关闭公开问答后，回答不再显示，问题仍可通过原来的帖子链接打开。这类帖子不在“我的帖子”中，需要撤下时请发送邮件至 legal@re0.io。',
    },
    reeAnswers: {
      title: 'Ree 回答公开帖子',
      body: '公开的 Ree 可能自动回答与它的知识相关的公开帖子，每个帖子最多由 {postMaxAnswers} 个 Ree 回答。回答全文，以及它引用的来源标题与相关片段，会公开显示在帖子页上；信息流和 Ree 主页显示摘要，可以展开全文。\n\n发帖不收费，每个回答单独向发帖人收费。免费的 Ree（查询费为 0）默认参与并直接回答，每个回答收取 {postBaseFee} credits 基本使用费，归平台，Ree 主没有收入；一个帖子自动回答最多 {postMaxAutoCost} credits。回答前先按相关度从高到低预留每个回答的费用，余额不够的那些 Ree 不直接回答，改为等待发帖人同意。设置了查询费的 Ree，只有在 Ree 主于设置中打开“回答相关的公开帖子”后才参与，而且不会直接回答：它会先向发帖人发出付费回答请求，显示价格（基本使用费加查询费）。等待同意的请求只有发帖人能看到；发帖人同意后才扣费并开始回答，扣费不高于同意时显示的价格（价格上调时需要发帖人重新确认）；发帖人不同意或不处理，它就不回答。等待中的 Ree 变为私有或关闭这一设置时，它的请求随即关闭。发帖人自己的 Ree 回答自己的帖子同样收取 {postBaseFee} credits 基本使用费；自己的付费 Ree 不收查询费，Ree 主也不因此获得收入。RE0 发布的示例帖子的回答由平台承担，不向任何人收费。Ree 主可以随时关闭这一设置，关闭后不再回答新的帖子，已经公开的回答仍然保留，Ree 主可以逐条隐藏。\n\n每个回答单独结算：回答后基本使用费归平台，付费 Ree 的查询费全额计入 Ree 主的收入 credits（提现条件见第 7 节）；没有作答、回答失败或超时，该回答预留的费用全部退还。经同意的回答失败或超时后，发帖人可以再试，每个请求最多同意 {postAgreeMax} 次；Ree 没有相关内容而未作答的，不能再次同意。帖子未通过审核时不收费；没有任何 Ree 回答时，按下一段收取 AI 通用回答的费用。已经结算的回答（免费或付费）之后被举报、隐藏或下架，或帖子被删除，费用都不退还。\n\n帖子（公开或私密）或追问的一轮里没有任何 Ree 回答、也没有等你同意的付费 Ree 时，平台的 AI 模型会按通用知识先给提问人一个通用回答，向提问人收取 {postBaseFee} credits（问答基础费，归平台，不额外加价）；生成失败或超时全额退还，余额不足时不生成，充值后可以手动补生成一次。公开帖子的 AI 通用回答会先像其他公开内容一样经过自动审核，通过后所有人（包括未登录的访客）都能看到，审核前和未通过审核时只有提问人能看到，未通过审核不退还费用；私密帖子的 AI 通用回答只有你自己能看到。AI 通用回答不算任何 Ree 的回答，帖子仍留在“待回答”里；之后有 Ree 回答时它折叠保留，费用不退还。在没有 Ree 回答的公开帖子里，任何登录用户都可以在 AI 通用回答下继续追问：追问与其他追问一样经过审核后公开，由 AI 回答，费用向追问的人收取。RE0 的示例帖子、Ree 主的试问和通过 MCP 的提问不生成 AI 通用回答。\n\nRE0 可能把参与回答公开帖子的 Ree 设置的示例问题，以 RE0 的名义作为帖子发布（标注“示例问题”），由相关的 Ree 回答，不向任何人收费。\n\n未登录的访客可以浏览公开的帖子、回答和 Ree，但需要登录后才能发帖、提问或追问。',
    },
    s9: {
      title: '可接受使用',
      body: '不得利用 RE0 侵犯他人权利、传播违法内容、绕过计费或限频、批量注册账号，或干扰服务的正常运行。',
    },
    s10: {
      title: '责任限制与条款变更',
      body: 'Ree 的回答基于你或 Ree 主提供的知识自动生成，可能不完整或有误，请结合引用自行判断。AI 通用回答由模型按通用知识生成，没有出处，不代表任何 Ree 或创作者，不保证准确，不构成医疗、法律、财务、心理或其他专业建议。在法律允许的范围内，RE0 对间接损失不承担责任，直接责任以你在过去 12 个月内向 RE0 支付的金额为限。\n\n条款变更会在本页更新，并标注最近更新日期。对条款有疑问，请联系 legal@re0.io。',
    },
  },
  privacy: {
    title: '隐私政策',
    lede: '本政策说明 RE0 收集哪些信息、用于什么目的、交给哪些服务商处理、保留多久，以及你可以如何查看与删除自己的数据。',
    s1: {
      title: '我们收集的信息',
      body: '账号信息：Google 或 GitHub 提供的邮箱、显示名称、头像与账号标识，以及你在设置中修改的资料与语言。\n\n你的知识与提问：你上传的文件、提交的链接与仓库、粘贴的文本、处理后的正文与检索片段，以及你的提问（公开帖子、私密帖子、追问与试问）、Ree 的回答和 AI 通用回答。私密帖子只有你自己能看到，不公开；它的问题会发送给模型服务商，用于匹配 Ree 与生成回答。\n\n付款记录：Paddle 回传的交易号、订阅号、金额、币种、计费周期与退款状态。我们不接收也不保存银行卡号。\n\n使用记录：credit 流水、处理记录与必要的服务日志。',
    },
    public: {
      title: '公开内容与访客',
      body: '公开帖子：你发布的问题、补充说明、是否匿名，以及你的收藏、“有帮助”标记、举报与引用记录。帖子公开后任何人都能看到，通过审核且有回答显示的帖子页面可能被搜索引擎收录；没有回答、被下架或移到回收站的帖子页面会标记为不收录。匿名帖子对外不显示你的身份，但我们保存发帖的账号。帖子的问题、补充说明和回答会发送给模型服务商，用于自动审核、匹配与生成回答。\n\n访客：未登录的访客可以浏览公开内容，不能提问。改版前，访客可以在分享页向免费 Ree 提问，问题与回答的文字只保存在浏览器标签页中，我们没有在服务器上保存，也没有公开；当时为执行每日次数限制保存的浏览器标识、Cookie 标识与 IP 地址的加密哈希及次数已过期清除。当时每次回答对应的 Ree 与时间（不含内容）作为统计记录保留。访客举报时，以 IP 地址的加密哈希作为举报人标识。\n\n限流：对未登录的访问（浏览帖子与 Ree、举报等）限流时，以原始 IP 地址为键记录短时间内的请求次数，这些记录最长保留约 2 小时后清除。',
    },
    s2: {
      title: '使用目的',
      body: '提供与改进服务、计算与结算 credits、处理付款与退款、防止欺诈与滥用、履行法律义务。我们不出售你的个人信息，也不把你的知识用于训练模型。',
    },
    s3: {
      title: '第三方服务商',
      body: 'Paddle（付款、税费与发票）；Vercel（托管与文件存储）；Neon（数据库）；生成、向量化与音频转写所用的模型服务商（经 Vercel AI Gateway 或我们配置的接口调用；音频在提交前会提示将发送给转写服务）；GitHub（仅在你授权后读取私有仓库）。这些服务商只在提供相应服务所需的范围内处理数据。',
    },
    s4: {
      title: '身份验证资料（KYC）',
      body: '用途：仅用于首次提现前的人工身份核验、防止冒名与盗号、履行与付款相关的法律和税务义务，不用于其他目的。\n\n收集内容：法定姓名、国家或地区、证件类型（护照、身份证或居留许可）、证件号码后四位、证件有效期、证件照片，以及手持证件的自拍。\n\n存储与访问：证件照片与自拍直接上传到私有存储，不公开、不可通过普通链接访问；只有经授权的管理员可以通过 60 秒内失效的签名链接查看，每一次查看都会写入审计记录。\n\n保留期与删除：审核通过 30 天后，证件照片与自拍原图会被自动删除，只保留证件类型、号码后四位、有效期、审核人与审核时间。未通过或被要求重新验证的提交，原图在审核结论作出后 30 天内删除。保留下来的核验记录与提现记录，在你的账号存续期间以及法律要求的会计与税务保存期限内保存，期满后删除。',
    },
    s5: {
      title: '税务信息',
      body: '提现前需选择适用的税务表单类型——美国税务居民为 W-9，非美国人士为 W-8BEN——并声明已完成提交；我们保存表单类型与声明时间。我们可能依法向税务机关报送付款信息。你仍需按所在地法律自行申报相关所得。',
    },
    s6: {
      title: '保留期限',
      body: '账号存续期间保留你的账号、知识与帖子（包括私密帖子）。移到回收站的知识与帖子（公开或私密）30 天后连同其回答清除；清空试问时，已完成的试问立即删除。旧的私密对话已随改版删除。被下架或未通过审核的帖子保存在你的账号下，你可以随时把它们移到回收站。付款、退款与 credit 流水按会计与税务法规要求的期限保存。删除账号的请求由人工处理，请按第 9 节所述的方式向我们提出。处理后，你发布的公开帖子及其回答会被移除；法律要求保存的记录（如付款、退款与 credit 流水）会按法律要求的期限保留。',
    },
    s7: {
      title: 'Cookie',
      body: '我们只使用维持登录与记住界面语言、侧栏状态所必需的 Cookie，以及记录分享页访问（用于分享统计）的 Cookie，不使用广告或跨站追踪 Cookie。Paddle 结账窗口会使用 Paddle 自己的 Cookie。',
    },
    s8: {
      title: '你的权利',
      body: '你可以查看、更正或导出自己的资料，删除知识与帖子，或申请删除账号。发送邮件至 legal@re0.io 提出隐私相关请求，我们会在 30 天内答复；涉及账号的请求请使用注册邮箱发送，以便核对身份。',
    },
    s9: {
      title: '安全与变更',
      body: '数据在传输与存储时加密，第三方 API 凭据与授权令牌加密保存，管理后台需要密码与动态验证码，管理员的操作有审计记录。本政策变更会在本页更新，并标注最近更新日期。',
    },
  },
};

export const en: Shape<typeof zh> = {
  updated: 'Last updated: November 21, 2026',
  inviteRule: {
    withdrawable:
      'For the first {withdrawableInvites} invited sign-ups site-wide, in order of registration, the reward is paid as earned credits with no 30-day wait: it is withdrawable once credited, still subject to every payout condition in the next paragraph. Each account receives invitation rewards as earned credits for at most {withdrawableInvitesPerInviter} invited sign-ups; those beyond it do not use a site-wide place. Both numbers are the platform\'s current settings and may change. Invitation rewards beyond the site-wide quota or your own limit are paid as gift credits and cannot be withdrawn. Changing either number does not change the kind of a reward already paid.',
    none: 'Under the platform\'s current settings, all invitation rewards are paid as gift credits and cannot be withdrawn. The platform may change its settings so that rewards for a number of invited sign-ups are paid as withdrawable earned credits; a change does not change the kind of a reward already paid.',
  },
  contents: 'Contents',
  footnote: 'Where the Chinese and another language version differ, the Chinese version prevails. These terms will be reviewed again before payouts open.',
  terms: {
    title: 'Terms of Service',
    lede: 'These terms apply to the RE0 website and workspace. By signing up for or using RE0 you accept these terms and the Privacy Policy.',
    s1: {
      title: 'Service and account',
      body: 'RE0 lets you create Rees, give them knowledge, and get cited answers based only on that knowledge. You sign in with Google or GitHub and are responsible for everything done under your account.\n\nWe may disable an account for breach of these terms, fraud, or legal requirements; unused Pack credits bought before that are handled as in section 5.',
    },
    s2: {
      title: 'Credits',
      body: 'Everything on RE0 is charged in credits: 1 credit = USD 0.0001. Credits are prepaid usage, not money; they cannot be transferred and, except for the withdrawable credits under section 7, cannot be exchanged for cash.\n\nNew users receive {welcomeCredits} welcome credits that do not expire. Rewards for starter tasks and daily check-ins, and invitation rewards beyond the withdrawable quota (section 7), are also gift credits: they do not expire and cannot be withdrawn. The amounts and conditions of each gift are those the platform announces at the time; the platform may change or end them, and gifts already granted are not affected. Credits are spent in this order: current Plan → gift → Pack; returns go back in reverse order. Earned credits (section 7) are never spent automatically: they can be withdrawn, converted into Pack credits at the rate the platform publishes, or used to pay for a Plan or Pack; for what a refund or chargeback takes back, see section 5. When the balance is too low, the action is refused; nothing is overdrawn.',
    },
    s3: {
      title: 'Plan and Pack',
      body: 'The Plan is a monthly subscription. The price and allowance for a new subscription are shown at checkout. Renewals grant the monthly allowance in effect when the payment is credited. Each cycle’s credits are valid for that cycle and any unused credits expire at its end. The Plan renews monthly; you can turn renewal off at any time under Credits & billing. The current cycle’s credits remain usable until it ends; after that you are not charged and receive no further credits.\n\nA Pack is a one-time purchase of non-expiring credits. The price and allowance per pack are shown at checkout, where you can buy 1 to 10 packs. Packs are sold only while your Plan is active; Packs you bought remain usable after the Plan ends.',
    },
    s4: {
      title: 'Payment and Paddle',
      body: 'Payments are processed by Paddle.com as merchant of record: Paddle takes the payment, issues invoices, and calculates and remits taxes as required, and Paddle’s buyer terms apply at checkout. RE0 never sees or stores your card details. Prices exclude tax, which is calculated at checkout.',
    },
    s5: {
      title: 'Refunds and chargebacks',
      body: 'Refunds are handled through Paddle; email support@re0.io to request one. Once a refund or chargeback takes effect, the credits that purchase added are taken back in proportion to the refund: first from what is left of that purchase, then from the rest of your balance, earned credits included. Your balance never goes below zero; the part already spent is recorded as an amount owed and deducted first from the next credits you receive.',
    },
    s6: {
      title: 'Usage and settlement',
      body: 'Each Ree that actually answers a question charges a 20-credit base fee; asking someone else’s Ree adds the query fee its owner set. An unanswered question costs nothing. For a private post and its follow-ups these fees are reserved when you send, at the price shown (section 9). Knowledge processing passes through actual costs from services called, including Firecrawl, embedding and transcription, with no character fee. USD costs are totaled, converted at 1 credit = $0.0001 and rounded up once. Public posts cost nothing to publish, up to {postDailyLimit} a day; answers are charged (section 10): each answer from someone else\'s free Ree costs the poster the {postBaseFee}-credit base fee, at most {postMaxAutoCost} credits for one post\'s automatic answers; a paid Ree, once the poster agrees, costs the base fee plus its query fee. You cannot post with less than {postBaseFee} credits available. The AI general answer given when no Ree answers costs {postBaseFee} credits, returned if it fails (section 10). A post\'s round-table summary costs {postSummaryFee} credits, returned if it fails or does not pass review; once an answer it drew on is no longer shown, the author can write it again, free up to {postSummaryFreeRewrites} times per post as long as none of the answers no longer shown belongs to the author\'s own Rees. Initial reservations are refundable, not price caps. Shortfalls are reserved automatically; unused credits are returned. Insufficient balance stops processing. A failed run is charged for the costs already incurred and only unused credits are returned; what the balance cannot cover is owed and repaid from the next credits. Provider rates depend on the supplier and selected model; actual usage and costs appear in processing activity. Knowledge you have added is charged for storage while it is kept, by the space it takes (the uploaded file and its parsed text, passages and vectors) and for how long, settled daily; what the balance cannot cover is owed in the same way. Storage charges stop when the Ree is deleted.',
    },
    s7: {
      title: 'Earned credits, invitation rewards and payouts',
      body: 'Query fees others pay to ask your Rees become your earned credits in full; free Rees\' answers to public posts carry no query fee; a paid Ree\'s answer to a post, once the poster agrees, credits its query fee like a question to it (section 10). Earned credits do not expire and are never spent automatically, but not all of them can be withdrawn:\n\nThe part an asker paid from purchased credits (Plan, Pack, or earned credits that are themselves withdrawable) can be withdrawn 30 days after it was credited. The part an asker paid from free credits (gift credits such as welcome, starter-task, daily check-in and non-withdrawable invitation rewards, redeem codes, credits granted by RE0, or earned credits that came from those, and Pack credits converted from such earnings) can only be converted into Pack credits, never withdrawn or used toward a purchase. If the purchase that paid a query fee is refunded or charged back within those 30 days, RE0 first recovers the refund from the asker (section 5). Only if it cannot be recovered from the asker in full and an amount owed remains are earned credits that purchase paid for, less than 30 days old and not yet used, voided, up to the amount not recovered, together with unused Pack credits converted from such earnings before they reached 30 days. When the asker later pays off the amount owed (or the chargeback is reversed), the voided earned credits are restored in proportion to what was paid, keeping their original withdrawal date. Credits past 30 days, already requested in a payout, or already spent are not taken back for this reason.\n\nWhen someone creates a new account through your invite link, the invitation counts as yours and you receive the invitation reward the platform sets at the time. {inviteRule}\n\nOnce your withdrawable earned credits, including withdrawable invitation rewards, reach the payout minimum, you may request a payout. The site-wide minimum is currently {payoutMinCredits} credits ({payoutMinUsd}); the platform sets it and may change it, and may set a different minimum for an individual account, shown on that account\'s payout page. A change applies to requests made after it. The credits are held while the request is processed and paid after manual review. Before the first payout you must pass a manual identity check and submit a tax declaration; payouts go to your own PayPal account, and PayPal fees are borne by you. While your account has an amount owed or is disabled, you cannot request a payout and a request already made is not approved or paid. Plan, Pack, and gift credits (welcome, starter tasks, daily check-ins and non-withdrawable invitation rewards) cannot be withdrawn. You are responsible for any taxes on your earnings.\n\nEarned credits can also be converted on the Balance page into Pack credits at the rate the platform publishes: converted credits do not expire, cannot be withdrawn, and are spent with your other credits in the order in section 2; a conversion cannot be undone. When buying a Plan or Pack, withdrawable earned credits can pay part or all of the price at the rate shown at checkout, in whole cents, within the limit and minimum payment also shown there; earned credits still in their 30 days or that came from free credits can only be converted, not used this way. A Plan paid in full this way lasts one month and does not renew; a Plan paid in part this way has only its first period reduced and renews at the full price. Earned credits converted or used for a purchase can no longer be withdrawn and do not count toward the payout minimum. If a purchase paid in part with earned credits is refunded or charged back, those earned credits come back in proportion to the refund against what was paid; if the refund leaves an amount owed, the returned earned credits pay it first. A purchase paid entirely with earned credits never goes through Paddle and cannot be refunded through Paddle.',
    },
    s8: {
      title: 'Knowledge and content',
      body: 'Add only knowledge you have the right to use. Whole-website crawls require a verified domain; private repositories require your GitHub authorization. You keep your rights to what you add and grant RE0 the processing needed to provide the service (parsing, transcription, embedding, and answer generation). A public Ree\'s page shows its description, how many sources it has, and the public posts it answered; citations show only source titles and relevant excerpts, never the whole knowledge. Public content that breaks the law or these terms may be made private or taken down by an administrator.',
    },
    posts: {
      title: 'Public and private posts, quotes and reports',
      body: 'Signed-in users can ask in public posts. Once a post is public, anyone, including signed-out visitors, can see its question, details and answers, and other signed-in users can save it, mark it helpful or quote it. You can post anonymously: the post page, feeds, quote cards and Ree pages then show neither your name nor your avatar. RE0 still records which account posted, to let you manage your posts, to bill, to prevent abuse and to handle reports.\n\nBefore a post is public, its question and details are automatically stripped of what looks like phone numbers, email addresses, identity numbers, links, or QQ and WeChat ids, and then reviewed automatically. A post that fails review is not made public; only you can see it. Neither the automatic removal nor the review is guaranteed to catch everything or to be right every time, and neither guarantees a post holds no personal information: do not write your own or anyone else\'s contact or identity details in a post. Ree answers do not go through this automatic removal.\n\nAnyone can report a post or an answer. A post reported by {postReportThreshold} different reporters is taken down automatically, and an answer reported by {answerReportThreshold} different reporters is hidden automatically. Administrators can also take posts down or hide answers, and can restore what administrators or reports took down or hid; a Ree\'s owner can hide that Ree\'s answers, and an answer its owner hid is not restored. A post taken down no longer appears in feeds, search, the sitemap, Ree pages or share pages; its author can still see it.\n\nOther signed-in users can quote a public post, or one of its answers, in a public post of their own. The quote card shows the quoted question, its author (as the original post\'s anonymity setting allows) and an excerpt of the answer. Once the quoted content is deleted, taken down or hidden, or the Ree that answered is no longer public, the card says only that the quoted content is no longer available; the quoting post stays. When the original post is taken down, or the quoted answer is hidden, the posts quoting it go to an administrator for review; until then their answers stay public, and the administrator may keep or hide them.\n\nYou can move your own post to the trash. It is hidden from others at once and can be restored for 30 days; after that it is deleted for good, with its answers, saves and reports. Pages a search engine has already indexed may still appear in its results until it updates them. Disabling an account does not take down the posts and answers it already made public; an administrator takes them down where needed.\n\nSigned-in users can also ask in private posts (private questions). Only you can see a private post: it is not reviewed, does not appear in feeds, search, the sitemap, Ree pages or share pages, and no one else can save, report or quote it; before it is sent, its question and details are stripped of the same details as above. You pick up to {privatePostMaxRees} Rees for it; the fees are those of section 6, reserved when you send at the price shown, and it is not sent if the price is higher than shown or your balance is too low. You can then ask follow-ups in the same post to any Ree in it, or add Rees (up to {privatePostMaxRees} in one post), each follow-up charged when sent at the price shown. You can pin, archive, rename or move a private post to the trash (on the terms above). You can also make it public: its question, details and first-round answers are copied into a new public post, reviewed like any other before it is public, and the copied answers are shown under the rules for public posts (for instance, the Ree that answered must be public); follow-ups and AI general answers are not copied, and the private post stays as it was. A Ree owner\'s test questions and questions asked through MCP are also kept as private posts.\n\nBefore the redesign, a signed-in user could make public the first question of their own private conversation with a Ree, with its answer. Private conversations were deleted with the redesign, and the public Q&A made from a conversation that was then in the trash was deleted with it; the rest remain public posts, still shown as "a user" without your name, and RE0 still records which account asked. Once the Ree\'s owner turns public Q&A off, the answer is no longer shown, but the question can still be opened at its post link. These posts are not listed under My posts; to have one taken down, email legal@re0.io.',
    },
    reeAnswers: {
      title: 'Rees answering public posts',
      body: 'A public Ree may automatically answer public posts related to its knowledge; at most {postMaxAnswers} Rees answer each post. The whole answer, with the titles and relevant excerpts of the sources it cites, is shown publicly on the post page; feeds and Ree pages show an excerpt that can be expanded.\n\nPosting costs nothing; each answer is charged to the poster on its own. Free Rees (query fee 0) take part by default and answer at once, each answer costing the {postBaseFee}-credit base fee, which goes to RE0; their owners earn nothing from it. One post\'s automatic answers cost at most {postMaxAutoCost} credits. Before answering, each answer\'s fee is reserved, most relevant Ree first; Rees the balance cannot cover wait for the poster to agree instead of answering. A Ree with a query fee takes part only after its owner turns on "Answer related public posts" in its settings, and does not answer at once: it first sends the poster a paid answer request showing its price (the base fee plus its query fee). Requests waiting for agreement are seen only by the poster; only once the poster agrees is it charged, never more than the price shown when they agreed (a higher price must be confirmed again), and the answer started; if the poster declines or does nothing, it does not answer. If a waiting Ree turns private or stops answering posts, its request is closed. The poster\'s own Rees answer the poster\'s posts like any free Ree and also cost the {postBaseFee}-credit base fee; an own paid Ree\'s query fee is waived, and its owner earns nothing from it. Answers to RE0\'s example posts are paid by RE0 and charged to no one. The owner can turn the setting off at any time: the Ree then answers no new posts, its answers already public stay, and the owner can hide them one by one.\n\nEach answer is settled on its own: once it answers, the base fee goes to RE0 and a paid Ree\'s query fee to its owner\'s earned credits in full (payout conditions in section 7); if it does not answer, fails or times out, what was reserved for it is returned in full. When an answer the poster agreed to fails or times out, the poster may try again, agreeing to one request at most {postAgreeMax} times in all; when the Ree has nothing relevant and does not answer, it cannot be agreed to again. Nothing is charged when the post fails review; when no Ree answers, the AI general answer of the next paragraph is charged. Once settled, an answer, free or paid, is not refunded if it is later reported, hidden or taken down, or the post is deleted.\n\nWhen a round of a post (public or private) or of a follow-up gets no answer from any Ree and no paid Ree waits for your agreement, the platform’s AI model first gives the asker a general answer from general knowledge, charging the asker {postBaseFee} credits (the base fee of a question, to the platform, nothing more); it is refunded in full if generation fails or times out, and it is not generated when the balance is too low, in which case the asker may generate it once by hand after topping up. On a public post, an AI general answer is first reviewed automatically like other public content; once it passes, everyone, including signed-out visitors, can see it. Before review, and if it does not pass, only the asker can see it, and its fee is not refunded. On a private post, only you can see it. An AI general answer does not count as any Ree’s answer, and the post stays under Unanswered; if a Ree answers later it is folded and kept, and its fee is not refunded. On a public post no Ree has answered, any signed-in user can ask follow-ups under its AI general answer: like other follow-ups they are public once they pass review, the AI answers them, and the fee is charged to whoever asked. RE0’s example posts, a Ree owner’s test questions and questions asked through MCP get no AI general answer.\n\nRE0 may post the example questions set on Rees that answer public posts as posts in RE0\'s name (marked as example questions), answered by related Rees and charged to no one.\n\nSigned-out visitors can browse public posts, answers and Rees, but must sign in to post, ask or follow up.',
    },
    s9: {
      title: 'Acceptable use',
      body: 'Do not use RE0 to infringe others’ rights, spread unlawful content, get around billing or rate limits, register accounts in bulk, or disrupt the service.',
    },
    s10: {
      title: 'Liability and changes',
      body: 'Answers are generated automatically from the knowledge you or the Ree’s owner provided and may be incomplete or wrong; check them against their citations. AI general answers are generated by a model from general knowledge, have no sources, do not represent any Ree or creator, are not guaranteed to be accurate, and are not medical, legal, financial, psychological or other professional advice. To the extent the law allows, RE0 is not liable for indirect losses, and its direct liability is limited to what you paid RE0 in the previous 12 months.\n\nChanges are published on this page, marked with the date of the last update. Questions: legal@re0.io.',
    },
  },
  privacy: {
    title: 'Privacy Policy',
    lede: 'This policy explains what RE0 collects, why, which providers process it, how long it is kept, and how you can see and delete your data.',
    s1: {
      title: 'What we collect',
      body: 'Account details: the email, display name, avatar, and account id Google or GitHub provide, plus the profile and language you set.\n\nYour knowledge and questions: files you upload, links and repositories you submit, text you paste, the extracted text and passages, and your questions (public posts, private posts, follow-ups and test questions), the Rees\' answers and AI general answers. Only you can see a private post and it is never made public; its question is sent to model providers to match Rees and write answers.\n\nPayment records: the transaction and subscription ids, amounts, currency, billing periods, and refund states Paddle reports back. We never receive or store card numbers.\n\nUsage records: your credit ledger, processing records, and the service logs we need.',
    },
    public: {
      title: 'Public content and visitors',
      body: 'Public posts: the question, details and anonymity setting of what you post, and your saves, helpful marks, reports and quotes. A public post can be seen by anyone, and the page of a post that passed review and shows an answer may be indexed by search engines; the pages of posts with no answer shown, taken down or in the trash are marked not to be indexed. An anonymous post does not show who you are, but we keep which account posted it. A post\'s question, details and answers are sent to model providers for automatic review, matching and answering.\n\nVisitors: signed-out visitors can browse public content but cannot ask. Before the redesign, visitors could ask free Rees on share pages; the text of those questions and answers stayed in the browser tab, was never stored on our servers and was never made public, and the keyed hashes of a browser identifier, a cookie id and the IP address kept with each day\'s counts to apply the daily limits have expired and been cleared. Which Ree answered each of those questions and when, without the content, is kept as a statistics record. When a visitor reports something, a keyed hash of their IP address identifies the reporter.\n\nRate limits: rate limits on signed-out requests (browsing posts and Rees, reporting and the like) count requests over short periods keyed on the raw IP address; these records are cleared within about 2 hours.',
    },
    s2: {
      title: 'Why we use it',
      body: 'To provide and improve the service, calculate and settle credits, process payments and refunds, prevent fraud and abuse, and meet legal obligations. We do not sell your personal information or use your knowledge to train models.',
    },
    s3: {
      title: 'Providers',
      body: 'Paddle (payments, tax, and invoices); Vercel (hosting and file storage); Neon (database); the model providers used for generation, embeddings, and audio transcription (through Vercel AI Gateway or an endpoint we configure; you are told before audio is sent for transcription); GitHub (private repositories, only after you authorize). Each processes data only as far as its service requires.',
    },
    s4: {
      title: 'Identity verification (KYC)',
      body: 'Purpose: only for the manual identity check before your first payout, to prevent impersonation and account takeover, and to meet legal and tax obligations around payments; for nothing else.\n\nWhat we collect: legal name, country or region, document type (passport, national ID, or residence permit), the document number’s last four digits, the document’s expiry date, a photo of the document, and a selfie holding it.\n\nStorage and access: the document photo and selfie are uploaded straight to private storage, never public or reachable by an ordinary link. Only authorized administrators can view them, through signed links that expire within 60 seconds, and every view is written to an audit log.\n\nRetention and deletion: 30 days after approval the original document photo and selfie are deleted automatically, keeping only the document type, last four digits, expiry date, reviewer, and review time. For submissions that are rejected or sent back for re-verification, the originals are deleted within 30 days of the decision. The verification and payout records kept are retained while your account exists and for the accounting and tax periods the law requires, then deleted.',
    },
    s5: {
      title: 'Tax information',
      body: 'Before a payout you choose the tax form that applies — W-9 for US tax residents, W-8BEN for non-US persons — and declare that you have submitted it; we keep the form type and the time of the declaration. We may report payments to tax authorities where the law requires. You remain responsible for declaring your income under your local law.',
    },
    s6: {
      title: 'Retention',
      body: 'Your account, knowledge, and posts (private posts included) are kept while your account exists. Knowledge and posts (public or private) moved to the trash are purged after 30 days, with their answers; when you clear your test questions, the finished ones are deleted at once. Old private conversations were deleted with the redesign. Posts taken down or not approved are kept under your account, and you can move them to the trash at any time. Payment, refund, and credit records are kept for the periods accounting and tax rules require. Requests to delete an account are handled by hand; make one as section 9 describes. Once it is handled, your public posts and their answers are removed; records the law requires us to keep (such as payment, refund and credit records) are kept for the periods it requires.',
    },
    s7: {
      title: 'Cookies',
      body: 'We use only the cookies needed to keep you signed in and remember your language and sidebar setting, plus, for visitors on share pages, one that records share-page visits for share statistics; no advertising or cross-site tracking cookies. Paddle’s checkout uses Paddle’s own cookies.',
    },
    s8: {
      title: 'Your rights',
      body: 'You can view, correct, or export your profile, delete knowledge and posts, or ask us to delete your account. Email legal@re0.io with privacy requests; we answer within 30 days. Please write from your account’s email so we can confirm it is you.',
    },
    s9: {
      title: 'Security and changes',
      body: 'Data is encrypted in transit and at rest; third-party credentials and authorization tokens are stored encrypted; the admin console requires a password and a one-time code, and administrators’ actions are audited. Changes to this policy are published on this page, marked with the date of the last update.',
    },
  },
};
