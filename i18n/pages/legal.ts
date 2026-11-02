import type { Shape } from '@/i18n/format';

/**
 * `/legal/terms` and `/legal/privacy`. The privacy notice states what
 * rebuild-proposal.md 2.3 requires before payouts open: what identity
 * documents are for, how long they are kept, when they are deleted, and the
 * tax information we collect. Paragraphs are separated by blank lines.
 */
export const zh = {
  updated: '最近更新：2026 年 11 月 2 日',
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
      body: 'RE0 的所有消耗以 credit 计，1 credit = 0.0001 美元（10 美元 = 100,000 credits）。Credits 是预付的使用额度，不是货币，不能转让，除第 7 节所述的收入 credits 外不能兑换为现金。\n\n新用户注册赠送 2,000 credits，不过期。消耗的先后顺序为：当期 Plan → 注册赠送 → Pack → 收入 credits；退还时按相反顺序退回。余额不足时操作会被拒绝，不会透支。',
    },
    s3: {
      title: 'Plan 与 Pack',
      body: 'Plan 为每月 10 美元的订阅，每个计费周期到账 100,000 credits，仅在当期有效，周期结束时未用完的部分作废。Plan 按月自动续费，你可以随时在「余额与计费」中关闭续费；关闭后当期 credits 仍可使用至周期末，之后不再扣款，也不再到账。\n\nPack 为 10 美元一份的一次性购买，每份 100,000 credits，一次可买 1 到 10 份，永不过期。只有 Plan 订阅在有效期内的用户可以购买 Pack；Plan 取消或到期后，已购买的 Pack 仍可使用。',
    },
    s4: {
      title: '付款与 Paddle',
      body: '付款由 Paddle.com 作为经销商（merchant of record）处理，Paddle 负责收款、开具发票并依法计算和代缴税费，结账时适用 Paddle 的买家条款。RE0 不接触也不保存你的银行卡信息。显示的价格不含税，税费在结账时计算。',
    },
    s5: {
      title: '退款与拒付',
      body: '退款通过 Paddle 处理，可发送邮件至 support@re0.io 申请。退款或拒付生效后，对应购买所到账的 credits 按退款比例收回：先从该笔购买尚未使用的额度中收回，再从你的其他余额中收回。余额不会因此变为负数；已经用掉、无法收回的部分记为待抵扣额度，从你下一次到账的 credits 中优先扣除。',
    },
    s6: {
      title: '消耗与结算',
      body: '向 Ree 提问时，每个实际作答的 Ree 收取 20 credits 基本使用费，提问他人的 Ree 时另付该 Ree 主设定的查询费；没有相关知识、未作答的不收费。处理知识时按文件大小预先冻结额度，处理完成后按每 1,000 字符 1 credit（音频另加每分钟 100 credits）结算，多退少不补；处理失败全额退回。各项价格见价格页，价格调整会提前公布。',
    },
    s7: {
      title: '收入 credits 与提现',
      body: '他人向你的 Ree 提问时支付的查询费，全额计入你的收入 credits。收入 credits 不过期，可用于你自己的消耗；累计达到 500,000 credits（50 美元）后可申请提现。首次提现前须通过人工身份验证并提交税务信息声明，收款方式为你本人的 PayPal 账户，PayPal 手续费由提现人承担。Plan、Pack 与注册赠送的 credits 不能提现。你需自行承担所得相关的纳税义务。',
    },
    s8: {
      title: '知识与内容',
      body: '你只能添加你有权使用的知识。整站抓取前须完成域名确权，私有仓库须经你的 GitHub 授权。你保留所添加内容的权利，并授予 RE0 为提供服务所需的处理许可（解析、转写、向量化与生成回答）。公开的 Ree 只展示简介与来源数量，回答中的引用只展示相关片段。违反法律或本条款的公开内容可能被管理员转为私有。',
    },
    s9: {
      title: '可接受使用',
      body: '不得利用 RE0 侵犯他人权利、传播违法内容、绕过计费或限频、批量注册账号，或干扰服务的正常运行。',
    },
    s10: {
      title: '责任限制与条款变更',
      body: 'Ree 的回答基于你或 Ree 主提供的知识自动生成，可能不完整或有误，请结合引用自行判断。在法律允许的范围内，RE0 对间接损失不承担责任，直接责任以你在过去 12 个月内向 RE0 支付的金额为限。\n\n条款变更会在本页更新并标明日期；重大变更会在站内提前通知。对条款有疑问，请联系 legal@re0.io。',
    },
  },
  privacy: {
    title: '隐私政策',
    lede: '本政策说明 RE0 收集哪些信息、用于什么目的、交给哪些服务商处理、保留多久，以及你可以如何查看与删除自己的数据。',
    s1: {
      title: '我们收集的信息',
      body: '账号信息：Google 或 GitHub 提供的邮箱、显示名称、头像与账号标识，以及你在设置中修改的资料与语言。\n\n你的知识与对话：你上传的文件、提交的链接与仓库、粘贴的文本、处理后的正文与检索片段，以及你的提问和 Ree 的回答。\n\n付款记录：Paddle 回传的交易号、订阅号、金额、币种、计费周期与退款状态。我们不接收也不保存银行卡号。\n\n使用记录：credit 流水、处理记录与必要的服务日志。',
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
      body: '账号存续期间保留你的账号、知识与对话。移到回收站的知识与对话 30 天后清除。付款、退款与 credit 流水按会计与税务法规要求的期限保存。删除账号后，除法律要求保存的记录外，其余数据会在 30 天内删除。',
    },
    s7: {
      title: 'Cookie',
      body: '我们只使用维持登录与记住界面语言、侧栏状态所必需的 Cookie，不使用广告或跨站追踪 Cookie。Paddle 结账窗口会使用 Paddle 自己的 Cookie。',
    },
    s8: {
      title: '你的权利',
      body: '你可以查看、更正或导出自己的资料，删除知识与对话，或申请删除账号。发送邮件至 legal@re0.io 提出隐私相关请求，我们会在 30 天内答复；涉及账号的请求请使用注册邮箱发送，以便核对身份。',
    },
    s9: {
      title: '安全与变更',
      body: '数据在传输与存储时加密，第三方 API 凭据与授权令牌加密保存，管理后台需要密码与动态验证码，管理员的操作有审计记录。本政策变更会在本页更新并标明日期，重大变更会在站内提前通知。',
    },
  },
};

export const en: Shape<typeof zh> = {
  updated: 'Last updated: November 2, 2026',
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
      body: 'Everything on RE0 is charged in credits: 1 credit = USD 0.0001 (USD 10 = 100,000 credits). Credits are prepaid usage, not money; they cannot be transferred and, except for earned credits under section 7, cannot be exchanged for cash.\n\nNew users receive 2,000 welcome credits that do not expire. Credits are spent in this order: current Plan → welcome → Pack → earned; returns go back in reverse order. When the balance is too low, the action is refused; nothing is overdrawn.',
    },
    s3: {
      title: 'Plan and Pack',
      body: 'The Plan is a USD 10 monthly subscription that credits 100,000 credits each billing cycle, valid only for that cycle; whatever is unused expires at its end. The Plan renews monthly; you can turn renewal off at any time under Credits & billing. The current cycle’s credits remain usable until it ends; after that you are not charged and receive no further credits.\n\nA Pack is a one-time purchase of USD 10 for 100,000 credits that never expire, 1 to 10 per checkout. Packs are sold only while your Plan is active; Packs you bought remain usable after the Plan ends.',
    },
    s4: {
      title: 'Payment and Paddle',
      body: 'Payments are processed by Paddle.com as merchant of record: Paddle takes the payment, issues invoices, and calculates and remits taxes as required, and Paddle’s buyer terms apply at checkout. RE0 never sees or stores your card details. Prices exclude tax, which is calculated at checkout.',
    },
    s5: {
      title: 'Refunds and chargebacks',
      body: 'Refunds are handled through Paddle; email support@re0.io to request one. Once a refund or chargeback takes effect, the credits that purchase added are taken back in proportion to the refund: first from what is left of that purchase, then from the rest of your balance. Your balance never goes below zero; the part already spent is recorded as an amount owed and deducted first from the next credits you receive.',
    },
    s6: {
      title: 'Usage and settlement',
      body: 'Each Ree that actually answers a question charges a 20-credit base fee; asking someone else’s Ree adds the query fee its owner set. An unanswered question costs nothing. Processing knowledge reserves credits by file size first, then settles at 1 credit per 1,000 characters (plus 100 credits per minute of audio); any excess reserved is returned, a shortfall is not charged, and a failure is refunded in full. Prices are listed on the pricing page; changes are announced in advance.',
    },
    s7: {
      title: 'Earned credits and payouts',
      body: 'Query fees others pay to ask your Rees become your earned credits in full. Earned credits do not expire and can be spent like any credits; once you have at least 500,000 (USD 50) you may request a payout. Before the first payout you must pass a manual identity check and submit a tax declaration; payouts go to your own PayPal account, and PayPal fees are borne by you. Plan, Pack, and welcome credits cannot be withdrawn. You are responsible for any taxes on your earnings.',
    },
    s8: {
      title: 'Knowledge and content',
      body: 'Add only knowledge you have the right to use. Whole-website crawls require a verified domain; private repositories require your GitHub authorization. You keep your rights to what you add and grant RE0 the processing needed to provide the service (parsing, transcription, embedding, and answer generation). Public Rees show only their description and how many sources they have; citations show only relevant excerpts. Public content that breaks the law or these terms may be made private by an administrator.',
    },
    s9: {
      title: 'Acceptable use',
      body: 'Do not use RE0 to infringe others’ rights, spread unlawful content, get around billing or rate limits, register accounts in bulk, or disrupt the service.',
    },
    s10: {
      title: 'Liability and changes',
      body: 'Answers are generated automatically from the knowledge you or the Ree’s owner provided and may be incomplete or wrong; check them against their citations. To the extent the law allows, RE0 is not liable for indirect losses, and its direct liability is limited to what you paid RE0 in the previous 12 months.\n\nChanges are published on this page with a date; material changes are announced in the app beforehand. Questions: legal@re0.io.',
    },
  },
  privacy: {
    title: 'Privacy Policy',
    lede: 'This policy explains what RE0 collects, why, which providers process it, how long it is kept, and how you can see and delete your data.',
    s1: {
      title: 'What we collect',
      body: 'Account details: the email, display name, avatar, and account id Google or GitHub provide, plus the profile and language you set.\n\nYour knowledge and conversations: files you upload, links and repositories you submit, text you paste, the extracted text and passages, and your questions and the answers.\n\nPayment records: the transaction and subscription ids, amounts, currency, billing periods, and refund states Paddle reports back. We never receive or store card numbers.\n\nUsage records: your credit ledger, processing records, and the service logs we need.',
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
      body: 'Your account, knowledge, and conversations are kept while your account exists. Knowledge and conversations moved to the trash are purged after 30 days. Payment, refund, and credit records are kept for the periods accounting and tax rules require. When you delete your account, everything else is deleted within 30 days.',
    },
    s7: {
      title: 'Cookies',
      body: 'We use only the cookies needed to keep you signed in and remember your language and sidebar setting; no advertising or cross-site tracking cookies. Paddle’s checkout uses Paddle’s own cookies.',
    },
    s8: {
      title: 'Your rights',
      body: 'You can view, correct, or export your profile, delete knowledge and conversations, or ask us to delete your account. Email legal@re0.io with privacy requests; we answer within 30 days. Please write from your account’s email so we can confirm it is you.',
    },
    s9: {
      title: 'Security and changes',
      body: 'Data is encrypted in transit and at rest; third-party credentials and authorization tokens are stored encrypted; the admin console requires a password and a one-time code, and administrators’ actions are audited. Changes to this policy are published on this page with a date; material changes are announced in the app beforehand.',
    },
  },
};
