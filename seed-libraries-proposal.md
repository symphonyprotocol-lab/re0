# 平台库首批铺设方案：前 50 个库

- 版本：0.1
- 更新日期：2026-10-02
- 状态：待评审
- 依据：[requirement.md](./requirement.md) 第 5 节「平台知识库由 re0 官方创建、刷新、暂停和发布」；第 7.3 节「Website / llms.txt / OpenAPI 三类库创建前必须完成域名验证」

## 1. 为什么是这 50 个

第 7.3 节的域名验证规则决定了普通用户不能替厂商建库，所以公共目录的初始供给只能走平台库。这份清单回答的是：re0 官方在等到第一个发布者认领之前，自己先铺哪些。

每个库必须同时满足四条，缺一条就不进清单：

1. **版本差异真实存在**。同一个问题在两个版本下答案不同，这是 Context7「最新片段」模式结构上答不出的问题，也是全部发布素材的来源。
2. **许可允许再分发或明确可复用**。开源许可、公有领域、政府公开数据再利用政策，或 W3C / IETF 这类明确允许复制的文档许可。许可不清的进「待核」，不进首发。
3. **有机器可读的来源**。GitHub 仓库、OpenAPI 文件、带版本参数的官方 API，或可稳定抓取的官方站点。不靠人工整理。
4. **Context7 覆盖不到或覆盖不好**。要么根本不是代码库（法规、标准、基线），要么库名与内容无关，要么版本维度被它抹平了。

两个明确不做的方向：中文生态（产品决策），以及任何需要登录才能看到的合作伙伴门户（MVP 不做未授权抓取，这类库只能等厂商自己来认领发布）。

## 2. 明确不铺的库和原因

| 库 | 原因 |
| --- | --- |
| PCI DSS、CIS Benchmarks | 版权方禁止再分发，只能由版权方认领发布 |
| ISO 13485、ISO 27001 等 ISO 标准 | 付费版权文本 |
| IFRS、US GAAP（ASC） | 付费版权文本 |
| SNOMED CT、LOINC | 需要注册许可，分发条款不满足公共库要求 |
| Shopify、Salesforce 等厂商文档站 | 文档站版权归厂商，无开源许可；等认领 |
| React、Next.js、Prisma 等开源框架文档 | Context7 的主战场，正面硬拼没有意义 |
| Anthropic、OpenAI 的 API 文档 | 同上，且 Context7 覆盖得很好 |

## 3. 清单

许可列的含义：**开源** = 仓库带 OSI 许可；**公有领域** = 美国联邦政府作品；**官方可复用** = 发布方有明确的复用政策（EUR-Lex 的 2011/833/EU 决定、UK Open Government Licence、W3C Document License、IETF Trust 条款）；**待核** = GitHub 显示 NOASSERTION 或无许可文件，上线前要人工确认。

### 3.1 支付与开放金融 API（9 个）

差异化依据：API 版本以日期或 vN 命名，字段在版本间增删改名，集成商最常问的就是「我这个版本下这个字段还在不在」。Context7 没有版本轴，只能给最新片段。

| # | 库 | 来源 / 接入方式 | 许可 | 版本轴与代表性问题 |
| --- | --- | --- | --- | --- |
| 1 | Stripe API | `stripe/openapi`（GitHub，OpenAPI） | 开源 MIT | 按日期版本（`2024-06-20`、`2025-03-31.basil` 等）。「`invoice.subscription` 在 basil 版里去哪了」 |
| 2 | Adyen Checkout API | `Adyen/adyen-openapi`（GitHub，每个版本独立 OpenAPI 文件） | 开源 MIT | Checkout v68 / v69 / v70 / v71 并存。「v70 的 `/payments` 请求和 v68 差哪些字段」 |
| 3 | Plaid API | `plaid/plaid-openapi`（GitHub，OpenAPI） | 待核（仓库无许可文件） | 日期版本 `2020-09-14` 及更早。「`/transactions/get` 和 `/transactions/sync` 什么时候该用哪个」 |
| 4 | Square API | `square/connect-api-specification`（GitHub，OpenAPI） | 开源 Apache-2.0 | 按日期版本，每月发布。「某个日期版之后 Catalog 对象的字段变化」 |
| 5 | PayPal REST API | `paypal/paypal-rest-api-specifications`（GitHub，OpenAPI） | 开源 Apache-2.0 | v1 Payments 与 v2 Orders 并存。「v1 的 `sale` 在 v2 对应什么」 |
| 6 | UK Open Banking Read/Write API | `OpenBankingUK/read-write-api-specs`（GitHub，OpenAPI） | 待核（仓库无许可文件，规范本身公开） | v3.1.x 与 v4.0。「v4 对日期时间和 ISO 20022 对齐改了什么」 |
| 7 | Australia Consumer Data Standards | `ConsumerDataStandardsAustralia/standards`（GitHub） | 待核（NOASSERTION，官方声明 MIT） | 每个 release 带义务生效日期。「某条义务从哪个版本、哪一天开始强制」 |
| 8 | Open Finance Brasil | `OpenBanking-Brasil/areadesenvolvedor`（GitHub）；仓库 2023 年后未更新，需确认是否迁移 | 待核 | 阶段与版本并行。首发前先确认当前权威仓库 |
| 9 | GitHub REST API | `github/rest-api-description`（GitHub，OpenAPI，含 GHES 各版本） | 开源 MIT | `X-GitHub-Api-Version: 2022-11-28` 与 GHES 3.13 到 3.17 各一份。「这个端点在 GHES 3.14 有没有」 |

### 3.2 云与基础设施 API（5 个）

差异化依据：`api-version` 或发行版是一等参数，弃用和移除按版本发生。

| # | 库 | 来源 / 接入方式 | 许可 | 版本轴与代表性问题 |
| --- | --- | --- | --- | --- |
| 10 | Azure REST API Specs | `Azure/azure-rest-api-specs`（GitHub，按资源提供者和 api-version 分目录的 OpenAPI） | 开源 MIT | 每个资源提供者多个日期版 api-version。「Microsoft.Compute 哪个 api-version 开始支持某属性」 |
| 11 | Kubernetes API | `kubernetes/kubernetes` 的 `api/openapi-spec`（GitHub，按 release 分支） | 开源 Apache-2.0 | 1.28 到 1.34。「flowcontrol v1beta3 哪个版本移除」 |
| 12 | Docker Engine API | `moby/moby` 的 `api/swagger.yaml`（GitHub，按版本） | 开源 Apache-2.0 | v1.43 到 v1.5x。「某字段哪个 API 版本开始不再返回」 |
| 13 | Cloudflare API | `cloudflare/api-schemas`（GitHub，OpenAPI） | 开源 BSD-3-Clause | 单一 v4 但 schema 持续变化，以 re0 快照日期为版本。差异化弱于其他项，放第三批 |
| 14 | GitLab REST API | GitLab 仓库内 `doc/api/openapi/openapi.yaml`（OpenAPI） | 文档 CC BY-SA 4.0，上线前确认 | 按 17.x / 18.x 大版本。「这个端点哪个大版本弃用」 |

### 3.3 协议与开放标准（12 个）

差异化依据：标准的版本差异就是用户的全部问题，而且这些文本不是代码库，Context7 要么不收，要么只收了配套 SDK 的 README。

| # | 库 | 来源 / 接入方式 | 许可 | 版本轴与代表性问题 |
| --- | --- | --- | --- | --- |
| 15 | Model Context Protocol 规范 | `modelcontextprotocol/modelcontextprotocol`（GitHub，按日期版本目录） | 待核（NOASSERTION，规范声明 MIT） | `2024-11-05`、`2025-03-26`、`2025-06-18` 及后续。「Streamable HTTP 哪个版本替代 HTTP+SSE」。目标用户就是 Agent 开发者，首发必上 |
| 16 | A2A 协议 | `a2aproject/A2A`（GitHub） | 开源 Apache-2.0 | 0.2 与 0.3。「gRPC 绑定哪个版本加入」 |
| 17 | OpenAPI Specification | `OAI/OpenAPI-Specification`（GitHub，按版本文件） | 开源 Apache-2.0 | 3.0.x / 3.1 / 3.2。「`nullable` 在 3.1 怎么写」 |
| 18 | AsyncAPI | `asyncapi/spec`（GitHub） | 开源 Apache-2.0 | 2.6 与 3.0。「3.0 为什么把 operation 从 channel 拆出来」 |
| 19 | JSON Schema | `json-schema-org/json-schema-spec`（GitHub） | 待核（NOASSERTION） | draft-07 / 2019-09 / 2020-12。「`items` 数组形式在 2020-12 变成什么」 |
| 20 | OpenTelemetry 规范与语义约定 | `open-telemetry/opentelemetry-specification` 与 `open-telemetry/semantic-conventions`（GitHub） | 开源 Apache-2.0 | 语义约定按版本改名。「`http.method` 什么时候变成 `http.request.method`」 |
| 21 | OAuth 2.0 / 2.1 与 OpenID Connect | IETF RFC Editor（RFC 6749、6750、7636、9700）、`oauth-wg/oauth-v2-1` 草案、OpenID Foundation 规范页 | IETF Trust 条款允许复制；OIDF 规范允许复制 | 2.0 与 2.1 草案。「2.1 删掉了哪些授权类型」 |
| 22 | HTTP 语义 RFC | IETF RFC Editor（RFC 9110 到 9114 及被废止的 7230 到 7235） | IETF Trust | 新旧 RFC 并存。「某条规则在 9110 里的措辞和 7231 的区别」 |
| 23 | WCAG 与 WAI-ARIA | `w3c/wcag`（GitHub）与 W3C TR 页面 | 官方可复用（W3C Document License，禁改动，分块是否构成改动需法务确认） | 2.0 / 2.1 / 2.2。「4.1.1 Parsing 在 2.2 怎么处理了」 |
| 24 | WebAuthn | `w3c/webauthn`（GitHub） | 同上 | Level 1 / 2 / 3。「某扩展哪个 Level 引入」 |
| 25 | SPDX | `spdx/spdx-spec`（GitHub） | 待核（规范声明 CC-BY-3.0） | 2.2 / 2.3 / 3.0。「3.0 的 Element 模型对应 2.3 的什么」 |
| 26 | CycloneDX | `CycloneDX/specification`（GitHub） | 开源 Apache-2.0 | 1.4 / 1.5 / 1.6。「ML-BOM 字段哪个版本加入」 |

### 3.4 安全与合规基线（9 个）

差异化依据：全是公有领域或开放许可，版本间控制项编号和措辞变化是合规团队每天在对的东西，而且库名（「800-53」）和内容毫无关系，正好用上内容路由。

| # | 库 | 来源 / 接入方式 | 许可 | 版本轴与代表性问题 |
| --- | --- | --- | --- | --- |
| 27 | NIST SP 800-53 | `usnistgov/oscal-content`（GitHub，OSCAL JSON） | 公有领域 | Rev 4 与 Rev 5。「AC-2 在 Rev 5 多了哪些增强项」 |
| 28 | NIST Cybersecurity Framework | NIST 官网 PDF 与 CSF 2.0 的 JSON 导出 | 公有领域 | 1.1 与 2.0。「Govern 功能下有哪些类别」 |
| 29 | NIST SP 800-63 数字身份指南 | NIST 官网，`usnistgov/800-63-4` 仓库 | 公有领域 | -3 与 -4。「-4 对密码复杂度规则的要求变成什么」 |
| 30 | NIST SP 800-171 | NIST 官网 PDF 与 OSCAL | 公有领域 | Rev 2 与 Rev 3。「Rev 3 合并或撤回了哪些要求」 |
| 31 | FedRAMP 基线 | FedRAMP 官网与 GSA 仓库（原 `GSA/fedramp-automation` 已不可达，需确认新位置） | 公有领域 | Rev 4 / Rev 5 / 20x。首发前确认来源 |
| 32 | OWASP ASVS | `OWASP/ASVS`（GitHub） | 开源 CC-BY-SA-4.0 | 4.0.3 与 5.0。「5.0 把某章节编号改成了什么」 |
| 33 | OWASP Top 10 | `OWASP/Top10`（GitHub） | 待核（NOASSERTION，站点声明 CC BY-SA） | 2017 / 2021 / 2025。「2025 新增和合并了哪些类别」 |
| 34 | MITRE ATT&CK | `mitre-attack/attack-stix-data`（GitHub，STIX JSON） | 待核（MITRE 条款允许带署名使用） | v14 到 v18。「v18 对 detection 的结构调整」 |
| 35 | CISA KEV 目录 | `cisagov/kev-data`（GitHub，JSON，每日更新） | 公有领域 | 以日期快照为版本。「某 CVE 哪天入目录、截止日期是什么」 |

### 3.5 监管法规（12 个）

差异化依据：法规文本有官方的时点版本机制（eCFR 的 versioner API、EUR-Lex 的 consolidated 版本、legislation.gov.uk 的 point-in-time），这正是 re0「不可变版本 + 章节级引用」的天然对应物。Context7 完全不在这个领域。

接入方式说明：这三个来源都不是 GitHub 或 OpenAPI，需要一个小的转换脚本把官方 XML 或 HTML 按条款拆成 Markdown 后以上传方式入库，并把官方版本日期映射为 re0 Version。这是本方案唯一的工程前置项。

| # | 库 | 来源 / 接入方式 | 许可 | 版本轴与代表性问题 |
| --- | --- | --- | --- | --- |
| 36 | HIPAA 隐私与安全规则 | eCFR API，45 CFR Parts 160、164 | 公有领域 | eCFR 按日期的时点版本。「安全规则某条在修订提案前后的差异」 |
| 37 | FDA 21 CFR Part 11 与 Part 820 | eCFR API | 公有领域 | Part 820 在 2026-02-02 被 QMSR 替换，引用 ISO 13485（ISO 文本本身不入库）。「QMSR 生效后 820.30 设计控制去哪了」 |
| 38 | COPPA 规则 | eCFR API，16 CFR Part 312 | 公有领域 | 2025 年修订版。「新规对第三方披露同意的要求」 |
| 39 | CCPA / CPRA 实施细则 | 加州 CPPA 官网发布的法规文本 | 州法规，公开 | 2023 版与 2025 年 ADMT 修订。「自动化决策技术的新义务」 |
| 40 | GDPR | EUR-Lex，Regulation (EU) 2016/679 | 官方可复用（2011/833/EU） | 原文与 consolidated 版。作为欧盟法规库的锚点 |
| 41 | EU AI Act | EUR-Lex，Regulation (EU) 2024/1689 及配套指南 | 官方可复用 | 分阶段适用日期。「高风险系统义务哪天开始适用」 |
| 42 | DORA | EUR-Lex，Regulation (EU) 2022/2554 及 RTS | 官方可复用 | 一级法规与二级 RTS 并存。「ICT 第三方风险的 RTS 要求」 |
| 43 | NIS2 | EUR-Lex，Directive (EU) 2022/2555 | 官方可复用 | 指令与各国转化并存，MVP 只收指令原文 |
| 44 | MiCA | EUR-Lex，Regulation (EU) 2023/1114 | 官方可复用 | 分阶段适用。「稳定币条款与其他条款的生效日期差」 |
| 45 | Cyber Resilience Act | EUR-Lex，Regulation (EU) 2024/2847 | 官方可复用 | 报告义务 2026-09 先于全面适用。「现在哪些义务已经生效」 |
| 46 | EU Data Act | EUR-Lex，Regulation (EU) 2023/2854 | 官方可复用 | 2025-09 开始适用。「云切换条款的过渡期」 |
| 47 | UK GDPR 与 Data (Use and Access) Act 2025 | legislation.gov.uk，带 point-in-time 版本 | 官方可复用（OGL v3） | 修订前后时点版本。「DUAA 对合法利益的修改」 |

### 3.6 医疗与健康数据标准（3 个）

差异化依据：版本并存是常态（R4 与 R5 同时在生产），年度码表更新是硬需求。

| # | 库 | 来源 / 接入方式 | 许可 | 版本轴与代表性问题 |
| --- | --- | --- | --- | --- |
| 48 | HL7 FHIR | `HL7/fhir`（GitHub）与 hl7.org/fhir 各版本站点 | CC0（仓库 NOASSERTION，规范声明 CC0） | R4 / R4B / R5 / R6 ballot。「Observation 在 R5 新增的元素」 |
| 49 | US Core 实施指南 | HL7 IG 发布站点 | CC0 | 6.1 / 7.0 / 8.0。「某 Profile 的 must-support 在 8.0 的变化」 |
| 50 | ICD-10-CM | CMS 官网年度下载包（XML / 文本），上传入库 | 公有领域 | FY2025 与 FY2026。「某编码在新财年被拆分成什么」 |

## 4. 上线顺序

三批，每批先跑完第 6 节的检查再发。

**首发 10 个**（demo 和发布素材全部从这里出）：Stripe、Adyen、GitHub REST、Azure、Kubernetes、MCP 规范、OpenAPI 规范、NIST 800-53、HIPAA、FHIR。选择理由：许可最干净、版本差异最直观、覆盖了六个赛道各至少一个，而且这十个库的目标用户彼此不重叠，能同时试探六个方向的查询量。

**第二批 20 个**：其余支付与开放金融、其余协议标准、NIST 系列、OWASP 两项、GDPR、AI Act、DORA、ICD-10-CM。

**第三批 20 个**：其余欧盟法规、UK、CCPA、COPPA、ATT&CK、KEV、Cloudflare、GitLab、US Core，以及第二批上线后查询日志里反复出现但目录没有的库。

## 5. Library ID 与版本命名

- Library ID 用 `/<发布方>/<库>`，发布方用官方域名或组织名的小写形式，例如 `/stripe/api`、`/nist/sp-800-53`、`/eur-lex/ai-act`。认领时发布方名下的所有平台库整体转移。
- re0 Version 的 `label` 直接采用来源自己的版本标识：Stripe 用 `2025-03-31.basil`，Kubernetes 用 `v1.32`，eCFR 用时点日期，EUR-Lex 用 consolidated 日期，无版本概念的（KEV、Cloudflare）用快照日期。不自造版本号。
- `resolve-library-id` 的候选证据里必须带每个版本的 label 列表，让 Agent 一轮就能决定「用哪个版本」，否则版本轴就白做了。

## 6. 每个库上线前的检查

1. 许可确认：开源许可文件存在，或政府再利用政策条款可引用，或 W3C / IETF 条款可引用。「待核」项没有结论不上。
2. 至少两个版本成功入库，且至少写出三个「两版答案不同」的问题，答案能在两版的引用里分别找到。写不出三个，说明版本轴不成立，降级到第三批或移除。
3. `resolve-library-id` 用自然语言问题（不含库名）能把这个库排进前三。排不进说明内容路由对它失效，先修路由再上。
4. 刷新策略已配置：GitHub 来源按 release 或 tag 触发，eCFR / EUR-Lex 按官方时点日期轮询，KEV 按日。

## 7. 待核事项

- 8 个「待核」许可：Plaid、UK Open Banking、AU CDS、Open Finance Brasil、MCP、JSON Schema、OWASP Top 10、ATT&CK、SPDX。预计多数能过，但要逐个留下结论。
- W3C Document License 禁止修改，按章节分块并单独返回是否构成「修改」需要法务判断。判断为否才能上 WCAG、WebAuthn。
- FedRAMP 和 Open Finance Brasil 的权威仓库位置需重新确认。
- eCFR、EUR-Lex、legislation.gov.uk 三个转换脚本是第二批的前置工程项，第一批里只有 HIPAA 依赖它，可以先手工跑一次。
