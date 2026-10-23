# plane-discord

A [Bun](https://bun.sh) service that bridges [Plane](https://plane.so) and Discord for one or more
tenants (a Discord server plus a Plane workspace each). It has no runtime dependencies and keeps its
state in one SQLite file.

Phase 1 (this version):

- **1a, Plane to a channel.** A work item is created, closed or cancelled, or the bot is mentioned in a
  comment: a message goes to the Discord channel mapped to the project (and optionally a module). A
  forum channel gets one post per work item named `KEY Title`; later events go to the same post. A text
  channel gets plain messages. No mapping, no message.
- **1b, Plane to a DM.** "You were assigned" and "you were mentioned" reach the person through the
  user table. Your own actions are not sent. A closed DM is logged, not retried.
- **1c, Discord to Plane.** The message commands `Создать задачу в Plane` (opens a modal, creates the
  work item with `external_source=discord`, `external_id=<message id>`, replies in the channel) and
  `Добавить в задачу` (adds a comment to a work item by key). Attachments go in as links.

Hidden projects (`hiddenProjects`) are hidden completely: no channel topics, no DMs, no modal, no
forwarded mentions.

## Routes

| Path                         | Purpose                                                                |
| ---------------------------- | ---------------------------------------------------------------------- |
| `POST /plane/webhook`        | Plane App webhook, signed with the app's webhook secret                |
| `GET /plane/setup`           | `?tenant=<id>`: redirects to the Plane consent screen of the app       |
| `GET /plane/oauth/callback`  | Prints the `app_installation_id` for `tenants.json`; exchanges nothing |
| `POST /discord/interactions` | Discord interactions endpoint, Ed25519-verified                        |
| `GET /healthz`               | `ok`                                                                   |

`POST /plane/webhook` always answers `200`, accepted or not: a non-2xx counts as a failure at Plane,
and after five of them Plane disables the webhook. What cannot be accepted (bad signature, unknown
workspace, broken JSON, a body over 4 MiB) is logged with `level: "error"` and `event: "plane.rejected"`.

## Silence watchdog

Plane does not expose a webhook's status to a bot token (the call answers 403), so the service judges
by silence alone. Every 15 minutes, for each tenant: no delivery for longer than `silenceHours` (counted
from the start for a tenant that never had one) posts one message to `serviceChannelId` and logs
`plane.silent` at `error`. The first delivery after that posts "Plane снова на связи" and logs `plane.alive`.
Without a `serviceChannelId` only the log lines are written.

## Configuration

Environment:

| Variable                               | Required | Meaning                                                              |
| -------------------------------------- | -------- | -------------------------------------------------------------------- |
| `PLANE_DISCORD_PLANE_URL`              | yes      | Plane base URL, e.g. `https://plane.example.com`                     |
| `PLANE_DISCORD_PUBLIC_URL`             | yes      | Public URL of this service, e.g. `https://plane-discord.example.com` |
| `PLANE_DISCORD_DISCORD_APPLICATION_ID` | yes      | Discord application id                                               |
| `PLANE_DISCORD_DISCORD_PUBLIC_KEY`     | yes      | Discord public key, 64 hex digits                                    |
| `PLANE_DISCORD_DISCORD_BOT_TOKEN`      | yes      | Discord bot token                                                    |
| `PLANE_DISCORD_<ID>_PLANE_SECRET`      | yes      | Per tenant: client secret of the Plane App                           |
| `PLANE_DISCORD_<ID>_WEBHOOK_SECRET`    | yes      | Per tenant: webhook secret of the Plane App                          |
| `PLANE_DISCORD_CONFIG`                 | no       | Tenants file, default `/config/tenants.json`                         |
| `PLANE_DISCORD_DB`                     | no       | SQLite file, default `/data/plane-discord.sqlite`                    |
| `PORT`                                 | no       | Listen port, default `8080`                                          |

`<ID>` is the tenant id in upper case. A missing or malformed value stops the start with one message
listing every problem; the message names variables and JSON paths, never values.

Tenants: [`tenants.example.json`](tenants.example.json) shows every key (tenant id, Discord server,
Plane workspace and its UUID, the app's client id and installation id, the service channel, the channel
map with optional module and event set, the user table, hidden projects). The tenant id matches
`^[a-z][a-z0-9]{0,15}$`.

## Plane App

Register one app per Plane instance (workspace-level) and install it in each workspace. Fields:

- Setup URL `https://plane-discord.example.com/plane/setup?tenant=<id>`
- Redirect URI `https://plane-discord.example.com/plane/oauth/callback`
- Webhook URL `https://plane-discord.example.com/plane/webhook`
- Enable App Mentions
- Scopes: `projects:read`, `projects.work_items:read`, `projects.work_items:write`,
  `projects.work_items.comments:read`, `projects.work_items.comments:write`, `projects.states:read`,
  `projects.members:read`, `projects.modules:read`, `workspaces.members:read`, `agents.runs:read`,
  `agents.runs:write`, `agents.run_activities:read`, `agents.run_activities:write`

Plane does not take the scopes from the registration, so the service sends them (space-separated) as the
`scope` parameter of the consent URL and of every token request.

Installing the app through the setup URL ends on the callback page, which prints
`app_installation_id=<uuid>`; put it in `tenants.json`.

## Discord app

Name it without `discord` or `clyde`. Invite the bot with the permission integer `309774601216`
(view channels, send messages, embed links, read history, manage webhooks, create public threads, send
in threads):

```text
https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=309774601216&guild_id=<GUILD>&disable_guild_select=true
```

Set the interactions endpoint URL to `https://plane-discord.example.com/discord/interactions`. No
privileged intents are needed in this phase.

## Scripts

Run inside the container with the service's environment:

```bash
docker exec <container> bun scripts/register-commands.ts   # overwrites the guild commands of every tenant
docker exec <container> bun scripts/list-channels.ts       # id, type, parent and name of every channel
```

## Operations

- **Logs** are one JSON line per event on stdout: `{ts, event, tenant?, …ids, ms?, error?}`. Secrets and
  the text of messages, descriptions and comments never reach them.
- **State** is one SQLite file (`/data`, a named volume): deduplication keys, links between work items and
  Discord threads or messages, the watchdog heartbeat. It is not backed up. Losing it costs the
  deduplication window (a retried delivery can post twice) and the thread links of existing posts (new
  events open new posts); nothing in Plane or Discord is lost.
- **Queue** is in memory: a restart drops the deliveries not yet sent. A Discord form open in a modal is
  also in memory; after a restart it answers "form is stale", and the command is run again.

## Image

`ghcr.io/alxwlw/plane-discord`, built by `.github/workflows/plane-discord-image.yml` on every push to
`main` that touches this directory; deploy by digest. The workflow smoke-tests the image first (`/healthz`,
the `listening` line, the SQLite file in `/data`).

```bash
docker build -t plane-discord:local apps/plane-discord
```
