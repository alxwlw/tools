# plane-miro

A [Bun](https://bun.sh) service that links [Plane](https://plane.so) and [Miro](https://miro.com) for one or
more tenants (a Plane workspace plus a Miro team each). It has no runtime dependencies, keeps its state in one
SQLite file and serves its own front end: `web/*.ts` is bundled by `Bun.build` at start.

What it does:

- **Stickers become work items.** In the Miro panel the user picks a Plane project and presses «В Plane»: each
  selected sticker (also a card, a shape or a text) becomes a work item with `external_source=miro` and
  `external_id=<board>:<item>`, and a card of the work item appears next to it. A second press on the same
  sticker creates nothing new, and a conversion cut short is finished by the repeat.
- **A work item points to its place on the board.** The work item gets a link
  `https://miro.com/app/board/<board>/?moveToWidget=<card>`; a tenant with `embed: true` also gets an Embed block
  of that place in its description.
- **Status on the cards.** A change of state, title or assignees in Plane updates the cards of the work item on
  every board; a deleted work item turns its cards `disabled`. A card deleted by hand on the board is forgotten.
- **A Miro link in a comment or in «Ссылки»** puts the work item's card on that board.

A sticker can also be bound to an existing work item (search by key or text) instead of creating one.
Everything that changes the board is done by the service through the Miro REST API with the token of one
service account; the front only reads the selection and calls the service with the user's id token.

Hidden projects (`hiddenProjects`) are hidden completely: not offered, not found, never synced.

## Routes

| Path                                                                | Purpose                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `POST /plane/webhook`                                               | Plane App webhook, signed with the app's webhook secret               |
| `GET /plane/setup`                                                  | `?tenant=<id>`: redirects to the Plane consent screen of the app      |
| `GET /plane/oauth/callback`                                         | Prints the `app_installation_id` for `tenants.json`                   |
| `GET /miro/setup`                                                   | `?tenant=<id>`: the link that connects the service account to Miro    |
| `GET /miro/oauth/callback`                                          | Miro OAuth redirect; stores the service account's token               |
| `GET /miro/app`, `/miro/panel`, `/miro/card`, `/miro/assets/<n>.js` | The pages and bundles Miro loads (`frame-ancestors https://miro.com`) |
| `GET /miro/api/projects`, `/search`, `/card`                        | The front's API (read)                                                |
| `POST /miro/api/convert`, `/bind`                                   | The front's API (write); may run for minutes under the Plane limits   |
| `GET /healthz`                                                      | `ok`                                                                  |

The API accepts only `Authorization: Bearer <id token>` (`miro.board.getIdToken()`), checks it against the
Miro app's client secret and serves the tenant of the token's team. `POST /plane/webhook` always answers `200`,
accepted or not: a non-2xx counts as a failure at Plane, and after five of them Plane disables the webhook. What
cannot be accepted (bad signature, unknown workspace, broken JSON, a body over 4 MiB) is logged with
`level: "error"` and `event: "plane.rejected"`.

## Watchdog

Every 15 minutes, for each tenant (a failure of one never stops the others), log lines only:

- **Plane silence.** No delivery for longer than `silenceHours` (counted from the start for a tenant that never
  had one) logs `plane.silent` at `error` once; the first delivery after that logs `plane.alive`. Plane does not
  show a webhook's status to a bot token, so silence is all there is.
- **Miro token.** No token stored: `miro.not_connected` (`error`) on the first check and on every change of
  state. The token rejected by Miro: `miro.token_invalid` (`error`) once; valid again: `miro.token_ok`. A network
  error is `watchdog.failed` and changes nothing.

Once a day the deduplication keys older than 30 days are deleted.

## Configuration

Environment:

| Variable                         | Required | Meaning                                                           |
| -------------------------------- | -------- | ----------------------------------------------------------------- |
| `PLANE_MIRO_PLANE_URL`           | yes      | Plane base URL, e.g. `https://plane.example.com`                  |
| `PLANE_MIRO_PUBLIC_URL`          | yes      | Public URL of this service, e.g. `https://plane-miro.example.com` |
| `PLANE_MIRO_MIRO_CLIENT_ID`      | yes      | Client id of the Miro app                                         |
| `PLANE_MIRO_MIRO_CLIENT_SECRET`  | yes      | Client secret of the Miro app (also signs the id tokens)          |
| `PLANE_MIRO_<ID>_PLANE_SECRET`   | yes      | Per tenant: client secret of the Plane App                        |
| `PLANE_MIRO_<ID>_WEBHOOK_SECRET` | yes      | Per tenant: webhook secret of the Plane App                       |
| `PLANE_MIRO_CONFIG`              | no       | Tenants file, default `/config/tenants.json`                      |
| `PLANE_MIRO_DB`                  | no       | SQLite file, default `/data/plane-miro.sqlite`                    |
| `PORT`                           | no       | Listen port, default `8080`                                       |

`<ID>` is the tenant id in upper case. A missing or malformed value stops the start with one message listing
every problem; the message names variables and JSON paths, never values. A failed build of `web/` stops it too.

Tenants: [`tenants.example.json`](tenants.example.json) shows every key (tenant id, Plane workspace and its UUID,
the Plane App's client id and installation id, the Miro team id, `embed`, `keepSource`, `silenceHours`, hidden
projects). The tenant id matches `^[a-z][a-z0-9]{0,15}$`; the Plane workspace and the Miro team of two tenants
must differ.

## Plane App

Register one app per Plane instance (workspace-level) and install it in each workspace. Fields:

- Setup URL `https://plane-miro.example.com/plane/setup?tenant=<id>`
- Redirect URI `https://plane-miro.example.com/plane/oauth/callback`
- Webhook URL `https://plane-miro.example.com/plane/webhook`
- App mentions off
- Scopes: `projects:read`, `projects.work_items:read`, `projects.work_items:write`,
  `projects.work_items.comments:read`, `projects.work_items.comments:write`, `projects.work_items.links:read`,
  `projects.work_items.links:write`, `projects.states:read`, `projects.members:read`, `workspaces.members:read`

The form does not issue a webhook secret: generate one (`openssl rand -hex 32`) and enter it there and in
`PLANE_MIRO_<ID>_WEBHOOK_SECRET`. The service sends the scopes (space-separated) as the `scope` parameter of the
consent URL and of every token request. Installing the app through the setup URL ends on the callback page, which
prints `app_installation_id=<uuid>`; put it in `tenants.json`.

## Miro app

Create it in a developer team:

- App URL (`sdkUri`) `https://plane-miro.example.com/miro/app`
- Redirect URI for OAuth2.0 `https://plane-miro.example.com/miro/oauth/callback`
- «Use this URI for SDK authorization» off
- Scopes `boards:read`, `boards:write`, `identity:read`
- «Expire user authorization token» **off**: the service keeps one token with no refresh, and the setting cannot
  be changed afterwards

Install it in the team with the install link of the app settings; Marketplace is not needed.

### Connecting the service account

Boards are changed with the token of one Miro account that is a member of the team. That account opens
`https://plane-miro.example.com/miro/setup?tenant=acme`, signs in and grants access; the callback stores its token
for the tenant's team (the `state` of the link is signed and expires). Installs by other people leave no token.
Until the account is connected the API answers that Miro is not connected and the watchdog logs
`miro.not_connected`. A board is available to the service when the account can see it.

## Operations

- **Logs** are one JSON line per event on stdout: `{ts, event, tenant?, …ids, ms?, error?}`. Secrets, tokens, id
  tokens and the text of stickers, work items and comments never reach them.
- **State** is one SQLite file (`/data`, a named volume): deduplication keys, links between stickers, work items
  and cards, the service account's token, the watchdog heartbeat. It is not backed up. Losing it costs the token
  (connect the account again), the card links (new events stop updating existing cards) and the deduplication
  window. Nothing in Plane or Miro is lost.
- **Queue** is in memory: a restart drops the Plane events not yet handled. A retryable failure (Miro or Plane
  429, 5xx, a dropped connection) is retried after 1 s, 5 s and 30 s.
- **Long calls.** `POST /miro/api/convert` and `/bind` can wait minutes on the Plane rate limit, so the idle
  timeout of Bun (10 s) is lifted for them once the id token checks out; every other request keeps it.

## Image

`ghcr.io/alxwlw/plane-miro`, built by `.github/workflows/plane-miro-image.yml` on every push to `main` that touches
this directory; deploy by digest. The workflow smoke-tests the image first (`/healthz`, the headers of
`/miro/panel`, the `listening` line, the SQLite file in `/data`).

```bash
docker build -t plane-miro:local apps/plane-miro
```
