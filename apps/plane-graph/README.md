# plane-graph

A [Bun](https://bun.sh) service that keeps a read-only copy of the work items and relations of one or more
[Plane](https://plane.so) workspaces, draws the order in which the work can be done, and gives an agent the same
data to put missing relations back into Plane. It has one runtime dependency, `@alxwlw/plane-app` (the workspace
package with bot-token auth and the install redirect), keeps its state in one SQLite file and serves its own
front end: `web/graph.ts` is bundled by `Bun.build` at start. The graph library (d3) is loaded by the browser
from a CDN with a pinned version and an integrity hash.

What it does:

- **A copy of Plane.** At start and daily at 03:00 UTC the service reads projects, states, labels, modules, all
  work items and the relations of each item, then swaps the copy in one transaction: a read that fails halfway
  leaves the old copy in place, logs `sync.failed` and is retried after 10 minutes. A webhook delivery re-reads
  the one item it names, with its relations; repeats of one item in the queue are folded into one read.
- **An order graph.** Work items joined by «blocks» are laid out in waves: wave 0 can start now, wave 1 waits for
  wave 0, and so on. Cycles are reported, not hidden; tasks of one wave that share an area label (`код:<name>`)
  are flagged as not parallel.
- **A block for Plane.** `plane-block.html` is a small file to paste into an HTML block of a Plane page; it loads
  the graph from this service.
- **Agent endpoints.** `snapshot.json` is the whole copy; `agent-runs` takes the list of relations and labels an
  agent has just added. The service confirms each one once it sees it in Plane, and reports the ones that
  disappeared afterwards under `rejected`.

## Routes

| Path                                       | Purpose                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `POST /plane/webhook`                      | Plane App webhook, signed with the app's webhook secret                          |
| `GET /plane/setup`                         | `?tenant=<id>`: redirects to the Plane consent screen of the app                 |
| `GET /plane/oauth/callback`                | Prints the `app_installation_id` for `tenants.json`                              |
| `GET /t/<tenant>/graph?k=<read key>`       | The graph page                                                                   |
| `GET /t/<tenant>/graph.json?k=<key>`       | The graph data (`Cache-Control: no-store`, CORS `*`)                             |
| `GET /t/<tenant>/plane-block.html?k=<key>` | The file for a Plane HTML block, sent as an attachment                           |
| `GET /assets/graph.js`                     | The bundled front end, no key                                                    |
| `GET /t/<tenant>/snapshot.json`            | The whole copy; `Authorization: Bearer <agent key>`                              |
| `POST /t/<tenant>/agent-runs`              | A run of the agent, a JSON body up to 1 MiB; `Authorization: Bearer <agent key>` |
| `GET /healthz`                             | `ok`                                                                             |

The read key opens the graph only; the agent key opens `snapshot.json` and `agent-runs` only. Keys are compared in
constant time. An unknown tenant is `404`; a wrong, missing or empty key is `401 {"error":"unauthorized"}`.
`POST /plane/webhook` always answers `200`, accepted or not: a non-2xx counts as a failure at Plane, and after
five of them Plane disables the webhook. What cannot be accepted (bad signature, unknown workspace, broken JSON,
a body over 4 MiB) is logged with `level: "error"` and `event: "plane.rejected"`.

## Watchdog

Every 15 minutes, for each tenant (a failure of one never stops the others), log lines only:

- **Plane silence.** No delivery for 72 hours (counted from the start for a tenant that never had one) logs
  `plane.silent` at `error` once; the first delivery after that logs `plane.alive`.
- **Stale copy.** The last successful reconcile older than 26 hours logs `watchdog.stale_sync` at `error`, at most
  once a day per tenant. A copy never synced is counted from the start.

The watchdog keeps its alerts in memory, so a restart may repeat one. Once an hour the deduplication keys older
than 30 days are deleted.

## Reconcile

One timer per tenant, and the reconcile runs as a job of the tenant's queue, never beside a refresh of one item.
After a success the next one is at 03:00 UTC; after a failure, in 10 minutes. When a refreshed item names a state
or project the copy does not know, the next reconcile is moved to 10 minutes after the last one finished (or to
now, if that was longer ago); asking again while one is queued or running changes nothing. Reads are limited to
50 requests a minute per tenant.

## Configuration

Environment:

| Variable                          | Required | Meaning                                                            |
| --------------------------------- | -------- | ------------------------------------------------------------------ |
| `PLANE_GRAPH_PLANE_URL`           | yes      | Plane base URL, e.g. `https://plane.example.com`                   |
| `PLANE_GRAPH_PUBLIC_URL`          | yes      | Public URL of this service, e.g. `https://plane-graph.example.com` |
| `PLANE_GRAPH_<ID>_PLANE_SECRET`   | yes      | Per tenant: client secret of the Plane App                         |
| `PLANE_GRAPH_<ID>_WEBHOOK_SECRET` | yes      | Per tenant: webhook secret of the Plane App                        |
| `PLANE_GRAPH_<ID>_READ_KEY`       | yes      | Per tenant: the key of the graph URLs (`openssl rand -hex 32`)     |
| `PLANE_GRAPH_<ID>_AGENT_KEY`      | yes      | Per tenant: the agent's bearer key; must differ from the read key  |
| `PLANE_GRAPH_CONFIG`              | no       | Tenants file, default `/config/tenants.json`                       |
| `PLANE_GRAPH_DB`                  | no       | SQLite file, default `/data/plane-graph.sqlite`                    |
| `PORT`                            | no       | Listen port, default `8080`                                        |

`<ID>` is the tenant id in upper case. A missing or malformed value stops the start with one message listing
every problem; the message names variables and JSON paths, never values. A failed build of `web/` stops it too.

Tenants: [`tenants.example.json`](tenants.example.json) shows every key (tenant id, Plane workspace slug and its
UUID, the Plane App's client id and installation id). The tenant id matches `^[a-z][a-z0-9]{0,15}$`. UUIDs may be
written in any case: they are read in lower case, as Plane sends them.

## Plane App

Register one app per Plane instance (workspace-level) and install it in each workspace. Fields:

- Setup URL `https://plane-graph.example.com/plane/setup?tenant=<id>`
- Redirect URI `https://plane-graph.example.com/plane/oauth/callback`
- Webhook URL `https://plane-graph.example.com/plane/webhook`
- App mentions off
- Scopes, all read-only: `projects:read`, `projects.work_items:read`, `projects.work_items.relations:read`,
  `projects.states:read`, `projects.labels:read`, `projects.modules:read`

The form does not issue a webhook secret: generate one (`openssl rand -hex 32`) and enter it there and in
`PLANE_GRAPH_<ID>_WEBHOOK_SECRET`. Installing the app through the setup URL ends on the callback page, which
prints `app_installation_id=<uuid>`; put it in `tenants.json`.

## Putting the graph into Plane

Open `https://plane-graph.example.com/t/<tenant>/plane-block.html?k=<read key>`: the browser saves
`plane-graph.html`. Paste its content into an HTML block of a Plane page. The block loads
`/assets/graph.js` and the graph data from this service, so the page must be able to reach it. The page of the
graph itself is `https://plane-graph.example.com/t/<tenant>/graph?k=<read key>`; a work item shows as its key,
for instance `ABC-1`, and opens in Plane.

## Operations

- **Logs** are one JSON line per event on stdout: `{ts, event, tenant?, …ids, ms?, error?}`. Secrets, keys,
  tokens and the titles and descriptions of work items never reach them, and a request line carries no query
  string.
- **State** is one SQLite file (`/data`, a named volume): deduplication keys, the copy, the agent's runs and
  marks, the watchdog heartbeat. Losing it costs the history of the agent's runs and the deduplication window;
  the next reconcile rebuilds the copy from Plane.
- **Queue** is in memory, one per tenant: a restart drops the events not yet handled, and the reconcile at start
  covers them. A retryable failure is retried after 1 s, 5 s and 30 s.

## Image

`ghcr.io/alxwlw/plane-graph`, built by `.github/workflows/plane-graph-image.yml` on every push to `main` that touches
this directory or `packages/plane-app`; deploy by digest. The workflow smoke-tests the image first (`/healthz`,
the bundle, the `listening` line, the SQLite file in `/data`).

The build context is the repository root: the image carries `packages/plane-app` as source and installs nothing.

```bash
docker build -f apps/plane-graph/Dockerfile -t plane-graph:local .
```
