# HQ User Guide

## What is HQ?

HQ is your personal operating system for orchestrating work across companies,
workers, and AI. It's a filesystem convention + a set of Claude Code commands
that turn a directory into a workspace you can drive like a team.

## Typical session

1. Open HQ in Claude Code: `claude` (from inside the HQ directory)
2. Orient: `/startwork` — loads context for the current project
3. Do the work via commands, workers, or direct conversation
4. Checkpoint: `/checkpoint` or `/handoff` when context runs low

## Commands

Commands live in `.claude/commands/` and are invoked with `/name`:

- `/prd <project>` — create a project with a full PRD
- `/run <worker> <skill>` — delegate to a worker
- `/checkpoint` — save session state
- `/handoff` — prepare a clean handoff for a new session

See `knowledge/public/hq-core/quick-reference.md` for the full catalog.

## Workers

Workers live in `workers/public/` (shared) and `companies/{co}/workers/`
(company-scoped). Each worker has a `worker.yaml` declaring its role, skills,
and knowledge pointers. Run one with `/run <worker> <skill>`.

## Knowledge

Two tiers:

- `knowledge/public/` — versioned, shareable knowledge (optionally symlinked to git repos)
- `knowledge/private/` — local-only knowledge (not committed unless you want it to be)

Search with `qmd search "<query>"` once `qmd` is installed and indexed.
