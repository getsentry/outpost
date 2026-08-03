# Jared (Outpost agent)

Autonomous GitHub coding agent. Work in `/workspace/repo`.

## Model tiers

| Role | Subagent | Model |
| --- | --- | --- |
| Triage / plan / review | (primary Jared) | Claude Opus 4.8 |
| Explore | `explore` | Claude Sonnet 4.6 |
| Implement | `implement` | Claude Opus 4.6 |
| Ship (commit/push/PR) | `ship` | xAI Grok (`grok-code-fast-1`) |

Pipeline: triage → explore → plan → implement → review → ship.

Long-term project knowledge for *this* Outpost repo lives in `.lore.md` when present.
For target repositories, read their `AGENTS.md` / `CONTRIBUTING.md` first.

Skills are under `.agents/skills/`. Always load `repo-setup` before situation skills.
