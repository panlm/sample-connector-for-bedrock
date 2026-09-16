# Auto-merge FAQ：常见拒绝原因答疑

本页配套 `docs/pipeline/auto-merge.md` 的「常见拒绝原因」排查表，用问答形式讲清几种最常撞到的拒绝。完整表格与行号请以该文件为准。

下面的表头行与部分表格内容，原样引自 `docs/pipeline/auto-merge.md` 的 `## 常见拒绝原因`：

> | 拒绝原因 | Actions 里的 notice 文字 | 怎么修 |
> |---|---|---|
> | 忘打 `auto-merge` label | `no auto-merge label` | `gh pr edit <n> --add-label auto-merge`（L60-61） |
> | 正文没写声明行 | `` PR body has no `Auto-merge-paths:` declaration `` | 正文独占一行写 `Auto-merge-paths: <glob>`（L74-78） |
> | 变更文件超出声明范围 | `files outside declared ownership: [...]` | 扩大 glob 覆盖每个改动文件，或拆掉越界改动（白名单，L79-81） |
> | check 没全绿 | `checks not green: <name>=<state>, ...` | 按报错 check 名修复后 push，等重新跑绿（L71-72） |
> | 读不到 check 状态 | `cannot read check status (rc=<n>) — refusing to merge blind` | 重跑 build 触发；确认 checks 已注册、非空（L69-70） |

### 问：我的 PR 一直不自动合，Actions 全绿也没报错，为什么？

auto-merge job 显示绿 ≠ 已合。去看那条 `::notice::auto-merge declined`——最常见的就是「忘打 `auto-merge` label」：notice 文字是 `no auto-merge label`，补一句 `gh pr edit <n> --add-label auto-merge` 即可。

### 问：notice 里写 `files outside declared ownership: [...]`，我明明写了 `Auto-merge-paths` 啊？

这是白名单命中问题（「变更文件超出声明范围」那行）：只要有任一变更文件没被你的 glob 命中，整单就会被拒。把 glob 扩大到覆盖每个改动文件，或拆掉越界的改动。

### 问：我正文里写了 `Auto-merge-paths`，怎么还提示没声明？

对应「正文没写声明行」那行，notice 是 `PR body has no Auto-merge-paths: declaration`。声明必须独占一行、行首就是 `Auto-merge-paths:`，不能塞进代码块或跟别的文字挤在一行。

### 问：`checks not green` 和 `cannot read check status ... refusing to merge blind` 有什么区别？

前者（「check 没全绿」行）是有 check 没到绿，按报错 check 名修完再 push、等重新跑绿；后者（「读不到 check 状态」行）是压根读不到状态，CI 拒绝盲合，需重跑 build 触发、确认 checks 已注册且非空。
