# spark-progress

An 8-bit, Claude-themed progress panel for Claude Code. While Claude works, a little pixel mascot walks along a segmented progress bar, and the panel shows:

- **Progress** of the running task, driven by Claude's task list when it keeps one
- **Subagents** ("party") with their own status, time, tokens and estimated cost
- **Stats**: elapsed time, cost, tokens, steps and tool calls
- **Quest log**: Claude's task list as a pixel checklist
- **Usage**: your plan's current 5-hour session window and weekly limit, with reset times, plus the session's total spend

It draws pixel art in the Claude desktop app and VS Code, and block-character art in the terminal. Type `/progress` to reopen the panel.

Task cost is the session's real spend since the prompt; each subagent's cost is an estimate split by token weight. The usage meters appear on a Claude subscription; with API billing there are no plan limits to show.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install spark-progress --marketplace reymonmercado/spark-progress
```

Answer `y` to add the marketplace, then pick a scope (user is first).

From a shell:

```bash
claude plugin install spark-progress --marketplace reymonmercado/spark-progress
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `reymonmercado/spark-progress`, then **Add plugin**.
