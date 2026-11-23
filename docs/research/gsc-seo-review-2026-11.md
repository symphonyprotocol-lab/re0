# re0.io Google Search Console 数据审查与 SEO 改进方案（2026-11）

- 审查日期：2026-11-23
- GSC 资源：`sc-domain:re0.io`
- 数据截止：效果报告到 2026-11-20；编入索引报告最后更新 2026-11-16；站点地图最后读取 2026-11-23
- 代码基线：`main` @ `833f2fc1`（2026-11-22 合并的 #204）
- 线上抽查：2026-11-23 用 curl 访问 https://re0.io，分别用 Googlebot UA 和 Chrome UA
- 本轮只读：GSC 里没有提交、没有请求编入索引、没有验证修复；代码没有改动。

---

## 一、结论先行

1. **Google 读不到我们的 canonical，这是重复页问题的主因。**
   - 现象：GSC 的 URL 检查显示，`/en/r/ree-13n1bees`（11-13 抓取）和 `/zh/r/ree-enj1pgtw`（11-18 抓取）的「用户声明的规范网页」都是 **None**。这两次抓取都晚于 SEO 提交上线时间（2026-11-13 00:27 +0800 合入 main，见 #138）。
   - 原因：Next 15.5 对普通 Googlebot UA 使用流式 metadata，`<title>`、canonical、description 被放在 `<body>` 里，距文档开头约 307 KB。
   - 后果：Google 自己挑规范网页，结果把 `?from=`、`?rp=`、`?ap=` 等参数 URL 和返回 307 的无前缀 `/r/…` 都当成了独立页面或规范页。
2. **抓取预算大量浪费在不该抓的 URL 上。**
   - 未编入索引共 5.34k，其中 2,964 个是 `/login?returnTo=…`，1,865 个是「重复网页，用户未选定规范网页」。
   - Ree 页「同一创作者的更多 Ree」分页没有终点，`?ap=731` 仍返回 200 并链接到 `?ap=732`，形成抓取陷阱。
3. **站点地图提交了 6,680 个 URL，Google 只处理了 538 个，其中编入 253 个。** 已编入的 2.28k 个 URL 里，大多数是带参数的变体，不是站点地图里的规范 URL。
4. **展示量在涨，但几乎没有真实点击。**
   - 28 天：3 次点击，3.68k 次展示，CTR 0.1%，平均排名 5.2。
   - 97% 的展示来自桌面端，前几大国家是巴西和俄罗斯；查询词里大量是 "X tutorial for remote workers / renters / pet owners" 这类模板化的词。
   - 判断：这些展示很可能大部分来自自动化查询（排名追踪工具、爬虫或 AI agent 抓取 SERP），不代表真实搜索需求。真实的人类流量目前接近零。
5. 其他问题：站点地图有 4 处日期格式错误；不存在的 Ree 返回软 404；/zh 和 /en 两个版本的 Ree 内容几乎相同；Explore 的分类和分页对爬虫不可见；首页不链接任何 Ree；价格页 Product 结构化数据缺 `image`，商家信息报告里有 1 个严重错误。

**最该先做的两件事：**
1. 在 `next.config.mjs` 加一行 `htmlLimitedBots`，让 Googlebot 在 `<head>` 里拿到 metadata。
2. 堵掉参数 URL 和 login 链接这两个抓取漏斗。

这两件事加起来是半天到一天的工作量，能解决 GSC 里大约 90% 的未编入条目。

---

## 二、数据概况

### 2.1 效果（网页搜索）

GSC 里的数据从 **2026-11-11** 才开始，所以「28 天」和「3 个月」的数字完全一样。

| 区间 | 点击 | 展示 | CTR | 平均排名 |
|---|---|---|---|---|
| 7 天（11-14 至 11-20） | 2 | 3.55k | 0.1% | 5.2 |
| 28 天 / 3 个月（11-11 至 11-20） | 3 | 3.68k | 0.1% | 5.2 |

**每日展示**（11-11 → 11-20）：4 → 8 → 122 → 183 → 193 → 523 → 661 → 684 → 419 → 884。
- 11-13 起开始上量，正好是站点地图提交、SEO 改动上线的那天。
- 之后一直在涨，没有出现异常的骤降。
- 3 次点击分别在 11-12、11-15、11-19。

**设备（7 天）**

| 设备 | 点击 | 展示 | CTR | 排名 |
|---|---|---|---|---|
| 桌面 | 0 | 3,458 | 0% | 5.2 |
| 移动 | 2 | 87 | 2.3% | 6.5 |
| 平板 | 0 | 2 | 0% | 3.0 |

**国家（28 天，共 109 个）**
- 展示最多：巴西 1,144、俄罗斯 720、美国 434、阿根廷 148、孟加拉 143、乌克兰 81、印度 79。
- 有点击的：乌克兰 1、韩国 1、中国 1（中国共 6 次展示）。

**页面（28 天，有展示的 URL 共 416 个）**

| URL | 点击 | 展示 | 排名 | 备注 |
|---|---|---|---|---|
| `/rees` | 2 | 12 | 2.2 | **全站 3 次点击里有 2 次在这里**。现在 `/rees` 已改成需要登录（307 到 `/login`），并且被 robots.txt 屏蔽 |
| `/en/r/ree-r7s4jajx` | 1 | 1 | 2.0 | Argentina Travel Guide |
| `/en/r/ree-13n1bees` | 0 | 1,353 | 5.0 | Open Source Guides Assistant |
| `/r/ree-13n1bees` | 0 | 255 | 4.8 | 同一个 Ree 的无前缀 URL |
| `/en/r/ree-e61134vd` | 0 | 169 | 1.3 | Radiation Oncology Wikibook |
| `/r/ree-3a1mandw` | 0 | 172 | 3.1 | Tokio Docs |
| `/r/ree-5la42lfu` | 0 | 163 | 4.2 | NumPy User Guide |
| `/en/r/ree-13n1bees?from=/explore?q%3DPrompt+engineering&ap=3` | 0 | 103 | 5.9 | 参数变体 |
| `/r/ree-6esf07s8` | 0 | 89 | 4.1 | Hono Docs |
| `/en/r/ree-at5pr1gl` | 0 | 78 | 4.5 | Choose a License |

- 按 `*ree-13n1bees*` 过滤后，这一个 Ree 共有 1.75k 次展示，约占全站一半。它分散在 8 个以上的 URL 上（`/en/r`、`/r`、`/zh/r`，以及 `?rp=2`、`?rp=3`、`?from=…`、`?ap=…` 等）。
- 这些展示几乎全部来自被匿名化的查询，只看到一条 "github reo"。
- 同一个 Ree 的展示被拆到多个 URL 上，排名信号也被稀释了。

**查询（7 天可见 86 条；展示量里大部分是匿名查询）**

| 查询 | 展示 | 排名 | 观察 |
|---|---|---|---|
| wikibooks radiation oncology | 168 | 1.3 | 排名第 1，CTR 0%，对应 `ree-e61134vd` |
| numpy vs parcel / parcel vs numpy / numpy vs cargo / cargo vs numpy / numpy vs oauth | 51 / 14 / 31 / 3 / 1 | 2.5–8 | 毫无意义的组合 |
| vite / numpy / vitest / scikit-learn / ruby on rails / hono tutorial for remote workers / renters / pet owners / digital nomads / homeowners / travelers | 每条 1–48 | 2–9 | 明显是模板化生成的查询 |
| rust tokio tutorial | 7 | 1.7 | 真实需求 |
| fastapi documentation | 5 | 3.0 | 真实需求 |
| design system service gov uk / gov uk design system | 4 / 1 | 55–74 | 真实需求，排名太低 |
| expo docs / tauri docs / ollama docs / vue router docs / react query documentation | 1–3 | 30–75 | 真实需求，排名太低 |

**排名在 8–20 位的查询**（理论上最容易提升，但量都极小）：
- numpy vs oauth（8.0）
- react native official documentation site:reactnative.dev（9.0）
- hono tutorial for digital nomads（9.0）
- systems design primer（9.0）
- deno documentation（10.0）
- tokio rust（10.0）
- travel guide how（10.0）
- brazil travel advice（14.0）
- depreciation guide（18.0）

其中真正值得做的是 "systems design primer"、"deno documentation"、"tokio rust"，见第四节的内容建议。

**判断：**
- 「桌面 97% + 巴西/俄罗斯 + 模板化查询 + 0 点击」这个组合，很像自动化查询带来的展示，不像真实用户。
- 不要把「展示多、CTR 低」直接理解成「标题写得不好」。
- 在真实流量起来之前，看 CTR 的意义不大，更该关注的是正确的 URL 有没有被编入索引。

**搜索外观：** 无数据。

### 2.2 网页编入索引（最后更新 11-16）

全部已知网页：**已编入 2.28k，未编入 5.34k**。

| 原因 | 数量 | 抽样 URL / 模式 | 判断 |
|---|---|---|---|
| 被 noindex 排除 | 2,964 | 500 条样本里 94% 是 `/login?returnTo=/r/ree-…?from=…`（另带 `join`、`ap`），约 5% 是 `/explore?q=…` 和 `/zh/explore?q=…` | noindex 本身是对的，但抓取预算被大量浪费 |
| 重复网页，用户未选定规范网页 | 1,865 | 100 条样本：`/zh/r/ree-*?from=…` 49，`/en/r/ree-*?from=…` 14，`/zh/r/ree-*`（不带参数）11，其余是 `?from,ap`、`?rp`、`?join` 等组合 | **canonical 没被 Google 读到** |
| 网页会自动重定向 | 172 | `http://re0.io/`、`http://www.re0.io/`、`https://www.re0.io/`、`/r/ree-*?from=…`、`/r/ree-*?join=1`（都是无前缀 URL，307 到 `/zh/…`） | 大部分正常；无前缀 URL 用 307 有隐患，见问题 4 |
| 未找到（404） | 27 | `/legal`、`/contact`、`/playground`、`/libraries`、`/about`，还有一些 base64 样的乱码路径，如 `/WWspNpd1NOxiXxMmM2kKQ==` | 前几个是改版前的旧路由；`/about` 现在 307 到 `/zh/about`，已恢复正常 |
| 被 robots.txt 屏蔽 | 2 | `/api/auth/github/start`、`/dashboard/showcases` | 正常 |
| 已发现，尚未编入 | 192 | `/en`、`/en/legal/privacy`、`/en/legal/terms`、`/en/pricing`、`/en/r/ree-0bzprsa1` 等 | 抓取排队中；内链弱会让它排得更久 |
| 已抓取，尚未编入 | 118 | `/zh/r/ree-6zgn3bab?from=…`、`/en/r/ree-9vv78jv6?from,rp`、`/zh/r/ree-jgej3bpi`、`/r/ree-ko89jp97` | 参数变体，加上内容单薄 |

**只看站点地图提交的 URL：已编入 253，未编入 285。**
- 未编入的 285 个里，重复 93 个，已发现未编入 192 个。
- 站点地图共有 6,680 个 URL，也就是说 Google 只处理了约 8%。

**「已编入」的样本：** 10 条里有 9 条带 `?from`、`?rp`、`?ap` 参数。可见 Google 把参数 URL 当成了规范页编入索引。

**URL 检查结果（只读查看）：**

`https://re0.io/zh/r/ree-enj1pgtw`
- 状态：未编入，原因是「重复网页，用户未选定规范网页」
- 最近抓取：2026-11-18 10:29（Googlebot 智能手机），抓取成功，允许编入
- 用户声明的规范网页：**None**
- Google 选定的规范网页：**`https://re0.io/r/ree-enj1pgtw`**。这是一个返回 307 的无前缀 URL，也就是我们 hreflang 里的 x-default。
- 引荐网页：`/zh/r/ree-fg6otfm7?rp=2`，说明参数 URL 之间在互相链接、扩散。
- 站点地图那一栏显示「临时处理错误」。

`https://re0.io/en/r/ree-13n1bees`
- 状态：已编入
- 最近抓取：2026-11-13 05:13
- 用户声明的规范网页：**None**
- Google 选定的规范网页：被检查的这个 URL 本身
- 增强功能：面包屑 1 项有效

### 2.3 站点地图

| 站点地图 | 提交 | 最近读取 | 状态 | 发现网页 |
|---|---|---|---|---|
| `https://re0.io/sitemap.xml` | 2026-11-13 | 2026-11-23 | **4 个错误：Invalid date（lastmod）** | 6,680 |

- 我在 11-23 用 curl 拉到的版本有 6,772 个 `<loc>`：`/zh/r` 和 `/en/r` 各 3,378 个，`/p` 4 个，其余是站点页面。文件约 2.8 MB，是单个文件。
- 出错的就是那 4 个帖子 URL（2 个帖子 × 2 种语言），lastmod 的值是 Postgres 的原始字符串，例如 `2026-11-22 16:47:46.953+00`。

### 2.4 Core Web Vitals、HTTPS、增强功能

- **Core Web Vitals：** 移动端和桌面端都显示「过去 90 天使用数据不足」。
- **HTTPS：** 415 个 HTTPS URL，0 个问题。
- **面包屑：** 383 个有效，0 个无效。
- **商品摘要：** 1 个有效（`/pricing`），有 2 个警告：缺少 `aggregateRating` 和 `review`。
- **商家信息：** **1 个无效（`/pricing`），严重问题是缺少 `image`**。另有 2 个警告：缺少 `offers.hasMerchantReturnPolicy` 和 `offers.shippingDetails`。
- GSC 右上角有 **7 条未读消息**，请用户自己看一下。

---

## 三、发现的问题（含证据）

> 严重度：🔴 高，🟠 中，🟡 低。
> 「GSC 证据」来自第二节，「代码证据」标出了 文件:行号，「线上证据」是 2026-11-23 的 curl 结果。

### 🔴 1. Googlebot 拿到的 HTML 里，title、canonical、hreflang、description 都在 `<body>` 里

**线上证据**
- 用 Googlebot UA（`Googlebot/2.1`）请求 `/en/r/ree-13n1bees`，HTML 共 361,769 字节。
- `</head>` 在第 4,407 字节，`<body` 在第 4,414 字节。
- `<title>` 在第 307,130 字节，`rel="canonical"` 在第 307,668 字节，`name="description"` 在第 307,185 字节。它们全在 `<body>` 里，排在约 300 KB 的 RSC payload 之后。
- 同一页用 Bingbot UA 请求时，metadata 在 `<head>` 里。

**代码证据**
- `package.json:45` 的版本是 `next ^15.5.28`。
- `node_modules/next/dist/shared/lib/router/utils/html-bots.js:15` 的 `HTML_LIMITED_BOT_UA_RE` 列出了 Bingbot、`Google-InspectionTool`、`*-Google` 等，**但不包括普通的 `Googlebot`**。不在这个名单里的 UA 都会拿到流式 metadata。
- `next.config.mjs` 里没有配置 `htmlLimitedBots`。

**GSC 证据**
- 上面两个在 SEO 提交上线后才抓取的页面，「用户声明的规范网页」都是 None。
- 「重复网页，用户未选定规范网页」有 1,865 个。
- 已编入的 URL 大多是参数变体。

**补充说明**
- Next.js 官方文档说，流式 metadata 对能执行 JS 的 Googlebot 没有影响。
- 我在真实 Chrome 里打开页面、等水合完成后，React 确实把 canonical 和 hreflang 挪进了 `<head>`。（子任务报告里说「水合后仍在 body」，这一点我复核后不成立。）
- 但 GSC 的实际结果是 Google 没有采用这个 canonical。可能原因有两个：Google 的 canonical 提取依赖原始 HTML，或者 canonical 位置太靠后。不管是哪种，事实就是「None」。

**注意：GSC 的「测试实际网址」会误导人。** 实时测试用的是 `Google-InspectionTool` UA，它在 Next 的 bot 名单里，会拿到 head 版本的 HTML，所以实时测试看起来一切正常。验证修复时要看重新抓取后的「已编入版本」。

### 🔴 2. 参数 URL 互相链接、无限扩散，Google 把它们当成独立页面

**代码证据**
- Ree 卡片和相关 Ree 的链接会带上 `?from=<explore 当前 URL>`：
  - `components/discover/ree-card.tsx:38`
  - `components/discover/feed-ree.tsx:41`
  - `components/discover/public-list.tsx:58`
  - `components/discover/ree-detail-view.tsx:338`
- Explore 会把含 `q` 和 `category` 的当前路径传成 `from`：`components/discover/explore-view.tsx:72`、`components/discover/explore-view.tsx:330`。
- 结果是 `?from=/explore?q=…` 从一个 Ree 页传到下一个 Ree 页，一直扩散下去。
- `self()` 生成链接时会带上 `from` 和 `ap`：`components/discover/ree-detail-view.tsx:82-84`。
- 「同一创作者的更多 Ree」的上一页 / 下一页是普通 `<a>` 链接：`components/discover/ree-detail-view.tsx:276`。
- 旧版代码生成的 `?rp=` 已经不再产生，但 Google 里还留着一批，会随时间自然消失。

**线上证据**
- `/en/r/ree-13n1bees?ap=731` 返回 200，页面里同时有 `?ap=730&tab=intro` 和 `?ap=732&tab=intro` 两个链接。
- 官方账号名下约 2.9k 个 Ree，按每页 4 个算约 731 页。也就是说每个 Ree 页都能生出几百个可抓取的 URL。

**GSC 证据**
- 「重复网页」和「已抓取未编入」里大部分是 `?from`、`?ap`、`?rp`、`?join` 变体。
- 28 天有展示的 416 个 URL 里，参数变体占很大比例。

### 🔴 3. `/login?returnTo=…` 链接吃掉大部分抓取预算

**代码证据**
- 每个 Ree 页都有多个登录链接：`components/discover/ree-detail-view.tsx:91` 的 `loginHref`。线上能看到 `returnTo` 指向 `#ask`、`#comments`、`?compose=public&ree=…&name=…`、`?tab=intro` 等不同目标。
- 其他位置：`components/discover/explore-view.tsx:225`、`components/discover/explore-view.tsx:420`、`components/discover/roundtable-entry.tsx:47`。
- `app/login/page.tsx:19` 设置了 noindex，但 `/login` 本身是允许抓取的。

**GSC 证据**
- noindex 一类共 2,964 个，其中约 94% 是 `/login?returnTo=…`。
- 被 noindex 的 URL 是 Google 必须先抓下来才知道的，所以每一个都消耗了一次抓取。

### 🔴 4. 无前缀 URL（x-default）返回 307，被 Google 选成了规范页

**代码证据**
- `middleware.ts:39-43`：无前缀的公开路径按 cookie 和 Accept-Language 做 307 跳转，加上 `Vary: Cookie, Accept-Language`。
- `i18n/paths.ts:76`：x-default 指向无前缀路径。sitemap 的 alternates 也用这个函数（`app/sitemap.ts:33`）。

**线上证据**
- `/`、`/explore`、`/about`、`/r/ree-*` 都返回 307 到 `/zh/…`。
- Googlebot 不发 Accept-Language，所以永远被送到中文版。

**GSC 证据**
- `/zh/r/ree-enj1pgtw` 的 Google 选定规范网页是 `/r/ree-enj1pgtw`。
- 效果报告里 `/r/ree-13n1bees` 有 255 次展示，`/r/ree-3a1mandw` 有 172 次，这些都是会跳转的 URL。
- 307 是临时跳转，Google 会继续把源 URL 当成规范页。

### 🟠 5. /zh 和 /en 两个版本内容几乎相同，hreflang 也没生效

**代码证据**
- `app/sitemap.ts:32-37` 给每个 Ree 和帖子都生成 zh、en 两个 URL。
- `lib/seo.ts:108` 的 `inLanguage` 跟随 URL 语言，所以 zh 页会写成 `zh-CN`。

**线上证据**
- `/zh/r/ree-13n1bees` 和 `/en/r/ree-13n1bees` 的 title 和 description 完全一样，都是英文。只有 `<html lang>` 不同，一个是 `zh-CN`，一个是 `en`。
- 两者的差别只在界面文案。

**影响**
- 官方 Ree 的内容本来就是英文。在 Google 看来，zh 页面就是一份标着中文的英文重复页。
- 站点地图因此多了一倍的 URL（3,378 个），抓取量也被摊薄了一半。
- 因为问题 1，hreflang 也没被读到。

### 🟠 6. 站点地图 lastmod 格式无效（GSC 报 4 个错误）

**代码证据**
- `lib/services/posts.ts:1101` 写的是 ``sql<Date>`coalesce(${post.answeredAt}, ${post.publishedAt})` ``，没有加 `.mapWith(...)`，所以驱动返回的是字符串，不是 `Date`。
- 这个值直接进了 `app/sitemap.ts:37` 的 `lastModified`。

**线上证据**
- sitemap 里有 `<lastmod>2026-11-22 16:47:46.953+00</lastmod>` 这样的值，共 4 处。
- 现在只影响 4 个帖子，但帖子会越来越多，错误也会跟着变多。

### 🟠 7. 不存在的 Ree 和帖子返回软 404（状态码 200 + noindex）

**代码证据**
- `app/(product)/(discover)/loading.tsx` 和 `app/loading.tsx` 形成了 Suspense 边界，HTTP 200 在这之前就已经发出去了。
- 之后 `app/(product)/(discover)/r/[slug]/page.tsx:36` 里的 `notFound()` 已经改不了状态码。

**线上证据**
- `/zh/r/does-not-exist-xyz` 返回 200，页面带 `<meta name="robots" content="noindex">`。
- 相比之下，`/nonexistent-page` 会正常返回 404。

**影响**
- Ree 被下架或删除后，它的 URL 在 Google 那里会变成「noindex」或「软 404」，而不是干净的 404/410。
- Google 也就不会很快把它从索引里删掉。

### 🟠 8. Ree 的内链太弱，Explore 的分类和分页对爬虫不可见

**代码证据**
- 首页只在一条帖子都没有时才显示 Ree（`app/(product)/page.tsx:61-62`）。
- Explore 服务端只渲染第一批 Ree（`app/(product)/(discover)/explore/page.tsx:48`），其余靠滚动时请求 `/api/explore` 加载。
- 分类筛选是 `<button onClick>`（`components/discover/explore-view.tsx:283-291`），「加载更多」也是 button（`components/discover/explore-view.tsx:343`、`components/discover/explore-view.tsx:354`）。

**线上证据**
- `/zh` 首页的 HTML 里没有任何 `/r/ree-*` 链接。
- `/zh/explore` 的 HTML 里有 48 个 Ree 链接（24 个 Ree）。
- 每个 Ree 页大约链接 8 个其他 Ree。

**GSC 证据**
- 站点地图的 6,680 个 URL 里，Google 只处理了 538 个，其中「已发现未编入」192 个。
- 3k 多个 Ree 基本只能通过站点地图被发现。

### 🟠 9. 官方 Ree 页面内容单薄，而且模板化

**线上证据**
- 约 2.9k 个官方 Ree 共用同一套模板：一段描述、3 个示例问题，再加上「0 successful answers」「No answered posts yet」「No comments yet」。
- 描述和标题大多是「XXX Docs Assistant」「Answers questions on …」这种句式。

**影响**
- 这是「已抓取，尚未编入」（118 个）的典型成因。
- 即使问题 1–4 都修好了，这一点仍会限制收录率和排名。

### 🟠 10. 价格页的结构化数据和页面实际内容不匹配

**代码证据**
- `lib/seo.ts:145-175` 的 `pricingJsonLd` 输出 `@type: Product` 和 Offer，但没有 `image`。

**GSC 证据**
- 商家信息报告：1 个无效，缺少 `image`。
- 商品摘要报告：缺少 `aggregateRating` 和 `review` 两个警告。

**判断**
- 「商家信息」是给实体商品准备的富结果。SaaS 套餐用 `Product` 会一直被要求填退货政策、运费这类字段。

### 🟡 11. 标题和 H1 结构

**代码证据**
- Ree 页有两个 `<h1>`，内容都是 Ree 名称：`components/shell/feed-columns.tsx:66` 和 `components/discover/ree-detail-view.tsx:145`。线上用 DOM 也确认了有 2 个 h1。
- 帖子页的 meta description 在没有 detail 时会退回到问题本身，和 title 完全一样（`lib/og/post-meta.ts:39-40`）。
- Explore 的 title 只是「Rees · RE0」，没有任何描述性的词。

### 🟡 12. 改版前的旧路由直接 404，有过点击的 `/rees` 现在跳到登录页

**线上证据**
- `/legal`、`/contact`、`/playground`、`/libraries` 都返回 404。
- `/zh/legal` 会 307 到 `/legal`，然后 404。
- `/rees` 会 307 到 `/login?returnTo=%2Frees`，同时被 robots.txt 屏蔽，屏蔽规则来自 `lib/http/private-paths.ts`。

**GSC 证据**
- 这几个旧路由在 404 样本里出现了。
- `/rees` 拿到了全站 3 次点击里的 2 次。

**影响：** 量很小，但旧链接的权重没有被继承。

### 🟡 13. 性能隐患（CWV 暂时没有数据）

**线上证据**
- 一个 Ree 页约 360 KB HTML，其中约 305 KB 是内联的 RSC payload；JS 约 730 KB（gzip 后约 230 KB）。
- 公开页面的响应头都是 `cache-control: private, no-store`，所以 TTFB 完全取决于每次查数据库的速度。
- 等有真实用户数据后再看 CWV；现在先记为隐患。

### ✅ 已经做对的地方（不用改）

- `app/robots.ts` 屏蔽了工作区、后台、API，并声明了 Sitemap；非生产环境全站禁止抓取。
- 需要登录的页面都 307 到登录页，并且加了 noindex，也都没有进站点地图。
- `publicPage()`（`lib/seo.ts:52-63`）给每个公开页设置了自引用 canonical、zh/en/x-default alternates、OG 和 Twitter 卡片。问题只在于 Googlebot 拿不到这些。
- `?q=` 搜索结果页设置了 noindex,follow。
- www、http、尾斜杠都用 308 统一到规范地址。
- 每个 Ree 都有独立的 OG 图。
- BreadcrumbList 有 383 个有效项。
- Ree 的名称、描述和示例问题都是服务端渲染的，原始 HTML 里就有。

---

## 四、改进清单（按 影响 ÷ 工作量 排序）

### A. 代码改动

| # | 改动 | 解决的问题 | 影响 | 工作量 |
|---|---|---|---|---|
| A1 | 在 `next.config.mjs` 加 `htmlLimitedBots`，让 Googlebot 拿到放在 head 里的 metadata。最简单的写法是 `htmlLimitedBots: /.*/`，代价是所有人的 TTFB 都要等 `generateMetadata` 完成。折中方案是在 Next 默认名单后面追加 `Googlebot`，参考 `html-bots.js:15`。改完后用 `curl -A Googlebot` 确认 `<title>` 出现在 `</head>` 之前 | 1、4、5 | 极高 | 0.5 小时 |
| A2 | 不让 `from` 进入可抓取的链接：改用 sessionStorage 或 history state 记录「从哪里来」，或者只在客户端导航时附加。至少要保证 SSR 输出的 `<a href>` 不带 `from` | 2 | 高 | 0.5–1 天 |
| A3 | 处理「更多 Ree」分页：超出最后一页时返回 404 或跳回第 1 页；`?ap>1` 的页面加 `noindex,follow`，或者把分页改成 button + fetch | 2 | 高 | 2–4 小时 |
| A4 | 处理登录链接：所有 `/login?returnTo=…` 链接加 `rel="nofollow"`，或者改成 button 触发跳转；同时在 `app/robots.ts` 里 `Disallow: /login?`（只屏蔽带参数的，保留 `/login` 本身） | 3 | 高 | 1–2 小时 |
| A5 | 修 sitemap 日期：`lib/services/posts.ts:1101` 改成 `` sql`…`.mapWith(post.publishedAt) ``，或者在 sitemap 里 `new Date(post.at)` | 6 | 中（修掉 GSC 报错） | 0.5 小时 |
| A6 | 处理 x-default 和无前缀 URL。官方 Ree 的内容是英文，建议：<br>① x-default 指向 `/en/…`<br>② 无前缀 URL 的 307 保留，但 Google 不应该再把它们当规范页；A1 生效后应该会改善<br>③ 如果 2–3 周后 GSC 里仍有 `/r/…` 被选为规范页，再考虑对 Googlebot（没有 Accept-Language、也没有 cookie）直接 308 到 `/en/…` | 4 | 高 | 2–4 小时 |
| A7 | 统一 Ree 页的语言版本：内容是英文的 Ree，zh 页的 canonical 指向 en 页（或者 zh 页加 noindex），并且只把 en 版放进站点地图。站点页面（首页、价格、关于、法律）是真的翻译了，继续保留双语和 hreflang。以后如果有中文内容的 Ree，就反过来处理。可以在 Ree 上加一个「内容语言」字段来决定 | 5 | 中高（站点地图减半，抓取更集中） | 0.5–1 天 |
| A8 | 修真正的 404：把 `(discover)/loading.tsx` 移到不包住 `r/[slug]`、`p/[id]` 的位置，或者在 `generateMetadata` 或 layout 里先查 Ree 是否存在再进入 Suspense；Ree 被下架时考虑返回 410 | 7 | 中 | 2–4 小时 |
| A9 | 增加爬虫能看到的内链：<br>① Explore 的分类改成 `<Link href="/explore?category=x">`，分类页设自引用 canonical，并有独立的 title 和 H1，例如「Technology & AI Rees」<br>② 增加服务端分页 `?page=N` 的普通链接（带 canonical），或者做 `/explore/[category]` 落地页<br>③ 首页固定展示一组热门或新上的 Ree 链接 | 8 | 高（3k 个 Ree 才能被发现） | 1–2 天 |
| A10 | 拆分站点地图：用 `generateSitemaps` 拆成 pages / rees-en / posts 等几个文件，便于在 GSC 里分段看收录率，也绕开现在 10k / 5k 的硬上限（`app/sitemap.ts:29`、`lib/services/posts.ts:1099`） | 监控 | 中 | 2–4 小时 |
| A11 | 修价格页结构化数据：把 `Product` 换成 `SoftwareApplication` 或 `WebApplication`（带 `offers`、`applicationCategory`）；或者最少补上 `image`，让商家信息不再报严重错误 | 10 | 低中 | 1 小时 |
| A12 | 修标题和 H1：<br>① Ree 页只保留一个 h1，把 `feed-columns` 里的那个降成 `p` 或 `h2`<br>② 帖子页 h1 用问题本身，description 优先用第一个回答的摘要<br>③ Explore 的 title 和 description 改得更有描述性 | 11 | 低中 | 2 小时 |
| A13 | 旧路由跳转：`/contact`、`/playground`、`/libraries`、`/legal` 用 301 跳到对应的新页面（例如 `/legal` 跳到 `/legal/terms`）；未登录用户访问 `/rees` 时跳到 `/explore`，而不是登录页 | 12 | 低 | 1 小时 |
| A14 | 加缓存：公开页面对匿名访客启用 ISR 或 CDN 缓存（例如 `s-maxage` + `stale-while-revalidate`），并减少首屏的 RSC payload | 13 | 中（长期 CWV） | 1–2 天 |
| A15 | 补结构化数据：帖子页加 `QAPage`，Explore 和分类页加 `CollectionPage` + `ItemList` | 富结果 | 低中 | 2–4 小时 |

**建议分三批做**（每批单独开分支，经 rebuild 合入后发布）：
- 第一批（当天能完成）：A1 + A4 + A5 + A3。
- 第二批：A2 + A6 + A7 + A8。
- 第三批：A9 + A10 + A12 + A11 + A13；A14 和 A15 视情况再排。

### B. 需要用户在 GSC 或内容侧做的事

| # | 事项 | 时机 | 说明 |
|---|---|---|---|
| B1 | 用 URL 检查确认修复生效 | A1 上线 3–7 天后 | 挑 `/en/r/ree-13n1bees`、`/zh/r/ree-enj1pgtw` 这样的页面，看「已编入版本」里的「用户声明的规范网页」是否已经是自己。**不要只看「测试实际网址」**，原因见问题 1 |
| B2 | 点「验证修复」 | B1 确认之后 | 在「重复网页，用户未选定规范网页」这一项上点。noindex 那一项（login 和搜索页）本来就是预期结果，不用验证 |
| B3 | 重新提交 sitemap.xml | A5、A7、A10 上线后 | 如果做了 A10 的拆分，就分别提交各个子站点地图，便于分段看收录 |
| B4 | 对少量重点页面「请求编入索引」 | A1 上线后 | 只挑约 10 个真实需求最强的页面：System Design Primer、Tokio Docs、NumPy、Radiation Oncology Wikibook、Choose a License 等。没必要批量请求 |
| B5 | 看 GSC 的 7 条未读消息 | 现在 | |
| B6 | 在 Bing Webmaster Tools 里从 GSC 导入站点 | 现在 | Bingbot 本来就能拿到 head 里的 metadata，几乎不用额外工作，能多一个流量来源 |
| B7 | 看数据时区分真实流量和噪音 | 持续 | 按「移动设备」或排除巴西、俄罗斯过滤着看；"X tutorial for renters" 这类模板查询不用去优化 |
| B8 | 优先充实已经有真实需求的 Ree 的内容 | 内容侧 | 例如 radiation oncology（第 1.3 位，168 展示，0 点击）、system design primer（第 9 位）、tokio rust（第 10 位）、deno documentation（第 10 位）。具体做法：<br>① 预置并公开 3–5 个高质量的已回答问答，直接渲染在 Ree 页上，替换掉「0 successful answers / No answered posts yet」这种空状态<br>② 标题里加上用户真正会搜的词，例如「Radiation Oncology Wikibook — Ask questions, get cited answers」。不要只写「Assistant」 |
| B9 | 决定 2.9k 个官方 Ree 是否全部需要被索引 | 内容侧 | 可以先只把有回答、有内容的 Ree 放进站点地图（或者暂时 noindex 空壳 Ree），把抓取预算集中到质量高的页面。这一项和 A7、A10 一起做最合适 |
| B10 | 争取外链 | 内容 / 运营 | 目前没有任何外链方面的数据。在 GitHub README、Product Hunt、相关社区放 Ree 链接，能加快 Google 的发现和信任 |

---

## 五、风险与验证方式

- **A1 的代价：** 对 Googlebot 阻塞式输出 metadata 后，Googlebot 看到的 TTFB 会变长（要等 `generateMetadata` 完成），普通用户不受影响。只加 Googlebot（不用 `/.*/`）可以把影响限制在爬虫范围内。
- **A4 的影响：** 用 robots.txt 屏蔽 `/login?` 后，Google 看不到这些页面的 noindex，但它们本来就是没有内容的登录页，最多出现「已编入，但被 robots.txt 屏蔽」的少量 URL-only 条目，可以接受。只加 `rel="nofollow"` 是更保守的选择。
- **A7 的取舍：** 去掉 zh 版的 Ree 后，中文搜索用户会直接落到英文页。内容本来就是英文的，而且「中文提问也能用」是产品功能，不受影响。Ree 页的界面语言可以继续按 cookie 或 Accept-Language 切换，不需要依赖 URL 前缀。
- **怎么验证：** 每批改完后，用 `curl -A "Googlebot/2.1"` 检查 head 里的 title、canonical、hreflang，检查参数 URL 的链接数和 404 状态码。上线 1–2 周后，在 GSC 里看「重复网页」和「noindex」的数量趋势，以及站点地图 URL 的编入率（现在是 253/6,680）。
