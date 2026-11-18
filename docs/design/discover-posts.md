# Home, posts and the three-column frame (v5)

Design for PRs #159 (frame) and the public-posts PR that follows it. The full mock-ups (rendered with re0.io's production CSS, desktop and phone) are an artifact, not a file in the repo: https://claude.ai/artifact/CGdkGa65zgLMCjd9s1GRV5

## What it settled (A1–A4, N1–N9, P1–P16, all as recommended)

- **Twitter-style frame.**
  - Left navigation: 首页, 发现, 通知, 我的帖子, 我的 Ree, 收藏, 活动, plus a round 发帖 button. Plan usage and the account sit at the bottom.
  - Centre: a single column.
  - Right column: search and suggestions, folding away below 1100px.
  - Phones: five bottom icons and a floating 发帖 button.
  - Visitors get the same frame with 首页, 发现, 价格 and 了解 RE0, plus a blue sign-in bar.
- **`/` is 首页, the feed.** Visitors see a short introduction first. The rest of the old marketing home moves to `/about`. 发现 (`/explore`) is search and browsing: Rees, posts, and unanswered posts.
- **Posts.**
  - The composer has two tabs.
  - 公开帖子: up to 5 relevant Rees answer it on their own. Matching takes 10 candidates and keeps those with best-passage similarity ≥ 0.45 that take posts. A mentioned Ree always answers. The platform pays; owners earn nothing.
  - 私密提问: today's conversation, unchanged. Older conversations show as private posts and are not migrated.
- **Billing.**
  - Each day has 3 free public posts (UTC). After that, 40 credits are held at publishing and settled once a Ree answers.
  - The 40 credits are refunded, and the post does not use a free slot, when review rejects the question or no Ree answers.
  - A round-table summary costs 30 credits; only the author can request it, and everyone can read it.
  - Free Rees answer by default; paid Rees only when their owner opts in.
- **Post page `/p/[id]`.**
  - Answers come with citations, 有帮助, 复制链接, 举报, and 继续问. 继续问 starts a private, per-question-charged conversation seeded with that answer.
  - States shown: answering, unanswered, rejected.
  - The page is indexed once it has an answer.
- **我的帖子** has tabs 全部 / 公开 / 私密 / 回收站, and ⌘K searches it.
- **Other changes.**
  - 通知 is its own page, with a new notice: 帖子有新回答.
  - 收藏 holds both Rees and posts.
  - On the Ree page, 回答的帖子 replaces 问答.
  - #158's public Q&A becomes single-answer posts.
