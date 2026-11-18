# Discover as a feed (v3)

Design for PR #158. The full mock-ups (rendered with re0.io's production CSS, phone and desktop) are an artifact, not a file in the repo: https://claude.ai/artifact/6nSsgNDrDMXr6SWR7o26Lb

## What it settled

- **Explore is a single column of Rees.** No questions or answers are in the feed. Each item shows avatar, name, author and role, when it last answered, introduction, category and price, cover, this week's activity, and answers / rating / favourite / share / 提问. A right column holds search, free rounds, the most-asked Rees and the knowledge banner.
- **The Ree page carries its public Q&A (问答).** A question box sits on top. Visitors ask free Rees with the daily anonymous rounds; signed-in users ask as in a conversation. Below that is the stream of published answers: pinned first, then newest. Its actions are 有帮助, 我也问一句, 复制链接 and 举报; the owner can also pin and hide.
- **Publishing is opt-in per question ("回答后公开").** It applies to the first turn only. The text is redacted (e-mail, IDs, long numbers in any width or numerals, links in the question) and reviewed by a model before it shows. The owner can turn public Q&A off for a Ree.
- **Reports.** Three distinct reporters (accounts, or visitors counted once per network) hide an answer until an administrator looks. An administrator cannot restore an answer the owner hid.
- **The share page `/s/[slug]`** shows two picks from the public Q&A (大家问过的) and the same anonymous question box.
