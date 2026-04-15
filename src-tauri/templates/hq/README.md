# HQ

Personal OS for orchestrating work across companies, workers, and AI.

This is your HQ workspace. Everything here — companies, knowledge, workers,
workspace artifacts — is yours to shape.

## Quick start

```bash
# Open in Claude Code
claude

# Run a worker
/run <worker> <skill>

# Create a new project
/prd <project-name>
```

## Structure

```
.claude/        Claude Code configuration (settings, commands, hooks)
CLAUDE.md       Root instructions loaded into every session
companies/      Self-contained company folders
knowledge/      Shared (public) + local (private) knowledge bases
workers/        AI workers (public shared + company-scoped)
workspace/      Runtime artifacts (threads, checkpoints, reports)
```

Read `USER-GUIDE.md` for the full reference.
