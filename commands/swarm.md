---
description: Execute a complex objective using a coordinated multi-agent swarm pipeline with hashed state tracking.
agent: orchestrator
subagent: false
---
Execute the objective below using the 5-stage Swarm Pipeline Protocol.

## Objective

$ARGUMENTS

## Workspace Context

- Working directory: `!`pwd``
- Git state: `!`git status --short -b 2>/dev/null || echo "Not a git repository"``
- Swarm run hash ID: `!`printf '%s' "$ARGUMENTS-$(date +%s)" | sha256sum | cut -c1-8``
- Timestamp (UTC): `!`date -u +"%Y-%m-%dT%H:%M:%SZ"``

## Swarm Pipeline Protocol

You are the orchestrator of this swarm. Run all five stages in order, persisting state after each transition.

### Stage 1 — Hashed State Init & Parallel Recon (`ingestor` swarm / `scripter`)

1. Using the Swarm run hash ID above as `<hash>`, persist initial state to `.swarm/swarm-<hash>.json` and copy it to `.swarm/latest.json`. Initial shape:
   ```json
   {
     "id": "<hash>",
     "file": ".swarm/swarm-<hash>.json",
     "objective": "$ARGUMENTS",
     "createdAt": "<timestamp>",
     "updatedAt": "<timestamp>",
     "status": "running",
     "currentStage": "recon",
     "currentWave": 1,
     "totalWaves": null,
     "waves": []
   }
   ```
2. Spawn multiple read-only `ingestor` subagents concurrently (parallel `subagent` tool calls) to scan relevant files, dependencies, and constraints. Each returns compressed findings (paths, symbols, risks) you use for planning.

### Stage 2 — DAG Wave Decomposition & Scope Locking

1. Decompose the work into sequential dependency waves (`Wave 1`, `Wave 2`, ...) based on the recon findings. Tasks within a wave are independent; tasks across waves may depend on earlier waves.
2. **Disjoint scope invariant:** every task in the same wave MUST declare a strictly disjoint `files_touched` array. No two parallel tasks in the same wave may edit the same file. If overlap is unavoidable, place the conflicting tasks in sequential waves, or isolate one via `tools.opencode.worktree_create`.
3. Update `.swarm/swarm-<hash>.json` and `.swarm/latest.json` with the full `waves` and per-wave `tasks` arrays (each task: id, description, agent, `files_touched`, `status: "pending"`), setting `totalWaves` and transitioning `currentStage: "plan"` -> `"execute"`.

### Stage 3 — Parallel Wave Execution (`executor` & `scripter` swarm)

1. For each wave in order, dispatch ALL tasks in that wave concurrently via parallel `subagent` tool calls (route multi-file builds/refs to `executor`; scripts, tests, and glue code to `scripter`). Each task's prompt must be self-contained and list its `files_touched`.
2. Wait for the wave to finish before starting the next. After each wave, update task statuses (`"completed"` / `"failed"`) and `currentWave` in `.swarm/swarm-<hash>.json` and `.swarm/latest.json`.
3. On task failure: retry once with corrected instructions, or reschedule into a later wave; never silently drop a failed task.

### Stage 4 — Verification & QA Gate (`scripter` & `ingestor`)

1. Update `currentStage: "verify"` in both state files.
2. Dispatch in parallel:
   - `scripter`: run tests, lint, and syntax checks across everything the waves touched; report failures with file:line.
   - `ingestor`: audit cross-file contracts (imports, exports, API signatures) and verify security/scope compliance — no task edited files outside its declared `files_touched`.
3. If verification fails, loop back to Stage 3 with a minimal remediation wave before proceeding.

### Stage 5 — Synthesis & Git Handoff (`git-tracker`)

1. Update `currentStage: "commit"` -> `"done"` and `status: "completed"` in `.swarm/swarm-<hash>.json` and `.swarm/latest.json`.
2. If in a git repository and a commit is requested or appropriate, delegate to `git-tracker`: verify `git status` / `git diff`, ensure `.swarm/` state files are NEVER staged, and commit the work. Do not run git commands yourself.
3. Return a synthesis: what each wave produced, verification results, and the final state file path.
