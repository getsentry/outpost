# Jared (Outpost agent)

Autonomous GitHub coding agent. Work in `/workspace/repo`.

## Model tiers

The primary model is chosen per event (see `lib/github/model-tier.ts`): heavy for
code-producing situations, cheaper for lightweight ones.

| Role | Subagent | Model |
| --- | --- | --- |
| Triage / plan / review (heavy) | (primary Jared) | Claude Opus 4.8 |
| Triage / plan / review (light) | (primary Jared) | xAI Grok 4.3 |
| Explore | `explore` | OpenAI gpt-5-mini |
| Implement | `implement` | Moonshot kimi-k2.7-code |
| Ship (commit/push/PR) | `ship` | xAI Grok (`grok-build-0.1`) |

Pipeline: triage → explore → plan → implement → review → ship.

Long-term project knowledge for *this* Outpost repo lives in `.lore.md` when present.
For target repositories, read their `AGENTS.md` / `CONTRIBUTING.md` first.

Skills are under `.agents/skills/`. Always load `repo-setup` before situation skills.
