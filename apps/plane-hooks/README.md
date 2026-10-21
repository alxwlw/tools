# plane-hooks

A small [Bun](https://bun.sh) webhook receiver that turns Grafana alerts, Vercel deployment events
and backend-deploy reports from CI into work items and comments in one [Plane](https://plane.so)
project. It has no runtime dependencies.

## Inputs

| Path             | Source                        | Authentication                                             | Enabled                                 |
| ---------------- | ----------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `/hooks/grafana` | Grafana webhook contact point | `Authorization: Bearer ph_<48 hex>`                        | always                                  |
| `/hooks/vercel`  | Vercel webhook                | `x-vercel-signature`, hex HMAC-SHA1 of the raw body        | when `PLANE_HOOKS_VERCEL_SECRET` is set |
| `/hooks/deploy`  | CI `report-deploy` job        | `x-plane-hooks-signature`, hex HMAC-SHA256 of the raw body | when `PLANE_HOOKS_DEPLOY_SECRET` is set |
| `/healthz`       | probes                        | none, answers `ok`                                         | always                                  |

A disabled input answers 404. The `listening` log line at startup lists the enabled inputs, for
example `{"event":"listening","port":8080,"inputs":["grafana"]}`.

## Configuration

| Variable                    | Required | Format and meaning                                                                         |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `PLANE_HOOKS_PLANE_URL`     | yes      | Plane base URL, `http(s)://…`, e.g. `https://plane.example.com`                            |
| `PLANE_HOOKS_WORKSPACE`     | yes      | Workspace slug                                                                             |
| `PLANE_HOOKS_PROJECT_ID`    | yes      | Bare project UUID, the part of `…/projects/<UUID>/issues` (not the URL)                    |
| `PLANE_HOOKS_PLANE_API_KEY` | yes      | Plane API token                                                                            |
| `PLANE_HOOKS_GRAFANA_TOKEN` | yes      | `ph_` followed by 48 lowercase hex digits, e.g. generate with `ph_$(openssl rand -hex 24)` |
| `PLANE_HOOKS_VERCEL_SECRET` | no       | Vercel webhook secret; unset turns the input off                                           |
| `PLANE_HOOKS_DEPLOY_SECRET` | no       | Shared HMAC key for CI deploy reports; unset turns the input off                           |
| `PORT`                      | no       | Listen port, default `8080`                                                                |

A missing or malformed required variable stops the service at startup. An optional secret that is
set but blank is also a startup error: unset it to disable the input.

## Incident behaviour

The incident key is the alert fingerprint.

- The first firing delivery creates a work item.
- A repeated firing delivery adds a comment.
- If the work item is closed, it is reopened to the project's default state.
- If it is archived, it is unarchived first, then reopened.
- A resolved delivery adds the comment «Погас» (resolved). It never closes the work item and never
  unarchives it: closing stays a human decision.
- A repeated delivery of the same event is a no-op (deduplicated by `external_id`).

### Priority of an alert

The `severity` label is compared after trim and lower-casing; the `env` label defaults to `prod`.

| `severity`       | `env` other than `staging` | `env` = `staging` |
| ---------------- | -------------------------- | ----------------- |
| `critical`       | urgent                     | high              |
| `warning`        | high                       | medium            |
| missing or other | urgent                     | high              |

Failed Vercel deployments get `high` (production) or `medium`; failed CI deploy reports get
`urgent` (production) or `high`.

Releases for production deploys need the Plane releases feature, which a Free-plan workspace lacks
(the API answers 402): releases are not available there.

## Grafana contact point

```yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: plane-hooks
    receivers:
      - uid: plane-hooks
        type: webhook
        settings:
          url: https://hooks.example.com/hooks/grafana
          httpMethod: POST
          authorization_scheme: Bearer
          authorization_credentials: $PLANE_HOOKS_GRAFANA_TOKEN
        disableResolveMessage: false
```

Two traps of Grafana's env substitution in provisioning files:

- Keep `url` a literal. A `webhook.url` taken from an env variable that is empty at provisioning
  time makes the whole contact point fail validation.
- Grafana re-parses a substituted value as YAML, so a token made only of digits turns into an
  integer. The mandatory `ph_` prefix keeps the token a string.

`disableResolveMessage: false` is required for the «Погас» comment: with `true` Grafana never sends
the resolved notification.

## Image

Every push to `main` that touches this app publishes `linux/amd64` images to
`ghcr.io/alxwlw/plane-hooks`, tagged `:<commit sha>` and `:main`. The digest is printed in the job
summary; deploy by digest, not by tag:

```bash
docker run --rm -p 8080:8080 \
  -e PLANE_HOOKS_PLANE_URL=https://plane.example.com \
  -e PLANE_HOOKS_WORKSPACE=example-ws \
  -e PLANE_HOOKS_PROJECT_ID=11111111-2222-3333-4444-555555555555 \
  -e PLANE_HOOKS_PLANE_API_KEY=… \
  -e PLANE_HOOKS_GRAFANA_TOKEN=ph_… \
  ghcr.io/alxwlw/plane-hooks@sha256:<digest>
```

The image runs as the unprivileged `bun` user, and `wget` (busybox) is available for container
healthchecks: `wget -q --spider http://localhost:8080/healthz`. Pull requests build the image and
run the same smoke test without publishing.

## Development

```bash
pnpm install
pnpm exec moon run plane-hooks:test
```

`scripts/probe-plane.ts` checks the Plane API calls the service relies on against a real workspace.
It creates and deletes throwaway work items, a label and (when the plan allows) a release in
`PLANE_HOOKS_PROJECT_ID`, so it needs a real API token and is run by hand:

```bash
PLANE_HOOKS_PLANE_URL=… PLANE_HOOKS_WORKSPACE=… PLANE_HOOKS_PROJECT_ID=… \
  PLANE_HOOKS_PLANE_API_KEY=… bun run probe
```
