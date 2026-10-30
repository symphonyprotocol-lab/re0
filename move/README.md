# re0 锚定合约

[aptos-anchoring-proposal.md](../aptos-anchoring-proposal.md) 第 4.5 节那份合约的实现，阶段 A 的链上部分。

整个包只有一个 entry function 和一个 Event。**没有资金、没有用户资产、没有任何状态**——连它见过的 Root 都不存。Root 通过 Event 发出，因此每笔锚定交易的 storage fee 是 0。把这个模块整体删掉，re0 的行为不变（提案第 4.1 节：存证是旁路能力）。

```text
move/re0_anchor/
  Move.toml
  sources/anchor.move          # module <code_object>::anchor
  tests/anchor_tests.move      # 12 个单元测试
```

## 合约面

```move
public entry fun submit_batch(
    caller: &signer,
    leaf_schema_version: u64,
    subject_type: String,       // version | audit_head | earning_statement
    merkle_root: vector<u8>,    // 32 字节，SHA-256
    window_end_unix_secs: u64,
)
```

发出：

```json
{
  "type": "<code_object>::anchor::BatchAnchored",
  "data": {
    "leaf_schema_version": "1",
    "subject_type": "version",
    "merkle_root": "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "window_end_unix_secs": "1767225600"
  }
}
```

`subject_type` 用字符串而不是数字，取值与 Postgres `anchor_batch.subject_type` 逐字相同：一个只读链的第三方在浏览器里看到 `"version"` 就知道锚的是什么，看到 `1` 则什么也学不到——而这个模块存在的全部理由就是让第三方能独立读懂它。

| 中止码 | 含义 |
| --- | --- |
| 1 `E_UNAUTHORIZED` | 调用者不是 Anchor Signer |
| 2 `E_ROOT_LENGTH` | `merkle_root` 不是 32 字节 |
| 3 `E_UNKNOWN_SUBJECT` | `subject_type` 不在三种之内 |
| 4 `E_SCHEMA_VERSION` | `leaf_schema_version` 为 0 |
| 5 `E_WINDOW_END` | `window_end_unix_secs` 为 0 |

### 两条不能改的性质

**包一经发布即不可变更。** `upgrade_policy = "immutable"`（提案第 0.2 节）：事件字段、鉴权断言、乃至一个笔误，发布之后都改不了。校验方将来要读的每一样东西必须第一次就对——这正是门禁 1 要求先冻结 Leaf 构造、门禁 3 的内部评审是**唯一一次机会**的原因。修复缺陷只能发布一个新的 Code Object 并重锚。

**Anchor Signer 地址编译期绑定，不上链存储。** `Move.toml` 的 `anchor_signer` 命名地址在 build 时传入，合约里只有一句相等断言。因此签名密钥失陷的攻击者**改不了授权地址**，也改不了别的任何东西——包不可变更。代价是轮换签名账户意味着**发布一个新的 Code Object**，旧对象下的锚定仍然有效，所以校验方最终持有一组「对象 + 签名地址」，见 [rotation-drill.md](./rotation-drill.md)。

合约内的调用者检查不是多余的：模块事件由模块发出，如果没有这句断言，任何人都能从**这个模块**发出一条 `BatchAnchored`，只校验模块地址而不校验 sender 的 Verifier 就会认。

## 前置

- Aptos CLI ≥ 9.5（`brew install aptos`）。7.x 的编译器解析不了当前框架源码。
- 不需要 `git-lfs`：依赖指向 `aptos-labs/aptos-framework` 这个只含框架的镜像，并**钉在具体 commit 上**，不是分支。钉死是为了提案第 4.11 节门禁 3——一份能被内部评审的字节码，前提是同样的源码能重建出同样的产物。（`aptos-core` 主仓需要 git-lfs 且要克隆数 GB，而我们只用到 `signer`/`string`/`vector`/`event`。）

## 构建与测试

```bash
aptos move test --package-dir move/re0_anchor
```

12 个测试覆盖：三种 subject 各自可锚、陌生账户被拒、Root 长短各错一位被拒、大小写混淆的 subject 被拒、schema 版本与窗口时间为 0 被拒、同一个 Root 重复提交**不**被拒（去重在链下由 `anchor_batch.tx_hash` 唯一约束负责，不是合约的事）。

## 部署

```bash
scripts/deploy-anchor.sh --profile <profile>                          # 首次发布
scripts/deploy-anchor.sh --profile <profile> --object-address 0x...   # 升级（仅对早于 immutable 的旧对象有效）
```

脚本先跑单元测试，再用 Object Code Deployment 发布，并把 profile 账户作为 `anchor_signer` 传进去。**脚本硬拒绝 mainnet**：主网首发受提案第 4.11 节八条门禁约束，且要用离线的 Upgrade Authority，那是一次刻意的人工操作，不是谁都能跑的脚本。

Localnet：

```bash
aptos node run-local-testnet --force-restart --assume-yes
aptos init --profile re0-anchor-local --network local
scripts/deploy-anchor.sh --profile re0-anchor-local
```

Testnet：账户需要先充值，而 testnet 水龙头已改为网页登录，命令行拿不到币。

```bash
aptos init --profile re0-anchor-testnet --network testnet
# 到 https://aptos.dev/network/faucet?address=<上一步打印的地址> 领取，然后
scripts/deploy-anchor.sh --profile re0-anchor-testnet
```

CLI profile 落在仓库根的 `.aptos/`，已在 `.gitignore` 里，那里只会有 localnet 和 testnet 的一次性开发密钥。主网的 Anchor Signer 私钥按提案 1.1 版第 4.6 节放在 `APTOS_ANCHOR_SIGNER_KEY`，只允许生产环境持有，不进这个目录也不进 CI；Upgrade Authority 离线保管，任何阶段都不得进入环境变量、CI 或代码仓库。

发布后把 Code Object 地址写进对应环境的 `APTOS_ANCHOR_OBJECT_ADDRESS`。

**每个环境都要自己发一次。** 不是洁癖，是合约没得选：`anchor_signer` 编译期绑定，一个 Code Object 只认一个签名账户，换一把密钥就必然换一个 Object。已在链上验证过——用 develop 的签名账户去调 preview 的 Object，链上直接 `E_UNAUTHORIZED`。

当前测试网部署（地址记在这里是因为 env 文件都在 `.gitignore` 里，丢了就只能去浏览器考古）：

| 环境 | Anchor Signer | Code Object |
| --- | --- | --- |
| develop | `0x56be51cf…8bbdc` | `0xf7c4b0c7d523eb01b09f331edf9b85f594c9b1ef5325bbbaeae872845bf6d37a` |
| preview | `0x794b41dc…6a4c` | `0x03d6ccfd7372388ea1bb5ecf5a54aef3fc99c71a8c466dd80b765047dbb958f4` |

develop 的签名账户已于 2026-09-10 轮换为 `0x27bbfed5…ea96b`，Code Object 不变——当时包还是 `compatible`，轮换是一次升级（见 [rotation-drill.md](./rotation-drill.md)）。**此后新发布的对象一律 `immutable`**，这两个测试网对象保留原策略，因为链上策略无法从仓库改回。

主网尚未发布，见上文的门禁说明。

## 阶段 A 还差什么

链上这半边齐了，链下那半边还没开始——合约本身不构成可用的存证能力：

- ~~Leaf 原像构造与批次 Merkle 树~~ —— 已完成，见 `lib/domain/anchor-leaf.ts`，编码规格冻结在提案第 4.2.1 节；
- `lib/infrastructure/chain/anchor-signer.ts` 的 Signer Adapter，从 `APTOS_ANCHOR_SIGNER_KEY` 读 Ed25519 私钥。它是唯一允许读这个变量的地方，且密钥不得进入日志、Trace 或错误信息；
- `workflows/anchor-versions.ts` 与 `workflows/anchor-audit.ts`；
- `packages/verifier` —— 它同时是提案第 4.11 节门禁 2 要求的第二份独立实现，必须由不同的人、不共享代码地完成，所以不能等到最后顺手写。

## 整体移除

存证是旁路能力（提案第 4.1 节），移除它不该是一次考古。下面就是全部。

**先决定要移除哪一种。** 停止锚定但保留证据，只需把某个环境的 `APTOS_*` 移除——Workflow 随即视自己为未配置并跳过，已有的 Proof 照常可校验，前后台本来就没有任何存证界面。以下清单是**彻底移除**，它会销毁 Proof。

### 1. 数据库

```bash
npm run anchor:remove              # 干跑，报出将被销毁的批次与 Proof 数量
npm run anchor:remove -- --confirm # 执行
```

SQL 在 [db/teardown/anchoring.sql](../db/teardown/anchoring.sql)，预先写好并审阅过，**不在 journal 里**，所以不会自己跑。

**这一步销毁全部 Merkle Proof。** 链上的 `BatchAnchored` 事件仍在、仍为真，但把某个版本连到某个 Root 的那条路径只存在于 `anchor_leaf`。此后包括我们在内没有任何人能为已锚定的内容出具 Proof，链上的 Root 就成了无从比对的数字。

两张表建在 `0000_init.sql` 里，而那个文件事后不可编辑，所以一次全新的 `npm run db:migrate` 会把它们重新建出来。要让移除永久生效，把 teardown 文件复制进 `db/migrations` 编上下一个号并加进 journal——此后它像任何 migration 一样，在每个环境执行一次。

### 2. 删除这些路径

```text
app/api/cron/anchor/          app/api/v1/anchors/
lib/application/anchors/      lib/domain/anchor-leaf.ts    lib/domain/anchor-alerts.ts
lib/infrastructure/chain/     workflows/anchor-versions.ts workflows/anchor-audit.ts
move/                         scripts/deploy-anchor.sh     scripts/release-anchor-batch.mts
scripts/remove-anchoring.mts  db/teardown/
tests/contract/anchor-*.test.ts   tests/integration/anchor-*.test.ts
aptos-anchoring-proposal.md
```

### 3. 共享文件里的三处

- `vercel.json`：删掉 `/api/cron/anchor` 那条 cron；
- `package.json`：删掉 `anchor:release` 与 `anchor:remove`；
- `db/schema.ts`：删掉 `anchorBatch`、`anchorLeaf` 与两个 `pgEnum`；
- `contracts/schemas.ts`：删掉 `anchorSchema`、`anchorPreimageSchema` 与 `anchorStatusSchema`；
- `.github/workflows/test.yml`：删掉 `move` job；
- 九项 `APTOS_*` / `ANCHOR_LEAF_SALT_SECRET` 环境变量。

`asset_version.content_merkle_root` **留下**：它是版本自身的内容根，随发布计算，与锚定无关。

以上之外，共享代码里对存证的引用为零——没有页面 import 它、没有 i18n、没有权限、没有别的路由调它。
