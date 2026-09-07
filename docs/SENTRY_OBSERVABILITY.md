# Jared Sentry observability

Jared uses two Sentry projects in the same organization:

| Project | Covers | Primary signals |
| --- | --- | --- |
| `jared-server` | Worker, Durable Object, Flue lifecycle, and the sandbox boundary | errors, logs, traces |
| `jared-web` | browser dashboard | browser errors, transactions, error-only replay |

The thin Cloudflare Sandbox is not an instrumented application. Jared traces the
Worker/DO-to-sandbox preparation boundary and Flue tool spans, but never injects
a Sentry DSN, build token, or SDK into a cloned repository or sandbox process.

## Correlation model

The request trace reaches Worker and Durable Object RPC where Cloudflare supports
the standard `sentry-trace` and `baggage` propagation headers. Flue submission
admission is asynchronous, so it is not represented as a falsely continuous
synchronous trace. Join those surfaces using these tags instead:

| Tag | Meaning |
| --- | --- |
| `flue.submission.id` | exact immutable Flue admission/settlement id |
| `jared.entity_key` | Jared conversation/entity identity |
| `jared.event_id` | stored webhook event id |
| `jared.agent_generation` | lifecycle fence for scheduled work |
| `jared.lifecycle_status` | preparing, admitting, admitted, scheduled, dropped, settled, or failed |
| `jared.sandbox_id` | thin Sandbox identity |
| `jared.source` | Worker dispatch, reconciliation, cron, or Durable Object boundary |

`jared.sandbox.prepare` records duration, phase, identity, outcome, and a stable
failure class only. `jared.flue.admit`, follow-up scheduling/admission, and
`jared.maintenance.heartbeat` make lifecycle progress visible. The cron handler
also persists its existing `maintenance_runs` heartbeat in D1.

## Data policy

By default, Sentry receives metadata only: timing, token usage, model and tool
identifiers, and correlation ids. It does not receive prompts, system
instructions, repository content, commands, tool arguments/results, model
output, raw runtime log messages, request data, breadcrumbs, or exception
messages/stacks. Flue terminal failures produce one captured event per exact
submission and are grouped by their safe failure type.

`SENTRY_AI_RECORD_INPUTS=true` and `SENTRY_AI_RECORD_OUTPUTS=true` are explicit,
independent opt-ins. They should only be enabled after a data-retention review.
Their content still passes the redaction policy; do not enable them for normal
operation merely to debug a single incident.

## Runtime configuration

Server bindings:

```sh
SENTRY_DSN=...                         # jared-server DSN
SENTRY_ENVIRONMENT=staging
SENTRY_RELEASE=outpost@<commit> # required for matching source-map uploads
SENTRY_TRACES_SAMPLE_RATE=1            # optional; staging default is 1
SENTRY_AI_RECORD_INPUTS=false
SENTRY_AI_RECORD_OUTPUTS=false
```

The production default is `0.1`; staging defaults to `1`. Errors, terminal
failures, and metadata-only logs are independent of trace sampling. Browser
settings use `VITE_SENTRY_*` counterparts plus `VITE_JARED_API_ORIGIN`; browser
trace propagation is disabled until that one API origin is supplied. The Sentry
Vite plugin embeds `SENTRY_RELEASE` into the browser by default (or honors a
matching explicit `VITE_SENTRY_RELEASE`); Replay is error-only (`1.0` on error,
`0` for session sampling).

## Source maps

The Vite build reads build-runner-only values, never Worker bindings or
`VITE_*` values:

```sh
SENTRY_AUTH_TOKEN=...                  # build runner only
SENTRY_ORG=<organization-slug>
SENTRY_SERVER_PROJECT=jared-server
SENTRY_WEB_PROJECT=jared-web
SENTRY_RELEASE=outpost@<commit> # must match the deployed Worker release
```

When the matching token, organization, and project exist, the build emits hidden
maps, uploads them to its target project, and deletes them after a successful
upload. Without those values, the source-map plugin is disabled and no token can
reach the Worker or a sandbox.

## Search recipes

Start from the exact known submission id after a webhook admission:

```text
flue.submission.id:sub_...
```

Then narrow to a lifecycle stall:

```text
jared.lifecycle_status:preparing OR jared.lifecycle_status:admitting
```

Useful transaction/span names are `jared.sandbox.prepare`, `jared.flue.admit`,
`jared.follow_up.schedule`, `jared.follow_up.admit`, and
`jared.maintenance.heartbeat`. For a terminal failure, search
`exception.type:FlueTerminalFailure` with `flue.submission.id`; there should be
one captured event for that terminal submission. Browser requests should only
show propagation to the configured Jared API origin.

## Local collector workflow

Use a non-production DSN and a bounded local run. First verify the application
already has a runnable local command and inspect `sentry local --help`; then run
`sentry local serve` in a separate terminal. Configure the app to use the
collector endpoint it advertises, start the app, and reproduce one minimal
dashboard request plus one webhook-to-agent flow. Stop both processes after the
trace is received. Do not print DSNs, auth tokens, webhook payloads, prompts,
or collector request bodies.

For an integration/staging proof, use a non-writing GitHub credential and record
the submission id while exercising: dashboard/browser request, webhook dispatch,
DO execution, sandbox preparation/tool activity, successful settlement, and one
controlled terminal failure. Production rollout remains gated on evidence from
both Sentry projects: resolved source maps, expected trace/log/issue grouping,
and cron-heartbeat visibility.
