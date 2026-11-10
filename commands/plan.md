---
description: Formulate a multi-stage execution plan and delegate tasks across the subagent fleet.
agent: orchestrator
subagent: false
---
You are activating planning mode for the following objective:

### Objective
$ARGUMENTS

### Context & Working Tree
- Current repository state:
!`git status --short 2>/dev/null || echo "Not a git repository"`

### Planning Directives
1. **Scope & Decomposition:**
  - Analyse the technical scope, dependencies, and architectural requirements.
  - If security or administrative controls are involved, map out relevant threat boundaries, permission requirements, and audit verification steps.
  - Deconstruct the goal into distinct, sequential milestones.

2. **Deliverable:**
  - Present a structured execution plan covering:
    - High-level architecture and decisions.
    - Step-by-step task checklist with designated subagents.
    - Verification, testing, and rollback criteria.
  - Ask for confirmation before initiating destructive actions or mass code changes.
  - Do not perform any modifications during plan mode.

3. **Fleet Delegation**
  - You may deploy any of the available subagents defined inside your directives to perform their respective tasks that would help you formulate the final plan.
  - Try to apply the principle of least coverage / privileges if possible.
    - For example, if you need to read the folder structure, deploy many ingestor / read-only subagents and aggregate their responses instead of reading everything yourself.
