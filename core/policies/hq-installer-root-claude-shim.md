---
id: hq-installer-root-claude-shim
title: Preserve root CLAUDE.md compatibility
scope: repo
trigger: moving or consolidating canonical HQ instructions for hq-installer
enforcement: soft
public: false
version: 1
created: 2026-05-14
updated: 2026-05-14
source: session-learning
---

## Rule

ALWAYS: Preserve Claude Code root CLAUDE.md compatibility when moving canonical HQ instructions; if .claude/CLAUDE.md is canonical, ship a root CLAUDE.md shim that imports it.

## Rationale

Captured from handoff learning for `repo:hq-installer`. This preserves compatibility for Claude Code entry points when canonical HQ instructions move under `.claude/`.
