---
id: hq-installer-staging-prerelease-template-sync
title: Sync staging prerelease artifacts into embedded templates
scope: repo
trigger: launch testing hq-installer against hq-core-staging
enforcement: soft
public: false
version: 1
created: 2026-05-14
updated: 2026-05-14
source: session-learning
---

## Rule

ALWAYS: For hq-installer launch testing against hq-core-staging, use an explicit staging prerelease artifact and sync it into the embedded template before local build/test; the app embeds templates at build time and does not dynamically fetch them on the happy path.

## Rationale

Captured from handoff learning for `repo:hq-installer`. Local build and launch tests need the staged artifact already present in the embedded template because the happy path uses build-time templates.
