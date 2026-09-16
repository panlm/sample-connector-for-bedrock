# Auto-merge：流水线 PR 自动合并说明

`.github/workflows/auto-merge.yml` 会在 `build` 工作流跑绿后，对满足条件的流水线 PR
自动执行 squash 合并并删除分支。本页写给「想提 PR 的人」，说明什么时候会自动合、
怎么让它合、以及没合时去哪查原因。

## 什么时候会自动合

只有当 `build` 工作流以 `success` 结束、且触发事件是 `pull_request` 时，`merge` job 才启动
（`if:` 条件，L23）。build 没绿，auto-merge 根本不会运行。随后它按 head SHA 找到对应的 open PR
（L33-35）；找不到就直接跳过，什么都不做。

## 自动合的全部条件

`Gate and merge` 步骤逐条检查，任一不满足即**拒绝**（不合，但不报错）：

- 不是跨仓（fork）PR —— 跨仓一律不合（L56）。
- 分支名以 `agent/` 开头 —— 只合流水线自己开的分支（L57）。
- 目标分支是 `main`（L58）。
- 带 `auto-merge` label —— 必须显式 opt-in（L60-61）。
- 可干净合并：`mergeable == MERGEABLE`，且状态不是 `DIRTY/BLOCKED/BEHIND`（L63-65）。
- 所有 check 全绿：任一 check 状态不在 `SUCCESS/SKIPPED/NEUTRAL` 就拒；读不到状态也拒，绝不盲合（L67-72）。
- PR 正文声明了 `Auto-merge-paths:`（L74-78）。
- 所有变更文件都落在声明范围内（L79-81）。

## 提 PR 必做的两件事

缺任一件都不会自动合：

1. PR **正文**里写一行：`Auto-merge-paths: <覆盖所有改动的 glob>`，多个用 `,` 分隔。
2. 给 PR 打 label：`gh pr edit <n> --add-label auto-merge`。

## `Auto-merge-paths:` 怎么写

- 写在 PR **正文**里独占一行；行首（大小写不敏感）为 `auto-merge-paths:`，冒号后按 `,` 分隔为若干 glob（L74-77）。
- CI 对每个变更文件做 `fnmatch` 匹配，要求至少命中一个声明的 glob（L79-80）。
- 它是**白名单**：只要有一个变更文件没被任何 glob 命中，整单就被拒（L81）。所以务必覆盖本次改动的**每一个**文件。
- 例：本页只改一个文件，写 `Auto-merge-paths: docs/pipeline/auto-merge.md` 即可。

## 没自动合怎么排查

去 GitHub Actions → `auto-merge` 工作流 → `merge` job → `Gate and merge` 步骤日志，
找 `::notice::auto-merge declined for #<n>: <原因>` 那条注解（L52-53）。拒绝时脚本以
`exit 0` 结束（L54），所以 **auto-merge job 显示「绿」不代表合了** —— 被拒不是构建失败，
必须看 notice 才知道是否真的合并（通过时是 `gates passed` notice，L82）。

## 为什么放在 CI 而不是交给 agent 判断

因为 agent 改不了 `.github/`、runtime 的 gh token 也没有 `workflow` scope，把合并策略放 CI
是流水线唯一无法自我改写的地方（L3-6）。

## 常见拒绝原因

按「最常见 → 最少见」排；notice 文字为 `deny(...)` 输出的 `<msg>` 原文（L52-53），变量以占位符标注。

| 拒绝原因 | Actions 里的 notice 文字 | 怎么修 |
|---|---|---|
| 忘打 `auto-merge` label | `no auto-merge label` | `gh pr edit <n> --add-label auto-merge`（L60-61） |
| 正文没写声明行 | `` PR body has no `Auto-merge-paths:` declaration `` | 正文独占一行写 `Auto-merge-paths: <glob>`（L74-78） |
| 变更文件超出声明范围 | `files outside declared ownership: [...]` | 扩大 glob 覆盖每个改动文件，或拆掉越界改动（白名单，L79-81） |
| check 没全绿 | `checks not green: <name>=<state>, ...` | 按报错 check 名修复后 push，等重新跑绿（L71-72） |
| 读不到 check 状态 | `cannot read check status (rc=<n>) — refusing to merge blind` | 重跑 build 触发；确认 checks 已注册、非空（L69-70） |
| 存在冲突/不可干净合并 | `mergeable=<值>` | rebase/合 main 解冲突，等回到 `MERGEABLE`（L63） |
| 合并状态被拦（脏/受阻/落后） | `mergeStateStatus=<DIRTY\|BLOCKED\|BEHIND>` | 更新分支到最新 main、满足分支保护后重试（L64-65） |
| base 不是 `main` | `base is <x>, not main` | 把 PR 的 base 改成 `main`（L58） |
| 分支名不以 `agent/` 开头 | `head <名> is not agent/*` | 用 `agent/` 前缀的分支重开 PR（L57） |
| 跨仓（fork）PR | `cross-repository PR` | 从本仓分支开 PR，不要从 fork 提（L56） |
