# re0 链上存证能力评审提案

- 版本：1.3
- 更新日期：2026-09-10
- 状态：**已通过评审，进入 MVP 基线**
- 产品规则摘要：[requirement.md](./requirement.md) 第 6.4 节；实现顺序见第 15 节第 11–12 步
- 与 0.5 版的差异：Anchor Signer 托管由平台环境变量改为**云 KMS 托管签名**，第 0.1 节的密钥托管升级条款因此在上线前即已满足，Earning Anchor 不再被阻塞
- 与 1.0 版的差异：Anchor Signer 托管由云 KMS **改回平台环境变量直接持有私钥**；1.0 版「不得退回环境变量方案」的禁令解除，第 0.1 节相应新增私钥泄露条目并记录其更重的处置代价，第 4.11.1 节门禁 1 改为轮换演练
- 与 1.1 版的差异（1.2）：**整体按「旁路系统应当可随时移除」的原则收敛**。存证不再有任何产品界面与后台界面，配置收拢到第 4.7 节那九项，第 4.9 节由「配置驱动的自动告警」改为「链上读数 + 少数不依赖配置的告警」。这是一次**安全姿态的下调**，理由与代价见第 4.9 节
- 与 1.2 版的差异（1.3）：**门禁 2、4、8 被明示豁免**——不交付第二份独立实现、不设独立的 Upgrade Authority、不指定巡检人。作为对冲，**合约改为 `immutable` 发布，不再保留升级能力**（第 4.5 节）。两者的净效果与代价见第 0.2 节
- 关联文档：[requirement.md](./requirement.md)、[architecture.md](./architecture.md)

## 0. 已决事项

以下各项已经决策，本文其余部分按此展开，不再作为待决问题：

| 决策 | 结论 | 主要后果 |
| --- | --- | --- |
| 起步网络 | **直接主网**，不做测试网先行 | 第一天起产生真实成本；锚定不可撤销，因此上线前门禁加严，见第 4.11 节 |
| 合约可升级性 | **不保留**（1.3 版）：以 `immutable` 发布 | 没有升级密钥，也没有升级；轮换签名账户与修复合约缺陷都只能靠发布新的 Code Object 并重锚，见第 4.5 节 |
| ~~升级授权形态~~ | 1.3 版起不适用：没有升级能力，也就没有升级授权 | — |
| 外部合约审计 | **不做**，只做内部评审 | 合约缺陷只由内部评审兜底；1.3 版取消了公开 Verifier 的交叉实现，见第 4.11 节门禁 2 |
| 公开 Verifier | **不交付**（1.3 版） | 编码规格公开（第 4.2.1 节）、原像随接口返回（第 5 节），任何第三方都可自行实现；平台不提供、也不保证存在一份 |
| ~~Upgrade Authority~~ | 1.3 版起不适用：没有升级能力 | — |
| 节点接入 | **Aptos Build 官方托管 API**，稳定后再加第三方故障转移 | 每天约 25 笔交易，免费额度足够；见第 4.12 节 |
| 事件监控接入 | **与写入路径使用不同凭据，必要时不同供应商** | 监控是密钥失陷的唯一检测手段，不能与写入共享故障域 |
| Anchor Signer 托管 | **平台环境变量直接持有私钥**，不引入 KMS 或托管签名服务 | 接入成本为零，代价是私钥泄露的处置远重于凭据吊销，见第 0.1 节与第 4.6 节 |
| 锚定对象范围 | Version Anchor、Audit Anchor、**Earning Anchor（发布者账期结算单）** | 第 4.6 节的密钥托管前置已满足，Earning Anchor 可按第 8 节阶段 F 正常排期 |

### 0.1 已接受风险

以下风险由上述决策直接产生，评审时应作为整体一并批准：

| 风险 | 影响面 | 为什么可接受 |
| --- | --- | --- |
| 无外部审计 | 合约缺陷可能上线后才发现 | 合约面极小、无资金、无用户资产；`compatible` 策略禁止破坏性升级；缺陷可用第 4.5.1 节的重锚路径修复 |
| Anchor Signer 私钥泄露 | 攻击者可用合法签名账户伪造或阻断后续锚定 | 改不了已发出的历史 Event；触不到用户数据、知识库内容、额度和资金；账户只保留 Gas 余额，年耗约 0.3 APT。**但处置代价必须写明**：失陷的是私钥本身而非可吊销的凭据，因此必须更换 Aptos 账户；签名地址在合约里编译期绑定（第 4.6 节），而包是 `immutable`，所以换账户意味着**发布一个新的 Code Object**、把环境指过去、重新锚定。检测面见第 0.2 节 |

上述风险的共同上界是：**任何一项发生，都不会导致已锚定历史不可验证，也不会影响 re0 主链路的可用性和用户数据安全。** 若链上出现任何形式的资金流转，本节结论全部失效，必须重新评审。

### 0.2 1.3 版豁免三条门禁后的实际风险

1.3 版取消了门禁 2、4、8。三条各自都可以论证，合起来会改变上一段那个上界的成色，所以要单独写明：

**一把私钥拥有全部权力（已由 `immutable` 收回）。** 不单设 Upgrade Authority 本来意味着同一个账户既提交锚定又持有 Code Object，而这把私钥就放在环境变量里（第 4.6 节）——泄露即等于取得合约的完全控制权。1.1 版称两把密钥的分离是「单密钥方案里唯一仍然生效的结构性防护」。改为 `immutable` 之后这条防护不再必要：包不可变更，对象的归属也就不再有任何后果。

**没有人被指定去看。** 取消巡检人之后，链上读数仍然存在，但不再有任何机制或职责保证有人查看。上面那种失陷，因此在实践上接近**不可被发现**——直到有人恰好去看，或者外部有人告诉我们。

**没有第二份实现。** Merkle 构造与 Proof 校验只有一份代码，它自己测自己。一处构造缺陷不会被我们的测试发现，因为产出与校验共用同一段有缺陷的逻辑；它只会在某个外部实现者尝试校验时暴露。

**这三条合起来的意思是**：签名密钥失陷的影响面从「伪造或阻断后续锚定」扩大到「取得合约的完全控制权」，而检出它的手段从「自动告警」经「人工巡检」降到「无」。上一段那个上界仍然成立——**已锚定的历史 Event 谁也改不了，用户数据、知识库内容、额度和资金一概触不到**——但在那个上界之内，锚定这套机制对攻击者的抵抗力已经很低。

**1.3 版同时采取了对冲：合约改为 `immutable` 发布。** 升级能力不存在之后，上面第一条里最严重的两项——发布一个删掉鉴权断言的版本、把 Code Object 转走——都不再有后果，因为没有人能向一个 `immutable` 的包发布任何东西，对象归谁也就无所谓了。剩下的影响面回到「用被盗的密钥伪造或阻断后续锚定」，与 1.1 版的判断一致。

代价同样要写明：**签名地址编译期绑定，而轮换过去是靠一次升级完成的，现在做不到了。** 密钥被盗后的处置变成「发布一个新的 Code Object、把环境指过去、重新锚定」；旧对象下的锚定仍然有效，因此校验方最终要持有一组 Code Object 地址，而不只是一组签名地址。合约本身若被发现缺陷，处置办法相同，且没有别的办法——这把第 4.11 节门禁 3 的内部评审从「应该做」变成了「唯一的一次机会」。

发布者分成的**结算单存证**（第 2.1 节 Earning Anchor）不构成资金流转：链上只有加盐摘要，没有转账、没有余额、没有任何资产，出账仍全程由外部支付服务完成。因此本节结论在加入 Earning Anchor 后继续成立。

Earning Anchor 触发第 4.6 节的密钥托管硬性升级条款，该条款在本版**被明示豁免**。豁免的理由不是原判断被推翻——该密钥确实能伪造或阻断与钱直接相关的证据，影响面确实超出纯内容锚定，这一点在 1.0 版怎么写，在本版仍然成立；豁免的理由是评审在知情的前提下接受了它，换取零接入成本。因此 Earning Anchor 不再等待密钥托管升级，按第 8 节阶段 F 正常排期，其密钥侧保障改由两件事承担：第 4.11.1 节门禁 1 的轮换演练（含一次合约升级），以及第 4.9 节不得关闭的非预期交易告警。

## 1. 提案目的

本文提出把 Aptos 作为**可选验证层**加入 re0，用于对已发布 Version、审计链和发布者账期结算单做第三方可验证的存证。

本提案不改变 MVP 的任何既有契约。评审已通过，产品规则摘要写入 [requirement.md](./requirement.md) 第 6.4 节；该文第 2.3 节的排除项收窄为「代币、NFT、加密资产支付与任何形式的链上资金流转」，存证本身不再是排除项。

### 1.1 要解决的问题

[requirement.md](./requirement.md) 第 2.1 节把「可信」和「可追溯」列为核心价值，但当前实现中这两条**只能由平台自证**：

- Version 声明不可变，但不可变性由 re0 自己的数据库保证，平台自身可以改写；
- [architecture.md](./architecture.md) 第 14 节的 Audit Log 已做哈希链，每日链头写入 R2，但 R2 同样在平台控制之下；
- Agent 拿到带 Citation 的上下文后，无法独立验证「该 Asset 在某时刻确实是这份内容」；
- [publisher-revenue-share.md](./publisher-revenue-share.md) 第 3 节的分成结算同样只能由平台自证：发布者收到的是一个我们单方面算出、并且事后仍可改写的数字，他无法证明这张结算单在出账后没有被动过。

存证把这三条从「平台自证」变为「第三方可验证」，且不需要用户信任 re0。

### 1.2 不解决的问题

本提案**不涉及**代币、NFT、加密资产支付、发布者分成、资金冻结或双重记账。这些仍在排除范围内，见第 7 节。

## 2. 范围

### 2.1 本提案包含

| 能力 | 说明 | 频率 |
| --- | --- | --- |
| Version Anchor | 每个 published Version 的摘要进入 Merkle 树，Root 上链 | 每小时 1 笔交易 |
| Audit Anchor | 每日审计链头上链 | 每天 1 笔交易 |
| Earning Anchor | 每个账期的发布者结算单摘要进入 Merkle 树，Root 上链 | 每账期 1 笔交易 |
| Proof API | 返回单个 Subject（Version 或结算单）的 Merkle Proof 与交易引用 | 按需 |
| ~~公开 Verifier~~ | 1.3 版取消交付。编码规格见第 4.2.1 节，原像随第 5 节的接口返回，第三方可自行实现 | — |

### 2.2 本提案不包含

- Chunk 正文、文档原文、Query 或任何用户内容上链；
- 平台代币、NFT、链上支付或加密资产结算；
- 把访问规则或 API Key 权限迁移到链上凭证；
- 用户侧钱包连接、签名或 Gas 支付；
- 发布者分成的**资金结算与 Payout**：链上不发生任何转账，不引入稳定币、托管余额或链上账户体系，出账仍由 [publisher-revenue-share.md](./publisher-revenue-share.md) 第 8 节的外部支付服务完成。本提案只锚定结算单摘要，见第 2.1 节与第 7 节。

## 3. 需求侧

### 3.1 用户可见行为

- **存证在产品界面上不出现**（1.2 版）：不做展示位、不做入口，Asset 详情页、Dashboard 知识库详情、发布者收益页与管理后台都不展示存证状态。理由见第 4.1 节——它是可随时整体移除的旁路能力，而每一个展示位都是一处要随之拆除的耦合，也是一处会与真实能力脱节的文案；
- 唯一的对外形态是 **REST 的 Anchor 查询接口**：返回公开库的 Proof 与可重算的原像（第 5 节），供第三方自行校验。Context 与 Search 响应**默认不返回** Anchor 字段，避免影响 `maxTokens` 裁剪和响应体积；
- 私有库与结算单的原像**不经由任何界面呈现**。它们存在于数据库中，1.1 版曾设计过工作空间可见的展示位，1.2 版一并撤除；
- 存证不产生 Call 计量，不占用套餐额度，Free 与 Pro 均可用；
- 产品文案不得把存证表述为内容正确性保证。存证只证明「某时刻的内容是这一份」，与 [requirement.md](./requirement.md) 第 6.3 节对 Trust Score 的表述口径一致；
- **同一条纪律适用于结算单**：Earning Anchor 只证明「这张结算单自锚定之后没有被改写」，**不证明归因和分配算得对**。文案不得表述为「分成可验证正确」，只能表述为「结算单不可事后篡改」。归因正确性由 [publisher-revenue-share.md](./publisher-revenue-share.md) 第 3 节的可独立复算要求承担，与链无关。

### 3.2 默认策略

| 库类型 | 默认是否锚定 | 原像可见性 |
| --- | --- | --- |
| 平台知识库 | 是 | 公开 |
| 用户公开库（已审核发布） | 是 | 公开 |
| 私有库 | 是 | 仅 Workspace 成员 |
| 发布者账期结算单 | 是 | 仅该发布者本人，恒加盐 |

结算单的盐**不设关闭选项**：收益金额属于财务隐私，公开原像等于公开某个发布者的收入。

私有库默认开启的依据见第 6 节：链上只有加盐摘要的 Merkle Root，不泄露存在性、内容或元数据。若评审认为仍需保守，可改为 Workspace 级开关，默认关闭。

### 3.3 验收标准

- 任取一个 published 公开 Version，**第三方依据第 4.2.1 节的规格与第 5 节返回的原像，加上链上数据即可完成校验**，校验过程不调用 re0 任何接口。1.3 版取消了平台交付 Verifier 的要求，因此这条验收的是「可被校验」这个性质，而不是「有一份工具」；
- 篡改数据库中已发布 Version 的任一字段后，Proof 校验必须失败；
- 链或签名账户完全不可用时，发布、刷新、检索、计量和审核全部不受影响，仅存证状态停留在待存证；
- 私有库的锚定不使任何第三方能够判定该库是否存在、内容为何或属于哪个 Workspace；
- 删除知识库后，链上残留数据不足以恢复任何内容或标识；
- 发布者用自己的结算单原像、Proof 和链上 Root 即可完成校验，**校验过程不调用 re0 任何接口**；
- 修改数据库中已锚定结算单的任一字段（可计 Call 数、share_rate、金额、账期区间）后，Proof 校验必须失败；
- 第三方无法从链上判定某个发布者是否存在、收益金额或账期归属。

## 4. 架构侧

### 4.1 定位

存证是**旁路能力**，挂在发布之后，不进入 [architecture.md](./architecture.md) 第 8.3 节的发布事务，也不进入查询链路。移除该模块后系统行为不变。

### 4.2 锚定对象

Version Leaf 的原像：

```text
leaf = H(
  domain_separator ||
  asset_id || version_id ||
  source_digest || manifest_digest ||
  published_at ||
  salt
)
```

- `domain_separator` 固定常量，防止跨用途碰撞；
- 公开库 `salt` 为空，原像可完整公开，任何人可独立重算 leaf；
- 私有库 `salt` 取自 Workspace 级密钥派生，原像不公开，第三方无法通过候选内容碰撞验证收录情况；
- Audit Leaf 取 [architecture.md](./architecture.md) 第 14 节既有审计链的每日链头哈希，不新增审计字段。

Earning Leaf 的原像：

```text
leaf = H(
  domain_separator ||
  publisher_account_id || period_id ||
  attributable_calls || share_rate || plan_version_id ||
  amount_minor || currency ||
  statement_digest ||
  salt
)
```

- `statement_digest` 覆盖该账期结算单的完整逐项明细（每个 Asset 的可计 Call 数与分配额），因此改动任何一行都会改变 leaf；
- `share_rate` 与 `plan_version_id` 取自 [publisher-revenue-share.md](./publisher-revenue-share.md) 第 3 节的不可变 Plan Version，锚定后费率无法被追溯修改；
- `salt` 取自发布者账户级密钥派生，**无公开原像的情形**；
- 结算单在账期关账、金额定稿之后锚定，`pending` 状态的账期不进入。

### 4.2.1 编码规格（冻结项）

第 4.11 节门禁 2 要求第二份独立实现，**由不读 re0 代码的人完成**。因此本节把上面那几个抽象式子写成可照做的规格；它和门禁 1 一起冻结，改动即新的 `leaf_schema_version`。

**字段拼接。** 每个字段先按 **UTF-8 字节长度**加前缀，再用 `|` 连接：

```text
frame(fields) = fields.map(f => `${utf8ByteLength(f)}:${f}`).join('|')
leaf = SHA-256(frame([...]))   // 输出小写十六进制
```

长度前缀不是形式主义：直接拼接时 `asset_id="ab", version_id="c"` 与 `"a", "bc"` 是同一段原像，而这两半都由能创建知识库的人自己决定。长度按字节而非码元计，否则另一种语言的实现会对中文标题给出不同的数。

**字段顺序**，第一项恒为 domain separator，第二项恒为 `leaf_schema_version` 的十进制字符串：

| Subject | domain separator | 其后字段 |
| --- | --- | --- |
| Version | `re0/anchor/version` | `asset_id`、`version_id`、`source_digest`、`content_merkle_root`、`published_at`、`salt` |
| Audit | `re0/anchor/audit-head` | `date`（`YYYY-MM-DD` UTC）、`chain_head` |
| Earning | `re0/anchor/earning-statement` | `publisher_account_id`、`period_id`、`attributable_calls`、`share_rate`、`plan_version_id`、`amount_minor`、`currency`、`statement_digest`、`salt` |

- `content_merkle_root` 即第 4.2 节的 `manifest_digest`，落库列名为 `asset_version.content_merkle_root`；
- `published_at` 为 ISO 8601 UTC **毫秒**精度（`2026-01-01T00:00:00.000Z`）。Postgres 存微秒而 JavaScript 不存，因此截断是格式的一部分，Proof API 也发布这个字符串；
- `share_rate` 是**文本**，取自不可变 Plan Version 的原样记录。浮点数在不同语言里序列化不同，`0.2` 与 `0.20` 必须是两张不同的结算单；
- 数值字段（`attributable_calls`、`amount_minor`）取十进制字符串，无前导零、无千分位；
- Audit Leaf **不加盐**：审计链是平台对自身动作的记录，没有第三方的存在性可泄露。

**盐的派生。** 私有库按 Workspace、结算单按发布者账户：

```text
salt = HMAC-SHA256(ANCHOR_LEAF_SALT_SECRET, frame(['re0/anchor/salt', scope]))
```

公开库 `salt` 为空字符串——空字符串仍然参与 framing（`0:`），不是省略该字段。

**批次 Merkle 树。** 与 `asset_version.content_merkle_root` 用同一套规则：

```text
level0[i] = SHA-256('L:' + leaf[i])
node      = SHA-256('N:' + left + right)
```

奇数节点**原样上提**，不复制。两条都是必需的：前者使内部节点无法冒充叶子，后者避免复制末叶让两组不同的叶子算出同一个 Root——对锚定而言那意味着两个批次无法区分。

**Proof 路径。** `anchor_leaf.merkle_proof` 是字符串数组，每步为 `l:<64位十六进制>` 或 `r:<64位十六进制>`，`l` 表示兄弟节点在左、被携带的节点在右。必须记录方向：`H(a‖b) ≠ H(b‖a)`，一份把顺序留给校验方自行尝试的 Proof 等于两份都认。校验从 `SHA-256('L:' + leaf)` 起，逐步合并，最后与链上 Root 相等。

### 4.3 聚合与提交

不做「一个 Version 一笔交易」。按固定时间窗聚合：

1. Cron 触发 Anchor Workflow，扫描窗口内的 Publication Event 生成 leaf；
2. 构建 Merkle 树，得到 Root；
3. 提交一笔交易写入 Root、批次类型和窗口结束时间；
4. 交易确认后回填每个 leaf 的 Merkle Proof。

发布事务本身不做任何改动，Anchor Workflow 通过既有 Publication Event 反查，实现零侵入。

Earning Anchor 走同一条 Workflow，触发点不同：账期结算完成、金额定稿后触发一次，一个账期一笔交易，一个发布者一个 leaf。账期结算事务本身同样不做改动，Anchor Workflow 从已关账的 `revenue_period` 反查。

### 4.4 数据模型

| 表 | 关键字段 |
| --- | --- |
| `anchor_batch` | 批次类型、Leaf Schema 版本、Merkle Root、Leaf 数、窗口区间、网络、交易哈希、状态、重试次数、确认时间 |
| `anchor_leaf` | 批次 ID、Leaf 哈希、Leaf Schema 版本、Subject 类型与 ID、Leaf 序号、Merkle Proof |

Subject 类型为 `version | audit_head | earning_statement`，三者共用同一套批次、Leaf 和 Proof 结构，不为结算单新增并行表。

约束：`anchor_leaf` 的 `(subject_type, subject_id, leaf_schema_version)` 唯一，允许同一 Version 在不同 Schema 版本下重锚，但同一版本内不重复，理由见第 4.5.1 节；`anchor_batch.tx_hash` 唯一。批次状态机为 `pending | submitted | confirmed | failed | superseded`，与 [architecture.md](./architecture.md) 第 6.2 节现有状态字段一样不合并语义。

### 4.5 链上合约与升级策略

Move 模块保持最小面：

- 单一 entry function 接收 Leaf Schema 版本、批次类型、Merkle Root 和窗口结束时间；
- Root 通过 Event 发出，不做全量链上存储，降低存储成本；
- 仅平台签名账户可调用；
- 合约无资金、无用户资产、无 Root 之外的可变状态。

按第 0 节决策**不保留升级能力**，具体形态：

- 使用 Object Code Deployment 部署，代码托管在独立 Code Object；
- `Move.toml` 中 `upgrade_policy = "immutable"`。包一经发布即不可变更：没有升级密钥、没有升级流程，也没有「升级悄悄改变 Root 语义」这种可能；
- 内部评审 F1 指出 Code Object 可被自由转移、且 `object_code_deployment` 不保存 `TransferRef` 因而事后无法关闭。`immutable` 使这条风险消失：**没有人能向一个不可变更的包发布任何东西，对象归谁也就不再有后果**；
- Aptos 规定包的链上策略**只能单向变严**，因此这是不可逆的一次性选择。它在**首次发布时**生效：先前以 `compatible` 发布的测试网对象保持原策略，仓库里的改动只约束此后新发布的任何对象，包括主网；
- 没有升级，也就没有升级公告、没有升级授权、没有「升级悄悄改变 Root 语义」这一类问题。作为交换，**修复合约缺陷的唯一办法是发布一个新的 Code Object 并重锚**，这使第 4.11 节门禁 3 的内部评审成为唯一的一次机会。

**校验方必须接受一组签名地址和一组 Code Object。** 签名地址编译期绑定，所以换签名账户就要换包；在 `immutable` 之下换包意味着**发布一个新的 Code Object**。因此轮换前后的锚定 Event 既不同 sender、也不同模块地址。一个只信任「单一模块 + 单一 sender」的校验方，会在第一次轮换之后把全部历史判为伪造。

正确的做法是维护一份**历史 (Code Object, 签名地址) 的集合**，按 Event 所在的账本版本判断当时哪一对有效。这一条由 2026-09-10 的测试网轮换演练发现（当时轮换还是一次升级，见 [move/rotation-drill.md](./move/rotation-drill.md)）；改为 `immutable` 之后它的形态从「一组地址」变成「一组对象加地址」，结论不变。

**无论如何，已经发出的历史 Event 谁也改不了**，这是整套方案成立的底座：即使签名密钥完全失陷，攻击者也只能污染后续锚定或使其停摆，已锚定的历史记录仍可被第三方独立验证。

### 4.5.1 Leaf Schema 版本与重锚

因为直接上主网、写入不可撤销，Leaf 构造必须自带版本号：

- `leaf_schema_version` 同时写入链上 Event 和 `anchor_batch` 表；
- 若 Leaf 构造被发现有缺陷，**不修改也不撤销历史批次**，而是以新版本重锚受影响的 Subject，旧批次标记为 `superseded` 并保留；
- 同一 Subject 允许存在多条 Leaf 记录，`anchor_leaf` 的唯一约束相应改为 `(subject_type, subject_id, leaf_schema_version)`；
- 第 4.2.1 节的规格必须保留全部历史 Schema 版本的定义，任何校验实现都要能处理旧版本，不得只描述最新版。

### 4.6 密钥分层与 Gas

第一阶段**只有平台提交交易，没有任何用户交易**，因此不需要钱包连接、Keyless 账户或 Sponsored Transaction。用户全程无感，界面不出现钱包相关元素。

1.3 版取消升级能力之后只剩一把密钥。它同时是 Code Object 的 Owner，但那已经没有后果——一个 `immutable` 的包不接受任何发布。

| 密钥 | 用途 | 保管方式 | 使用频率 |
| --- | --- | --- | --- |
| Anchor Signer | 提交锚定交易 | **平台环境变量**直接持有 Ed25519 私钥，按环境隔离 | 每天约 25 次 |

- Anchor Signer 账户只保留支付 Gas 所需的少量余额，并设置余额下限告警；
- 风险隔离：私钥泄露**不能触及用户数据、知识库内容、额度或资金**，也不能改写合约或已发出的历史 Event（包 `immutable`），只能伪造或阻断后续锚定；
- 处置手段是**发布一个新的 Code Object、把环境指过去、重新锚定**。这比 1.1 版的「取出冷钥升级一次」重得多，是 `immutable` 的代价；
- 检测手段只剩第 4.9 节的链上读数，且 1.3 版未指定巡检人，见第 0.2 节。

关于 Anchor Signer 的托管形态：按第 0 节决策，私钥**由平台环境变量直接持有**，不引入云 KMS，也不引入托管签名服务。1.0 版把 KMS 定为起步形态，本版撤销该决定，理由是接入成本；1.0 版给出的风险判断没有被推翻，只是被知情接受，见第 0.1 节。Ed25519 的 KMS 支持核实一并作废，不再是阶段 A 的前置。

具体要求：

- 私钥以 Ed25519 十六进制形式存放在 `APTOS_ANCHOR_SIGNER_KEY`，**三套环境各持一份，严禁共用**；生产环境的那一份不得出现在 preview 部署、CI 或任何本地文件中；
- 应用与 Workflow 只能通过 `lib/infrastructure/chain` 的 Signer Adapter 读取该密钥，禁止在业务代码或前端可达的任何位置引用它；密钥不得进入日志、Trace 与告警内容，与 [architecture.md](./architecture.md) 第 17.1 节的日志禁令同一口径；
- Anchor Signer 账户只保留 Gas 余额（实测年耗约 0.3 APT），余额下限告警必须开启——余额异常下降是密钥被滥用的早期信号之一；
- 轮换是**计划内动作而非仅在事故时**：至少每次合约升级时一并评估。因为轮换必须连带一次合约升级（签名地址编译期绑定），轮换成本高，所以更要提前演练而不是等出事再学，见第 4.11.1 节门禁 1；
- 节点或密钥不可用时锚定进入重试队列，批次状态停留在 `pending`，不阻塞发布与检索（第 4.1 节旁路定位）；
- **本条是本方案里唯一的检测面**：第 4.9 节的非预期交易告警不得关闭或降级。KMS 方案下还有 IAM 策略、来源限制与调用审计三层约束，本方案一层都没有，全部压在这条告警上。

**剩余的硬性触发条件**：链上出现任何形式的资金流转时，本节与第 0.1 节的结论全部失效，必须重新评审并重新设计密钥分层。

### 4.7 新增环境变量与 Secrets

```text
APTOS_NETWORK                  # 生产固定 mainnet；开发与 CI 用 testnet 或 localnet
APTOS_NODE_URL                 # 写入与确认，Aptos Build 端点
APTOS_API_KEY                  # 写入路径凭据
APTOS_INDEXER_URL              # 事件监控，GraphQL 端点
APTOS_INDEXER_API_KEY          # 监控路径凭据，必须与 APTOS_API_KEY 不同
APTOS_ANCHOR_OBJECT_ADDRESS
APTOS_ANCHOR_SIGNER_KEY        # Anchor Signer 的 Ed25519 私钥，十六进制
APTOS_ANCHOR_ACCOUNT_ADDRESS   # 由上面这把私钥派生的 Aptos 账户地址
ANCHOR_LEAF_SALT_SECRET
```

**上表就是全部，不再增加。** 存证是可随时移除的旁路能力（第 4.1 节），每多一项配置就多一处要与代码保持同步的地方，也多一个「拿掉存证」时要记得清理的角落。阈值写成常量、开关由配置是否存在推导——**把 `APTOS_*` 从某个环境移除，该环境就不再有任何存证痕迹**，不需要另外关掉什么。

`APTOS_ANCHOR_SIGNER_KEY` 是本表里**唯一一项真正的私钥材料**，1.0 版明令它不得存在，本版按第 0 节决策恢复。它与其余各项不是同一量级：其他 Secret 泄露的处置是换一把 key，它泄露的处置是发布一个新的 Code Object 并重锚，见第 0.1 节。

锚定 Workflow 与 [architecture.md](./architecture.md) 第 8.1 节的 Ingestion Workflow 使用同一套持久化执行机制，不新增执行引擎，但有**自己的 Cron 入口** `/api/cron/anchor`（每 15 分钟），不搭在队列 drain 上——按第 4.1 节的旁路定位，删掉那个路由与 `vercel.json` 里的一行就移除整套调度。15 分钟不是锚定频率：一小时一个 Version 批次、一天一个 Audit 批次由 Workflow 自己决定，这个频率是为了**确认**上一轮提交的交易，好让第 4.8 节的两小时 SLO 宽裕而不是紧绷。

沿用 [architecture.md](./architecture.md) 第 19.1 节的约束：Secret 不进入前端 Bundle；本表各项都属于「三套环境各持一份」的默认情形，19.1 为共享 Neon 与 Blob 开的两类例外与锚定无关。

开发与 CI 使用 Localnet 或 Testnet，配置来自独立环境，遵循 [architecture.md](./architecture.md) 第 3.2 节的环境隔离；生产环境只允许指向 mainnet。

### 4.8 失败与降级

- 链不可用、节点超时或 Gas 不足时，批次保持 `pending` 并按退避重试，不阻塞任何主链路；
- 连续失败超过阈值触发告警，进入人工处置；
- SLO：99% 的 published Version 在 2 小时内完成确认。该指标降级不构成 [architecture.md](./architecture.md) 第 13 节意义上的可用性事故。

### 4.9 可观测性

沿用既有 Trace 字段，新增指标：批次提交延迟、确认延迟、重试率、待锚定积压、Anchor Signer 余额。

额外提供一项独立于发布流程的**链上读数**：Code Object 的发布次数与签名账户的近期交易数，读自与写入路径不同的凭据（`APTOS_INDEXER_*`）。读取自身带心跳——**不可达要作为故障报出，而不是作为「一切正常」**，否则「没有异常」与「读数已死」无法区分。

**1.2 版把这里由自动告警改为读数，这是一次安全姿态的下调，代价要写清楚。** 1.1 版曾要求「出现任何未经公告的升级立即告警」，并以一个配置项声明「已公告的发布次数」作为基线。该机制在 2026-09-10 的轮换演练中确实对一次真实升级触发了严重告警（见 [move/rotation-drill.md](./move/rotation-drill.md)）。取消它的理由是本节开头那条：存证是可随时移除的旁路系统，一条需要自带配置基线的规则会与那份基线脱节，届时告警反映的是配置而不是平台。

**由此产生的后果必须被接受**：非预期的签名账户活动不再有自动告警。1.3 版进一步取消了巡检人（门禁 8），因此实际上没有任何机制或职责保证有人会发现，见第 0.2 节。合约本身已无升级可言（`immutable`），所以「未公告升级」这一类告警连同它防的那件事一起消失了。

仍然保留的告警都不依赖任何配置项：读数不可达、Anchor Signer 余额为零或低于常量阈值、批次已放弃重试、最早未确认批次超过第 4.8 节的 SLO 窗口。

告警中只包含批次 ID、交易哈希和稳定错误码，不含 Leaf 原像。

存证**在管理后台没有界面**：它是可随时整体移除的旁路系统（第 4.1 节），一个界面就是一处要随之拆除的耦合。告警走运行日志，失败批次的恢复走脚本，设计见 [architecture.md](./architecture.md) 第 14 节。

无论从哪里读，边界不变：**只到批次与 Leaf 哈希，不触及 Leaf 原像**。原像的可见范围由所属方决定（第 3.1 节），平台运维不在其中任何一列，因此读取锚定的查询不得 join 任何 Subject 表——否则它会成为一条绕开第 3.2 节可见性规则的旁路。

### 4.10 成本

每天约 25 笔交易，加上每账期 1 笔结算单锚定，年约 9,000 笔。Aptos 单笔基础交易费用极低，量级为每年个位数到几十美元。评审时需按当时 Gas 参数与 APT 价格复核，并在提案通过后写入预算基线。

因为直接上主网，成本自阶段 A 起即产生，且 Anchor Signer 需要预先充值并维持余额。余额耗尽等同存证停摆，按第 4.8 节降级处理。

### 4.11 主网上线门禁

主网写入不可撤销，以下每项通过后才允许提交第一笔生产锚定：

1. Leaf 构造、`domain_separator` 和 `leaf_schema_version` 已冻结并评审通过；
2. ~~两份独立实现交叉验证~~ —— **1.3 版豁免**。只有一份实现，它自己测自己；一处构造缺陷不会被自己的测试发现。代偿是第 4.2.1 节的编码规格公开发布，任何第三方都能独立实现并核对；
3. 合约完成内部评审，评审范围必须覆盖升级路径。按第 0 节决策不做外部审计，因此内部评审需至少两人、留书面记录。第一份记录见 [move/contract-review.md](./move/contract-review.md)（2026-09-10），**仍缺第二位评审人**；
4. ~~Upgrade Authority 独立生成并离线保管~~ —— **1.3 版豁免**。不单设该密钥，Code Object 由 Anchor Signer 账户持有。轮换演练本身已完成（第 4.11.1 节门禁 1）；
5. 私有库加盐路径经过验证，确认链上数据不可用于存在性判定；
6. 第 3.3 节验收标准在 Localnet 或 Testnet 全部通过；
7. Anchor Signer 已充值，余额告警已生效；
8. 第 4.9 节的链上读数已上线，读取不可达时作为故障报出。~~并指定巡检人与频率~~ —— **1.3 版豁免**：不指定。合约变更与非预期交易因此没有任何被发现的保证，见第 0.2 节。

### 4.11.1 Earning Anchor 的独立门禁

以上八条只覆盖 Version 与 Audit Anchor。结算单存证在阶段 F 上线前另需逐条通过：

1. Anchor Signer 的**密钥轮换演练已在 Testnet 完整走通一遍**——生成新账户、重新编译、把合约指向新地址、由新账户完成一次锚定，全部有书面记录。**已于 2026-09-10 完成**，见 [move/rotation-drill.md](./move/rotation-drill.md)。演练当时包还是 `compatible`，因此换地址是一次升级；1.3 版改为 `immutable` 之后，同一步骤变成**发布一个新的 Code Object**，其余流程不变。门禁存在的理由没有变：轮换不是吊销一个凭据，出事时现学代价太高；
2. [publisher-revenue-share.md](./publisher-revenue-share.md) 阶段 1 的记账数据连续两个账期可被独立复算，复算结果与结算单逐项一致；
3. 结算单加盐路径经过验证，确认链上数据不可用于判定发布者存在性或收益金额；
4. 发布者协议已写明存证的含义与边界，明确它不构成分配正确性的保证；
5. 第 3.3 节新增的三条验收标准全部通过。

### 4.12 供应商选型

本节的选型只覆盖链接入，不影响 [architecture.md](./architecture.md) 第 1 节的运行基座。

| 用途 | 选型 | 理由 |
| --- | --- | --- |
| 锚定提交与确认 | Aptos Build 官方托管 fullnode API | 官方维护，SDK 原生支持 API Key；日请求量三位数，免费额度足够 |
| 事件监控 | Aptos Build 托管 Indexer GraphQL，**独立凭据** | 见第 4.9 节的故障域隔离要求 |
| 故障转移 | 第三方节点服务，阶段 B 稳定后再加 | 用于守住第 4.8 节的 SLO，不是上线门禁 |
| 公开 Verifier | 公共免密端点，允许用户替换 | 见下 |

**不自建 fullnode。** [architecture.md](./architecture.md) 第 20 节已排除引入常驻自管基础设施，为每天 25 笔交易维护节点不成比例。若未来监控或验证需求超出托管 API 的能力，再单独评审。

**Verifier 的端点约束（硬性）。** 第 3.3 节要求公开 Verifier 的校验过程不调用 re0 任何接口。因此 Verifier **不得**硬编码 re0 的 API Key，也不得默认指向 re0 的私有端点——否则它验证的是「re0 的节点这么说」，而不是「链上这么说」，独立性直接失效。Verifier 必须默认使用公共免密端点，并允许调用者传入自有端点或凭据。该约束在阶段 C 交付 Verifier 时验收。

**运营前置。** Anchor Signer 账户需要预先充入真实 APT 并配置余额下限告警，属于第 4.11 节门禁第 7 条，由人工完成。

## 5. REST 契约草案

```text
GET /v1/assets/{assetId}/versions/{versionId}/anchor
GET /v1/publisher/periods/{periodId}/anchor
```

返回字段：存证状态、网络、Code Object 地址、Leaf Schema 版本、交易哈希、Merkle Root、Leaf 哈希、Proof 路径、确认时间。同一 Version 存在多个 Schema 版本的锚定时，默认返回最新一条并附带历史条目。公开库额外返回可公开的原像字段，私有库仅对通过工作空间检查的调用者返回原像。结算单接口只对该发布者本人开放，返回逐项明细原像与 `statement_digest`，供其在本地重算 leaf。

**公开原像的具体形状。** 这是「一份 Proof」和「一份能用的 Proof」的差别：门禁 2 的第二份实现由拿不到本库的人完成，他要哈希的每一样东西都必须从接口回来。公开库的响应里附一个 `preimage` 对象，字段顺序即第 4.2.1 节 framing 的顺序：

```json
{
  "domainSeparator": "re0/anchor/version",
  "leafSchemaVersion": 1,
  "assetId": "…", "versionId": "…",
  "sourceDigest": "…", "contentMerkleRoot": "…",
  "publishedAt": "2026-01-01T09:30:00.000Z",
  "salt": ""
}
```

- `domainSeparator` 一并返回，使响应自解释：校验方可以拿它与第 4.2.1 节核对，而不必相信「拿到手的字段顺序就是被哈希的那个顺序」；
- `publishedAt` 是**当时被哈希的那个字符串本身**，不是时间戳的重新渲染；
- `salt` 恒为空串——公开原像不加盐，且空串仍参与 framing；
- **原像不完整时整个省略**，不返回半份。缺内容根或缺发布时间的版本没有可哈希的东西，给半份会表现为「一个校验不过的 leaf」，而不是「我们本来就没有这份数据」；
- 私有库与结算单**不走这条路**：它们的原像加盐且分别属于工作空间与发布者本人（第 3.2 节），免密端点一概不返回。

该接口遵循 [architecture.md](./architecture.md) 第 12 节的统一错误与鉴权模型，且不计 Call。

## 6. 隐私与合规

- 链上**只有** Merkle Root 和批次元数据，没有任何内容、Query、邮箱、Source URL、Workspace 名称，也没有任何金额、费率或发布者标识，与 [architecture.md](./architecture.md) 第 17.1 节的日志禁令保持同一口径；
- 私有库与结算单 leaf 加盐，链上数据不能用于枚举、碰撞验证或存在性判定；结算单的盐无关闭选项，见第 3.2 节；
- 删除权：用户删除知识库后，数据库侧原像与 Proof 一并删除，链上残留的 Root 不含个人数据且失去可解释性，因此不可变账本与删除义务不冲突；
- 不得为了「证明内容存在」而放宽上述任何一条。若某个业务诉求需要把原像上链，该诉求不在本提案范围内。

## 7. 明确排除与后续阶段

以下内容**本次不提案**，需要各自独立评审：

| 项 | 状态 | 前置条件 |
| --- | --- | --- |
| 发布者分成结算单的存证 | **已纳入本提案** | 见第 2.1 节 Earning Anchor 与第 8 节阶段 F |
| 发布者分成的链上**资金**结算（USDC） | 后续阶段 | 出账链路先在外部支付服务上跑满两个账期；一旦引入，第 0.1 节结论全部失效 |
| USDC 订阅支付渠道 | 后续阶段 | 现有 Payment Provider 主链路保持不变 |
| Keyless 账户 | 后续阶段 | 仅在需要发布者收款时才引入 |
| 链上访问凭证 / 许可 NFT | 不建议 | 与既有 API Key 和访问规则重复，链上凭证无法表达访问规则语义 |
| 平台代币 | 不建议 | 引入证券、税务与交易合规风险，且分成用稳定币即可满足 |

## 8. 分阶段计划

按第 0 节决策，生产数据自第一天起写入主网，不存在测试网到主网的迁移。Testnet 只用于开发与 CI，其数据不进入产品。

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| A | 合约与 Anchor Workflow 开发，Localnet/Testnet 验证 | 第 4.11 节门禁 1–6 全部通过 |
| B | 主网部署合约，开启 Version Anchor 与 Proof API | 门禁 7 通过，且连续 30 天满足 4.8 的 SLO |
| C | 主网开启 Audit Anchor | Proof API 返回的原像可依第 4.2.1 节重算出 leaf 并验到链上 Root（不交付 Verifier，见门禁 2） |
| ~~D~~ | 1.3 版起不适用：存证没有产品界面（第 3.1 节） | — |
| ~~E~~ | 1.3 版起不适用：合约首发即 `immutable`，没有可硬化的对象 | — |
| F | 主网开启 Earning Anchor，交付结算单校验能力 | 第 4.11.1 节门禁全部通过 |

阶段 A、B、C 对用户全程不可见——1.3 版取消了所有界面，因此整条线都不需要发布任何界面变更。阶段 F 排在最后，它依赖分成侧跑出真实数据；在那之前，分成正确性由第 4.11.1 节门禁 2 的独立复算承担，不依赖链。既不做外部审计，也不等第二份实现，上线时间不受任何第三方排期影响。

## 9. 评审待决问题

起步网络、合约可升级性、升级授权形态、外部审计、节点接入、监控隔离和密钥托管形态均已在第 0 节决策，以下为剩余问题：

1. 私有库默认锚定是否可接受，或改为 Workspace 级开关且默认关闭；
2. 公开 Verifier 是否开源，以及是否承诺长期维护。注意它同时承担门禁 2 的交叉验证职责，不只是对外交付物；
3. 存证 SLO 未达标时，界面如何表述，是否需要单独的状态页；
4. 是否需要在服务条款和隐私政策中新增条款，以及由谁审阅；
5. ~~Upgrade Authority 的保管与取用~~ —— 1.3 版起不适用：没有升级能力，也就没有这把密钥。

## 10. 参考资料

- [Aptos Keyless 账户](https://aptos.dev/build/guides/aptos-keyless/introduction)（后续阶段相关）
- [Aptos Sponsored Transaction](https://aptos.dev/build/sdks/ts-sdk/building-transactions/sponsoring-transactions)（后续阶段相关）
- [Move 包升级策略](https://aptos.dev/build/smart-contracts/book/package-upgrades)
- [Object Code Deployment](https://aptos.dev/build/smart-contracts/deployment)
- [Aptos TypeScript SDK](https://github.com/aptos-labs/aptos-ts-sdk)
- [Aptos Build API Keys](https://build.aptoslabs.com/docs/start/api-keys)
- [Aptos Indexer GraphQL API](https://aptos.dev/build/indexer/indexer-api)
- [Vercel Workflows](https://vercel.com/docs/workflows)
- [Vercel Cron Jobs](https://vercel.com/docs/cron-jobs)
