# plane-hooks

A [Bun](https://bun.sh) service that keeps [Plane](https://plane.so) work items in step with the code: it moves
a work item along by the facts of its pull requests and deploys (GitHub, Vercel, Dokploy) and opens incidents
from Grafana alerts and failed deploys, builds and backups. It is a Plane App for one or more tenants (a Plane
workspace each, with their own GitHub Apps and secrets), has no runtime dependencies and keeps its state in one
SQLite file.

What it does:

- **Status by pull request.** A work item belongs to the PRs that name its key (`ENG-12`) in the title or the
  branch. A PR ready for review puts it into the review state; a merged one moves it along the chain of
  environments the tenant configured, as far as the PR's merge commit has been deployed. The work item stands
  where its **least advanced** PR stands, and it only ever moves **forward**.
- **Deploys.** Every successful GitHub deployment of a configured environment writes «Выкачено» (deployed) on the
  work items of the PRs it carried, moves them, and on a release environment creates a Plane release. A deploy
  of an older commit is a rollback: «Откачено» (rolled back), the status stays.
- **Previews.** A Vercel preview gets one comment per work item and Vercel project, updated with each new link.
- **Incidents.** A Grafana alert, a failed GitHub or Vercel deploy and a failed Dokploy build or backup open a work
  item in the tenant's incident project; a repeat comments on it, a closed one is reopened, the recovery adds
  «Погас» (resolved). Closing stays a human decision.

Keys only mentioned in a PR description get the PR link, never a status change. The incident project is never
touched by the status rules.

## Requirements

- **A Plane with Plane Apps.** plane-hooks is a Plane App (OAuth, a bot token per workspace). Plane Apps exist in
  **Plane Cloud** and in the self-hosted **Commercial Edition** (its free plan included). They do **not** exist in
  the open-source **Community Edition** (`makeplane/plane`), so the hub cannot run against it: there is no
  API-key mode. Check a self-hosted instance with `curl https://plane.example.com/api/instances/`: the JSON has an
  `edition` field, and it must be `PLANE_COMMERCIAL` (Cloud is fine as well).
- A public HTTPS address for the hub (`PLANE_HOOKS_PUBLIC_URL`, below `https://hooks.example.com`) that Plane,
  GitHub, Vercel, Grafana and Dokploy can reach.
- Docker. The hub runs from the image `ghcr.io/alxwlw/plane-hooks` (see [Image](#image)).
- Workspace admin rights in Plane, and owner rights on the GitHub account that will own the GitHub App.

## Install checklist

Do the steps in this order: the Plane App must exist before the hub can send anyone to its consent screen
(`/plane/setup` redirects with the real `clientId`; a placeholder ends in «Something went wrong» in Plane), the
Plane installation id only exists after that consent, and the GitHub App only exists after the tenant is known to
the hub. Only `appInstallationId` may be a placeholder at the start (the hub does not use it for `/plane/setup`,
and it does not check its shape). Below, `acme` is the tenant id, `example-ws` the Plane workspace slug.

1. **Register the Plane App** ([Plane App](#plane-app) below) with the hub's URLs. Copy the **Client ID** and the
   **Client Secret** at once: the Secret is shown only in the "App created" dialog.
2. **Write a first `tenants.json`** (the [minimal file](#tenantsjson) below) with the real `clientId` from step 1
   and `"appInstallationId": "placeholder"`. Leave out `github`, `incidents`, `delivery`, `dokploy` and
   `silenceHours`.
3. **Start the hub** ([`docker run`](#running-the-hub) below) with the real client secret in
   `PLANE_HOOKS_ACME_PLANE_SECRET`. You should see the `listening` line with `"id":"acme"`, and
   `curl https://hooks.example.com/healthz` answers `ok`.
4. **Open `https://hooks.example.com/plane/setup?tenant=acme`** in a browser logged in to Plane as a workspace
   admin. It redirects to the Plane consent screen; approve it. You land on
   `https://hooks.example.com/plane/oauth/callback?…`, a plain-text page that prints
   `app_installation_id=<uuid>` (the hub also logs it as `plane.installed`).
5. **Put the id in** `tenants.json` (`plane.appInstallationId`) and **restart** the container. Then check that
   the hub is healthy: `/healthz` answers `ok` and the `listening` line appears again. Do not wait for the
   [watchdog](#watchdog) to prove the bot works: its first check runs 15 minutes after the start, so a quiet log
   right after a restart proves nothing (a `plane.auth_failed` after 15 minutes means a wrong client id, secret or
   installation id). The quick proof is step 8, or `scripts/probe-plane.ts` ([Development](#development)).
6. **Create the GitHub App**: in a browser logged in to GitHub as an owner of `acme`, open
   `https://hooks.example.com/github/setup?tenant=acme&owner=acme&kind=org` and press the button (see
   [GitHub App](#github-app); GitHub may ask to confirm sudo or 2FA). The callback page shows, once, the `github`
   entry for `tenants.json` and two env values: copy them right away. Add the entry, set `PLANE_HOOKS_GH_ACME_PRIVATE_KEY` and `PLANE_HOOKS_GH_ACME_WEBHOOK_SECRET`,
   **restart**, then install the App on the repositories with the link on that page. The `listening` line now
   shows `"apps":["acme"]`.
7. **Turn on the inputs you use** (each is off until its secret is set; restart after setting it): add `delivery`
   and `incidents` to `tenants.json`, then [Vercel](#vercel), [Grafana](#grafana), [Dokploy](#dokploy). The
   `listening` line lists the inputs that are on (`github`, `grafana`, `vercel`, `dokploy`); `delivery` and
   `incidents` are not in it, so there is no marker that those rules loaded. State names in `delivery` must match the
   project's states by name (case-insensitive, otherwise exact: `In Review`, `Done`); a name the project lacks shows
   only later, as one `warn` line (`event: "warning"`, `reason: "state_missing:<project>:<name>"`) on the first PR
   that needs it.
8. **Check.** Open a draft PR on `acme/api` whose title has a work item key such as `ENG-1`, and mark it ready for
   review: the work item moves to the review state and gets a comment naming the PR. From a sender, a signed test
   delivery can be posted with `scripts/replay.ts` (see [Development](#development)).

## Inputs

| Path                                                         | Sender                           | Authentication                                                               |
| ------------------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------- |
| `POST /hooks/github`                                         | every GitHub App of every tenant | App by `x-github-hook-installation-target-id`, `x-hub-signature-256`         |
| `POST /hooks/<tenant>/grafana`                               | Grafana webhook contact point    | `Authorization: Bearer ph_<48 hex>`                                          |
| `POST /hooks/<tenant>/vercel`                                | Vercel account webhook           | `x-vercel-signature`, hex HMAC-SHA1 of the raw body                          |
| `POST /hooks/<tenant>/dokploy`                               | Dokploy «Custom» notification    | `Authorization: Bearer <secret>` (a static header: Dokploy has no signature) |
| `GET /github/setup?tenant=<id>&owner=<login>&kind=org\|user` | a person                         | creates the tenant's GitHub App from a manifest                              |
| `GET /github/callback`                                       | GitHub                           | signed `state`; shows the values for `tenants.json` and env once             |
| `GET /plane/setup?tenant=<id>`                               | a person                         | redirects to the Plane consent screen                                        |
| `GET /plane/oauth/callback`                                  | Plane                            | prints the `app_installation_id`                                             |
| `POST /plane/webhook`                                        | Plane                            | always `200 ok`, the body is not read (the hub only writes to Plane)         |
| `GET /healthz`                                               | probes                           | `ok`                                                                         |

A disabled input (its secret unset), an unknown tenant and an unknown App answer 404 before the body is read,
with no log line. Bodies over 4 MiB answer 413. A GitHub delivery is saved to the inbox and answered `202` at once
(GitHub waits 10 s and never retries by itself); a repeat of a delivery already done answers `200 duplicate`.
The incident part of Grafana, Vercel and Dokploy (an alert, a failed deploy, build or backup, a Vercel production
deploy, a backup that recovered) runs while the sender waits and answers `502` when Plane fails, so the sender
retries; every write carries an `external_id`, so a retry duplicates nothing. «Погас» that comes with a deploy (a
GitHub success, a Vercel preview, a Dokploy deploy) is best effort and never holds the deploy back: the deploy work
is queued and done, a failure that may clear is an `error` line and its own inbox job (`incident.resolve`), retried
alone while the deploy is done once, any other — the incident project missing, a 4xx — one `warn` line per cause.

## Running the hub

The image has no config in it: the tenants file is **mounted** at `PLANE_HOOKS_CONFIG` (default
`/config/tenants.json`, a directory you create on the host), and `/data` is a named volume for the SQLite file.

```bash
mkdir config && $EDITOR config/tenants.json    # the minimal file from "tenants.json" below

docker run -d --name plane-hooks --restart unless-stopped \
  -p 8080:8080 \
  -v plane-hooks-data:/data \
  -v "$PWD/config:/config:ro" \
  -e PLANE_HOOKS_PLANE_URL=https://plane.example.com \
  -e PLANE_HOOKS_PUBLIC_URL=https://hooks.example.com \
  -e PLANE_HOOKS_ACME_PLANE_SECRET='<client secret of the Plane App>' \
  ghcr.io/alxwlw/plane-hooks:main
```

Adapt the command to your host: another host port is `-p 8091:8080` (the container still listens on 8080), and
a Plane host that the container cannot resolve needs `--add-host plane.example.com:<ip>`. `tenants.json` is read
only at start: any change to it, like a change of env, needs `docker rm -f plane-hooks` and the command again.
Put a TLS reverse proxy in front of port 8080 for `https://hooks.example.com`. Env that is added later (GitHub App
keys, input secrets) goes to the same command: `docker rm -f plane-hooks`, then run it again; the volume keeps the
state. The same as a compose service:

```yaml
services:
  plane-hooks:
    image: ghcr.io/alxwlw/plane-hooks:main
    restart: unless-stopped
    ports: ['8080:8080']
    volumes:
      - plane-hooks-data:/data
      - ./config:/config:ro
    environment:
      PLANE_HOOKS_PLANE_URL: https://plane.example.com
      PLANE_HOOKS_PUBLIC_URL: https://hooks.example.com
      PLANE_HOOKS_ACME_PLANE_SECRET: ${PLANE_HOOKS_ACME_PLANE_SECRET}
volumes:
  plane-hooks-data:
```

All variables are in [Environment](#environment). Any error in the file or the env stops the
start with one message that names every JSON path and variable at fault (never a value).

## Setting up a tenant

### Plane App

Register one app per Plane instance and install it in each workspace. In Plane open **Workspace settings** (the
workspace menu, top left) and click **Integrations** in the settings sidebar, then **Apps**, then the **Build your
own** link
([Plane docs: create an OAuth application](https://developers.plane.so/dev-tools/build-plane-app/create-oauth-application)).
Click through the sidebar: the direct URL `https://plane.example.com/example-ws/settings/integrations/` answered
404 when typed into the address bar on Plane 2.6.5. The page exists in Plane Cloud and the Commercial Edition only
(see [Requirements](#requirements)); a workspace admin sees it. The form asks for these required fields:

| Field                             | Value                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| App name                          | anything, for example `plane-hooks-acme`                                                      |
| App slug                          | lowercase, unique in the instance, for example `plane-hooks-acme`                             |
| App maker (company)               | your company or team, for example `acme`                                                      |
| Short description                 | one line, for example `Moves work items by pull requests and deploys`                         |
| Long description                  | a rich-text paragraph, for example the first paragraph of this README                         |
| Connection type                   | workspace-level: leave **User-Level Connection** off (the hub acts as a bot, not as a person) |
| Setup URL                         | `https://hooks.example.com/plane/setup?tenant=<id>`                                           |
| Redirect URI                      | `https://hooks.example.com/plane/oauth/callback`                                              |
| Webhook URL                       | `https://hooks.example.com/plane/webhook`                                                     |
| Webhook secret                    | the hub reads no Plane webhook, so any value does (`openssl rand -hex 32`)                    |
| Enable App Mentions               | off                                                                                           |
| Scopes (**Scopes & Permissions**) | the grid below                                                                                |

The scopes are a grid, not machine names: open the collapsed **Projects** section and tick, per row, the Read
and Write columns. Each name the hub requests (`PLANE_HOOKS_SCOPES` in `src/plane.ts`) is one cell:

| Row in the grid    | Read | Write | Scope names                                             |
| ------------------ | ---- | ----- | ------------------------------------------------------- |
| Projects           | yes  | no    | `projects:read`                                         |
| Project States     | yes  | no    | `projects.states:read`                                  |
| Project Labels     | yes  | yes   | `projects.labels:read`, `projects.labels:write`         |
| Work Items         | yes  | yes   | `projects.work_items:read`, `projects.work_items:write` |
| Work Item Comments | yes  | yes   | `projects.work_items.comments:read`, `…comments:write`  |
| Work Item Links    | yes  | yes   | `projects.work_items.links:read`, `…links:write`        |

No releases scope is requested (the hub asks for none; see [Releases](#behaviour) for what Free plans answer).

Save the **Client ID** and the **Client Secret** from the "App created" dialog at once: the Secret is shown only
there. Put the Client ID in `tenants.json` (`plane.clientId`) and the Secret in `PLANE_HOOKS_<ID>_PLANE_SECRET`
before you open the setup URL (checklist steps 2 to 4). Opening the setup URL (as a workspace admin) ends on the
callback page, which prints `app_installation_id=<uuid>`: put it in `tenants.json`. The bot sees the whole
workspace.

`PLANE_HOOKS_PLANE_URL` is used two ways: the hub calls the Plane API at it, and `/plane/setup` redirects the
installer's browser to `<PLANE_HOOKS_PLANE_URL>/auth/o/authorize-app/` for consent. So it must be reachable from
the container **and** from the browser of the person who installs (an address that resolves only inside a Docker
network, or only in the browser, breaks one of the two). On Plane Cloud it is `https://api.plane.so`.

### GitHub App

A private GitHub App can only be installed on the account that owns it, so a tenant has one App per
organisation or user account. Open `https://hooks.example.com/github/setup?tenant=acme&owner=acme&kind=org`
(`kind=user` for a personal account) and press the button: GitHub creates the App from the manifest
(permissions `contents: read`, `pull_requests: read`, `deployments: write`, `metadata: read`; events
`pull_request`, `deployment_status`; webhook `https://hooks.example.com/hooks/github`). The callback page shows,
once, the entry for `tenants.json` and the two env values (`PLANE_HOOKS_GH_<APP>_PRIVATE_KEY`,
`PLANE_HOOKS_GH_<APP>_WEBHOOK_SECRET`). Restart the service, then install the App on the repositories with the
link on that page. The hub never writes Deployments to public repositories.

Before you press the button:

- Be logged in to GitHub, in the same browser, as an owner of the account. GitHub may ask to confirm **sudo** or
  2FA (for example a number match in GitHub Mobile) before it creates the App.
- The App is always named `plane-hooks-<name>`, where `<name>` is the `owner` in lower case with every character
  outside `a-z0-9` removed (`acme-corp` gives `plane-hooks-acmecorp`; at most 16 characters, and a leading `g`
  when it would start with a digit). There is no parameter to change it. GitHub App names are unique across
  GitHub: when the name is taken, edit the name field on GitHub's manifest page before you create the App. The
  name on GitHub is only a label: the `name` in the generated `tenants.json` entry (`acme`) and the env variable
  names (`PLANE_HOOKS_GH_ACME_*`) come from the `owner`, not from the App name you chose.
- The callback page is shown **once**: GitHub does not give the key again. Copy the entry and both env values
  right away (the private key is one long line). If the page is lost, the way out is to delete the App in GitHub
  (**Settings → Developer settings → GitHub Apps**) and open `/github/setup` again, which creates another App; or
  generate a new private key and set a new webhook secret in the existing App's settings.

### Vercel

An account webhook to `https://hooks.example.com/hooks/<tenant>/vercel` with the events `deployment.succeeded`,
`deployment.error`, `deployment.promoted` and `deployment.rollback`; its secret goes to
`PLANE_HOOKS_<ID>_VERCEL_SECRET`. Vercel's own GitHub Deployments carry the production deploys; the webhook adds
previews, promotes, rollbacks and failed builds. A failed deployment created by `vercel[bot]` opens no second
incident through GitHub while the tenant's Vercel input is on.

### Grafana

```yaml
apiVersion: 1
contactPoints:
  - orgId: 1
    name: plane-hooks
    receivers:
      - uid: plane-hooks
        type: webhook
        settings:
          url: https://hooks.example.com/hooks/acme/grafana
          httpMethod: POST
          authorization_scheme: Bearer
          authorization_credentials: $PLANE_HOOKS_ACME_GRAFANA_TOKEN
        disableResolveMessage: false
```

Two traps of Grafana's env substitution in provisioning files:

- Keep `url` a literal. A `webhook.url` taken from an env variable that is empty at provisioning time makes the
  whole contact point fail validation.
- Grafana re-parses a substituted value as YAML, so a token made only of digits turns into an integer. The
  mandatory `ph_` prefix keeps the token a string (`ph_$(openssl rand -hex 24)`).

`disableResolveMessage: false` is required for «Погас»: with `true` Grafana never sends the resolution.

### Dokploy

A «Custom» notification to `https://hooks.example.com/hooks/<tenant>/dokploy` with the header
`Authorization: Bearer <secret>` (the secret also in `PLANE_HOOKS_<ID>_DOKPLOY_SECRET`) and the events build
success, build error and database/volume backup. A successful build of an app listed in `dokploy.apps` becomes a
GitHub Deployment (and its success status) of the app's repository and environment, which then takes the common
deploy path. Dokploy's notification carries no commit, so the deployed sha is the head of the app's `branch` at
the time of the notification, and the Deployment's description says so. No Dokploy API key is ever needed.

## `tenants.json`

The file is read from `PLANE_HOOKS_CONFIG` (default `/config/tenants.json`; mount it, see
[Running the hub](#running-the-hub)). The tenant id and an App `name` match `^[a-z][a-z0-9]{0,15}$`; the file and
env errors name JSON paths and variables, never values, all in one message at startup.

The **minimal** file, enough to start the hub (`id`, `workspace` and `plane` are the only required keys;
`clientId` and `appInstallationId` are non-empty strings and nothing checks their shape). The `clientId` must be
the real one before you run `/plane/setup`; `appInstallationId` may stay `"placeholder"` until that run prints it:

```json
{
	"tenants": [
		{
			"id": "acme",
			"workspace": "example-ws",
			"plane": { "clientId": "example-client-id", "appInstallationId": "placeholder" }
		}
	]
}
```

Optional keys: `github` (without it no GitHub App is served), `delivery` (no status rules, no deploys),
`incidents` (no incidents; required when the Grafana token is set), `dokploy` and `silenceHours`. The [full example with every key](https://github.com/alxwlw/tools/blob/main/apps/plane-hooks/tenants.example.json)
is in the repository. The file is read only at start: every change needs a restart. This one is a fuller tenant:

```json
{
	"tenants": [
		{
			"id": "acme",
			"workspace": "example-ws",
			"plane": { "clientId": "example-client-id", "appInstallationId": "<uuid>" },
			"github": [{ "name": "acme", "appId": 1000001, "owner": "acme" }],
			"incidents": { "project": "INC", "priority": { "warning": { "prod": "medium" } } },
			"delivery": {
				"states": { "review": "In Review", "done": "Done" },
				"hold": ["Blocked"],
				"repos": [
					{
						"repo": "acme/api",
						"environments": [
							{ "name": "staging", "state": "On staging" },
							{ "name": "production", "state": "Done", "release": true }
						]
					},
					{ "repo": "acme/*", "environments": [] }
				],
				"projects": { "QA": { "Done": "Ready for retest" } }
			},
			"dokploy": {
				"apps": [
					{ "name": "api", "repo": "acme/api", "branch": "main", "environment": "production" }
				]
			},
			"silenceHours": { "vercel": 72, "github": 24 }
		}
	]
}
```

- **`github`** — the tenant's Apps; a repository is served by the App whose `owner` owns it (case-insensitive).
- **`delivery.repos`** — `owner/name` or `owner/*`; the first match wins. A repository without a rule gets PR
  links but no status changes. Its **chain of positions** is `states.review`, then each environment's `state` in
  order; with no environments it is `review` → `done` (the merge is the end of the road). Environments not listed
  change nothing. `release: true` makes a Plane release of every deploy there.
- **Position of a work item.** For each PR it belongs to: draft (no move at all), review, the furthest environment
  whose last successful deploy contains the PR's merge commit, or the end of the road. The work item goes to the
  position of its least advanced PR, and only forward: by state group (backlog, unstarted, started, completed),
  then by the state's order within the project. A work item in `hold`, completed or cancelled is never moved.
- **`delivery.projects`** — per project identifier, the name a target state has there; `null` — that state is
  never set in that project (the position falls back to the previous step). A state missing from a project or a
  project Plane does not know logs one `warn` line and the rest works.
- **`incidents.project`** — the identifier of the incident project (required for the Grafana input); the status
  rules never touch it. A tenant without `incidents` gets no incidents. **`incidents.priority`** — severity
  (or `*`) → environment (or `*`) → `urgent`/`high`/`medium`, merged cell by cell over the default:

  | `severity`       | `env` other than `staging` | `env` = `staging` |
  | ---------------- | -------------------------- | ----------------- |
  | `critical`       | urgent                     | high              |
  | `warning`        | high                       | medium            |
  | missing or other | urgent                     | high              |

  The `severity` label is compared after trim and lower-casing; a missing or empty `env` label counts as `prod`.
  Failed GitHub deploys get `urgent` on a release environment, else `high`; Vercel `high` (production) or
  `medium`; failed Dokploy builds and backups `high`.

- **`dokploy.apps`** — the Dokploy application name (`applicationName` of the notification), the repository,
  the branch Dokploy builds and the environment name of the GitHub Deployment.
- **`silenceHours`** — per input (`grafana`, `vercel`, `dokploy`, and `github` for the deliveries of all the
  tenant's Apps), how long it may stay silent (1..720 h). `github` catches an App webhook switched off in GitHub,
  which neither fails a delivery nor breaks `GET /app`.

## Environment

| Variable                              | Required | Meaning                                                                |
| ------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `PLANE_HOOKS_PLANE_URL`               | yes      | Plane base URL, e.g. `https://plane.example.com`                       |
| `PLANE_HOOKS_PUBLIC_URL`              | yes      | Public URL of this service, e.g. `https://hooks.example.com`           |
| `PLANE_HOOKS_CONFIG`                  | no       | Tenants file, default `/config/tenants.json`                           |
| `PLANE_HOOKS_DB`                      | no       | SQLite file, default `/data/plane-hooks.sqlite`                        |
| `PORT`                                | no       | Listen port, default `8080`                                            |
| `PLANE_HOOKS_<ID>_PLANE_SECRET`       | yes      | Per tenant: client secret of the Plane App                             |
| `PLANE_HOOKS_<ID>_GRAFANA_TOKEN`      | no       | Per tenant: `ph_` + 48 lowercase hex; unset — the input is off         |
| `PLANE_HOOKS_<ID>_VERCEL_SECRET`      | no       | Per tenant: Vercel webhook secret; unset — off                         |
| `PLANE_HOOKS_<ID>_DOKPLOY_SECRET`     | no       | Per tenant: the Bearer secret of the Dokploy notification; unset — off |
| `PLANE_HOOKS_GH_<APP>_PRIVATE_KEY`    | yes      | Per App: its private key, PEM in base64 on one line                    |
| `PLANE_HOOKS_GH_<APP>_WEBHOOK_SECRET` | yes      | Per App: its webhook secret                                            |

`<ID>` is the tenant id and `<APP>` the App `name` in upper case. An optional secret set but blank is a startup
error: unset it to turn the input off. The `listening` line at startup lists each tenant with its inputs and Apps. It does not show `delivery` or `incidents`: their rules are loaded
silently, and a wrong state name appears only as a later `warning` line:
`{"event":"listening","port":8080,"tenants":[{"id":"acme","inputs":["github","grafana","vercel","dokploy"],"apps":["acme"]}]}`.

## Behaviour

- **Status comments.** Every move writes a comment naming its cause (the PR or the deploy); a repeated event adds
  nothing (`external_id` per work item, state and cause).
- **«Выкачено».** One per work item, repository, environment and sha, with the PRs of that work item in the
  deploy. The commits of a deploy are counted from the previous deploy the hub handled for that repository and
  environment (the cursor), so a lost event is caught up by the next one; the first deploy asks GitHub for the
  one before. A deploy whose status time is older than the cursor's (a late redelivery) is ignored.
- **Rollback.** A deploy of a commit behind the previous one writes «Откачено» on the work items of the PRs that
  left the environment; their status does not go back. A Vercel instant rollback carries no commit in Vercel's
  documented payload and is logged and skipped.
- **Promote.** A Vercel promote is the production deploy of its sha through the common deploy path, in the
  environment where `vercel[bot]` recorded that sha (`Production` or `Production – <project>`).
- **Releases.** A deploy of a `release: true` environment creates one Plane release per `repository@sha` (named
  `<date> · <sha7>`, plus the title of the PR whose merge commit was deployed) with the commits and work items in
  its changelog. On a plan without releases (Free) Plane answers 402 or 403 (403 on Commercial 2.6.5): any error of the release call is caught, the hub logs one `warn` line (`event: "release"`, with the error) and the deploy is still delivered.
- **Previews.** One comment per work item and Vercel project; a new link rewrites it, the same link changes
  nothing. The work items are those of the branch's open PRs, else of the branch name.
- **Limitation.** Environments are matched by commit ancestry (`compare`): promote branches between environments
  with a merge commit, not a squash, or the next environment sees new commits instead of the ones already there.

### Incidents

Each incident has a key: for Grafana the alert fingerprint; for a failed GitHub deploy
`deploy:<owner>/<repo>:<environment>`; for Vercel `deploy:<project id>:<target>:<branch>`; for Dokploy
`dokploy:<application>:build` and `dokploy:<application>[/<database or volume>]:backup`.

- The first firing signal of a key creates a work item in the incident project.
- A repeated firing signal adds a comment.
- If the work item is closed, it is reopened to the project's default state.
- If it is archived, it is unarchived first, then reopened.
- A resolution adds the comment «Погас» (resolved). It never closes the work item and never unarchives it: closing
  stays a human decision.
- A repeated delivery of the same event is a no-op (deduplicated by `external_id`).

## State

One SQLite file (`PLANE_HOOKS_DB`, `/data` on a named volume — the image hands `/data` to the `bun` user):

- **Inbox.** Every accepted delivery is saved before the answer (as the normalised event, not the raw body) and
  marked done afterwards, when its payload is dropped. After a restart the unfinished ones run again. One that
  still fails after the retries (1 s, 5 s, 30 s for a 5xx, 429 or a dropped connection) stays `failed` and logs
  `job.dropped`. Done deliveries are kept 14 days, so a GitHub redelivery of one is recognised; a Redeliver of a
  failed one runs it again.
- **Deploy cursor** — per tenant, repository and environment: the last handled sha and the time of its deploy.
- **Journal** of status transitions (work item, from, to, cause, time), kept 180 days.

Losing the file costs the cursor (the next deploy asks GitHub for the previous one), the journal and unfinished
deliveries; nothing in Plane or GitHub is lost.

```bash
docker exec <container> bun scripts/inbox.ts failed        # failed deliveries: id, tenant, kind, time, error
docker exec <container> bun scripts/inbox.ts retry <id>    # pending again; runs at the next start
docker exec <container> bun scripts/journal.ts --since 7d [--tenant acme]
```

## Watchdog

Every 15 minutes (the first check 15 minutes after the start, so a quiet log right after a restart proves nothing;
use `/healthz` and the `listening` line to see that the hub is up), log lines with `level: "error"` only when a state changes (and a recovery line after):

- `plane.auth_failed` / `plane.auth_ok` — the bot cannot list the workspace's projects (401/403, or Plane refused
  the token request). Plane being down is `watchdog.failed` and changes nothing.
- `github.app_unreachable` / `github.app_ok` — `GET /app` fails, whatever the cause: the App was deleted, its key
  revoked, or GitHub cannot be reached (transport errors included).
- `github.deliveries_failed` (with `failed`, the count) / `github.deliveries_ok` — GitHub recorded failed
  deliveries to the hub since the last check.
- `input.silent` / `input.alive` — an input listed in `silenceHours` got nothing for longer than that, counted
  from the last accepted delivery or from the start, whichever is later.

Logs are one JSON line per event on stdout (`{ts, event, tenant?, …}`). Lines with `annotation: "deploy"` or
`annotation: "incident"` carry `title`, `env`, `sha` and `source` for Grafana annotation layers. Secrets, tokens,
request bodies, work item names, PR titles and comment texts never reach the log.

## Upgrading from the API-key version

This version is not compatible with the single-project, API-key one:

- it needs the Plane App and `tenants.json`; `PLANE_HOOKS_WORKSPACE`, `PLANE_HOOKS_PROJECT_ID`,
  `PLANE_HOOKS_PLANE_API_KEY` and the unprefixed input secrets are gone;
- the input paths changed to `/hooks/<tenant>/grafana|vercel|dokploy`;
- `/hooks/deploy` (the CI deploy report) is removed: GitHub `deployment_status` replaces it. Do not run both for
  one repository — their failed-deploy incidents have different keys;
- the previous image keeps working by its digest; deploy the new one beside it and switch the senders one by one.

## Image

`ghcr.io/alxwlw/plane-hooks`, built from the repository root by `.github/workflows/plane-hooks-image.yml` on
every push to `main` that touches this app or `packages/plane-app`; deploy by digest. Pull requests build it and
run the smoke test without publishing: `tenants.example.json` in `/config`, a fresh RSA key, the `listening` line
with the tenant, `/healthz`, the SQLite file in `/data`. The image runs as `bun`; `wget` (busybox) serves
container healthchecks: `wget -q --spider http://localhost:8080/healthz`.

```bash
docker build -f apps/plane-hooks/Dockerfile -t plane-hooks:local .
```

## Development

```bash
pnpm install
pnpm exec moon run plane-hooks:test
```

Scripts that talk to live systems need real credentials, so they are run by hand:

- **`scripts/probe-plane.ts`** checks the Plane calls the hub relies on as the Plane App bot: it creates and
  deletes throwaway work items, a label and a release in a project. Env: `PLANE_HOOKS_PLANE_URL`,
  `PLANE_HOOKS_WORKSPACE`, `PLANE_HOOKS_PROJECT_ID` (the project UUID), and the app's
  `PLANE_HOOKS_PROBE_CLIENT_ID`, `PLANE_HOOKS_PROBE_CLIENT_SECRET`, `PLANE_HOOKS_PROBE_INSTALLATION_ID`:

  ```bash
  PLANE_HOOKS_PLANE_URL=https://plane.example.com PLANE_HOOKS_WORKSPACE=example-ws \
    PLANE_HOOKS_PROJECT_ID=<uuid> PLANE_HOOKS_PROBE_CLIENT_ID=… PLANE_HOOKS_PROBE_CLIENT_SECRET=… \
    PLANE_HOOKS_PROBE_INSTALLATION_ID=<uuid> bun scripts/probe-plane.ts
  ```

- **`scripts/probe-app.ts`** probes the Plane App token and release scopes and the GitHub App calls (token,
  compare, PRs of a commit, deployments); `bun scripts/probe-app.ts --help` lists its commands and env.
- **`scripts/replay.ts`** posts stdin to a running hub signed the way the real sender signs it:
  `bun scripts/replay.ts acme grafana|vercel|dokploy < body.json`, or `bun scripts/replay.ts github <event> [<app>]`
  (the App id comes from `tenants.json`, the delivery id is fresh). Inside the container the env is already there:
  `docker exec -i <container> bun scripts/replay.ts acme grafana < grafana-firing.json`.
- `scripts/capture.ts` and `scripts/sanitize-fixture.ts` record live deliveries and turn them into fixtures.
