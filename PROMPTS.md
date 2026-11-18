# Reusable Codex Prompts

## Next task

```text
Read AGENTS.md, GOALS.md, PLANS.md, tasks/plan.md, tasks/todo.md, and harness/build-log.md. Select only the first unchecked task whose dependencies are complete. Implement it incrementally, run its verification commands, record evidence in harness/build-log.md, and update tasks/todo.md. Do not start the next task.
```

## Run from PowerShell

Run one task with approval prompts:

```powershell
.\tools\run-next-task.ps1
```

Run up to three tasks, stopping on the first failure or when the task list does not change:

```powershell
.\tools\run-plan.ps1 -MaxTasks 3
```

The runner enables Codex automatic review by default. Disable it only when you have a separate controlled approval workflow:

```powershell
.\tools\run-plan.ps1 -MaxTasks 3 -NoAutomaticReview
```

Do not use `-NoAutomaticReview` for tasks involving credentials, destructive operations, deployment, or external writes.

## Continue phase

```text
Continue the current phase from the first unchecked task. Read the repository guidance and current build log first. Preserve all existing work, implement one task, verify it, record evidence, and stop at the phase checkpoint.
```

## Review before merge

```text
Review the current diff against AGENTS.md, GOALS.md, PLANS.md, and the task acceptance criteria. Run the focused tests and report findings. Do not modify code unless explicitly asked.
```
