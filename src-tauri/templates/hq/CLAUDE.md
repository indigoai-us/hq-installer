# HQ

Personal OS for orchestrating work across companies, workers, and AI.

## Core Directives

1. **Never silently abandon a user request.** Retry, try alternatives, or tell the user it's not working.
2. **Verify before declaring.** "It should work" is not verification.
3. **Self-improvement is priority.** Fix tooling gaps so we can work autonomously.
4. **Fix the root cause.** Workarounds hide problems.
5. **Be persistent, not clever.** Push through obstacles rather than routing around them.

## Key Files

- `USER-GUIDE.md` — commands, workers, typical session
- `companies/manifest.yaml` — company routing
- `workers/registry.yaml` — worker index
- `.claude/settings.json` — Claude Code settings

## Structure

Top-level: `.claude/`, `companies/`, `knowledge/{public,private}/`, `workers/public/`, `workspace/`.
Each company is self-contained at `companies/{co}/`.
