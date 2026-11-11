# OpenCode Configuration

Global OpenCode V2 configuration (`~/.config/opencode`). Defines a delegation-based agent fleet, a planning command, plugins, and one MCP server.

## Agent Fleet (`agents/`)

| Agent | Model | Mode | Permissions | Role |
|---|---|---|---|---|
| `orchestrator` | `google-agy/gemini-4-argon#medium` | primary | edit/shell ask; `git *` denied | Lead architect: decomposes work, delegates to subagents, reviews results. No direct edits or git. |
| `executor` | `zai-coding-plan/glm-5.3` | all | edit/shell allow; `git *` denied | Feature implementation, refactoring, technical docs, security hardening. |
| `scripter` | `zai-coding-plan/glm-5.3-flash` | all | edit/shell allow | Automation scripts, test suites, small bug fixes. |
| `ingestor` | `google-agy/gemini-3.8-flash#high` | subagent | read-only: edit denied; shell allow except `rm *` | Scans large codebases, CI/build logs, docs, telemetry. Cites paths and line numbers. |
| `git-tracker` | `google-agy/gemini-3.8-flash#high` | subagent | edit and non-git shell denied; `git *`/`gh *` allowed; destructive git (`reset --hard`, force push, `clean`) requires ask | Only agent that touches git: status/diff/log, staging, conventional commits, `gh` for PRs/issues. |

Only `git-tracker` runs git commands; every other agent's prompt forbids it.

## Commands (`commands/`)

- **`/plan <objective>`** — runs on `orchestrator`. Collects the objective plus current `git status`, decomposes it into milestones, and produces a task checklist with assigned subagents, verification/rollback criteria, and least-privilege delegation. Read-only: no modifications during planning.

## Plugins & MCP

Configured in `opencode.json` (plus `opencode-quota/settings.jsonc` and `cli.json`):

- **Plugins**
  - `@dietrichgebert/ponytail` — minimal-diff coding discipline.
  - `@slkiser/opencode-quota` — quota display; tuned in `opencode-quota/settings.jsonc` (line bar, 5-hour status window, no toasts).
  - `@anthonyhaussman/opencode-agy-auth` — auth for the `google-agy` provider.
- **MCP server: `chrome-devtools`** — `chrome-devtools-mcp@latest` driving headless Chromium (`/run/current-system/sw/bin/chromium`), isolated, no usage statistics.
- **`cli.json`** — TUI theme only.

## Ignored Local State (`.gitignore`)

Runtime files not tracked:

- `service.json`
- `antigravity-signature-cache.json`
- `antigravity-turn-states.json`
