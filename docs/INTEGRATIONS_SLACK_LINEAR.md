# Slack and Linear

Ship can take work from Slack and Linear and report back to a Slack channel.
Both are optional and off by default.

| Direction | What happens | Turned on by |
|---|---|---|
| Slack in | `@ship fix the flaky login test repo:https://git.example.com/team/site` in a channel becomes a task | `SHIP_SLACK_SIGNING_SECRET` |
| Linear in | An issue labelled `ship` becomes a task | `SHIP_LINEAR_SIGNING_SECRET` |
| Slack out | A message in one channel when a run parks for a decision, completes, fails or is cancelled | `SHIP_SLACK_WEBHOOK_URL` |

Each piece works without the others. A task from Slack or Linear lands in the
dashboard **Inbox** as *proposed*. Nothing runs until someone launches it,
unless you set that source to `auto` (see [Launching](#launching-proposed-or-auto)).

The behaviour described here is pinned by tests that call the real route handlers:
`web/src/lib/slack-linear-hooks.test.ts` (signed intake, duplicates, refusals)
and `src/notify-slack-loopback.test.ts` (the outbound message, over a real
socket).

## 0. Before you start

**Ship must be reachable from the internet over HTTPS at two paths:**
`/hooks/slack` and `/hooks/linear`. Slack and Linear call them from their own
servers. The default install binds the dashboard to port 7460 for your
VPN/tailnet only, so you need to put a TLS reverse proxy in front of those two
paths. Expose only those two paths, not the dashboard. Requests to them are
authenticated by signature, not by a login, and the handlers refuse anything
unsigned.

A Caddy example (teploy already runs Caddy on its hosts). Replace the host
name with yours:

```caddyfile
ship.example.com {
	@hooks path /hooks/slack /hooks/linear
	handle @hooks {
		reverse_proxy 127.0.0.1:7460
	}
	respond 404
}
```

Also set `SHIP_PUBLIC_URL=https://ship.example.com`. This is the address
people use to reach the dashboard, and it can differ from the hooks host. Ship
puts it in the run links it posts to Slack. Without it, Slack messages carry a
bare run id.

Below, `<ship-host>` means the public host name the proxy answers on (for
example `ship.example.com`).

Setting secrets on a teploy deploy (values are injected into web and worker):

```sh
teploy secret set SHIP_SLACK_SIGNING_SECRET=<value>
teploy deploy
```

Environment changes only take effect after a redeploy. `docker restart` reuses
the old environment.

## 1. Slack: mentions become tasks

### 1a. Create the app

1. Go to <https://api.slack.com/apps>, click **Create New App**, choose **From an app
   manifest**, pick your workspace, then paste the manifest below (YAML). It has
   no request URL yet, on purpose. Slack verifies the URL the moment you enter
   it, and Ship can only answer once it has the signing secret (step 1b).

   ```yaml
   display_information:
     name: Ship
     description: Self-hosted coding agent
   features:
     bot_user:
       display_name: ship
       always_online: false
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - incoming-webhook
   settings:
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

   Scopes Ship needs: `app_mentions:read` lets Ship receive mentions, and
   `incoming-webhook` lets it post results (section 3; leave it out if you
   don't want results posted). Ship never calls the Slack Web API and needs no
   bot token. Don't add `chat:write` or any other scope.

2. **Install App**: click **Install to Workspace** and allow. If you kept
   `incoming-webhook`, Slack asks which channel to post to. Choose the channel
   where results should appear.

### 1b. Give Ship the signing secret

On the app's **Basic Information** page, under **App Credentials**, copy the
**Signing Secret**. Don't copy the Client Secret or the deprecated
Verification Token.

```sh
teploy secret set SHIP_SLACK_SIGNING_SECRET=<signing secret>
teploy deploy
```

To check it, run `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<ship-host>/hooks/slack`.
Before the secret is set the answer is `503` ("slack intake disabled"). With
the secret set it is `401`, because that request was unsigned, which is
correct.

### 1c. Subscribe to mentions

1. Open **Event Subscriptions** and turn **Enable Events** on.
2. For **Request URL**, enter `https://<ship-host>/hooks/slack`. Slack sends a
   signed `url_verification` challenge and Ship answers it. Wait for
   **Verified**.
3. Under **Subscribe to bot events**, click **Add Bot User Event** and add
   `app_mention`. Don't add other events. Ship ignores them, but Slack would
   still deliver them.
4. Click **Save Changes**. If Slack asks you to reinstall the app, do so.

### 1d. Use it

Invite the bot to each channel where people will mention it:
`/invite @ship`. Then:

```
@ship fix the flaky login test repo:https://git.example.com/team/site
```

- The `repo:<clone-url>` token binds the task to a repository. The URL must
  be allowed: either in `SHIP_REPO_ALLOWLIST` or registered as a project. A
  repository that isn't allowed gets HTTP 403, and no task is created. Without
  a `repo:` token the task is a workspace task with no repository.
- The task title is the message with the mention and the `repo:` token
  removed. Messages longer than 140 characters are kept in full as the task
  detail.
- The requester is recorded as the sender's Slack member id (for example
  `U0ADA`).
- Messages from bots, including Ship's own, are ignored. So are empty
  mentions and any event other than `app_mention`.

### What the Slack receiver enforces

- Every request must carry Slack's v0 signature:
  `X-Slack-Signature = v0=hex(HMAC-SHA256(signing secret, "v0:" + X-Slack-Request-Timestamp + ":" + raw body))`.
  A wrong signature, a missing timestamp, or a body changed after signing gets
  `401`.
- **Replay window:** the timestamp must be within 5 minutes of Ship's clock.
  An older delivery gets `401`, even when its signature is valid. Keep the
  server on NTP.
- **Duplicates:** Slack retries a delivery it thinks timed out, with the same
  message and a new signature. Ship records each message's channel and `ts`, so
  a retry produces `200 duplicate delivery` and still exactly one task.

## 2. Linear: labelled issues become tasks

1. In Linear, open **Settings > Administration > API**, find the **Webhooks**
   section (you need to be a workspace admin), and click
   **New webhook**.
   - **Label:** `Ship`
   - **URL:** `https://<ship-host>/hooks/linear`
   - **Data change events:** tick **Issues** only.
   - **Team:** all public teams, or the teams Ship should hear from.
2. Save, then copy the webhook's **signing secret** from its page.

   ```sh
   teploy secret set SHIP_LINEAR_SIGNING_SECRET=<signing secret>
   teploy deploy
   ```

3. Create an issue label named **`ship`**. The match ignores case, so `Ship`
   works too. Only issues carrying this label become tasks. The label is the
   opt-in, the same contract as the git forges.
4. Bind a repository by putting `repo:<clone-url>` anywhere in the issue
   description, for example `repo:https://git.example.com/team/site`. The same
   allowlist rule applies as for Slack.

Creating a labelled issue, or adding the label to an existing one, proposes
the task. The title becomes `[ENG-42] <issue title>`, the detail is the
description plus a link to the issue, and the requester is the actor's email
(or name). Later edits to the same issue don't create more tasks, because
there is one task per issue.

### What the Linear receiver enforces

- `Linear-Signature` must be `hex(HMAC-SHA256(signing secret, raw body))`.
  Anything else gets `401`.
- **Replay window:** Linear puts `webhookTimestamp` inside the signed body.
  Ship refuses a delivery whose timestamp is more than 5 minutes from its clock
  (`401 stale linear webhookTimestamp`). The `Linear-Delivery` header is not
  covered by the signature, so this timestamp is what stops a captured payload
  being replayed under a new delivery id.
- **Duplicates:** a repeated `Linear-Delivery` id gets `200 duplicate
  delivery`. Any later event for the same issue maps to the same task.
- Ignored with `200`, creating no task: issues without the `ship` label,
  events that aren't Issue events (comments, projects, and so on), and Issue
  `remove` events.

## 3. Slack: results come back

Ship reports runs to **one channel** through a Slack incoming webhook.

1. On the app's **Incoming Webhooks** page, if you installed with the manifest
   above, a webhook already exists for the channel you picked. Otherwise turn
   **Activate Incoming Webhooks** on and click **Add New Webhook to Workspace**.
   Copy the URL (`https://hooks.slack.com/services/T…/B…/…`). Treat it as a
   secret, because anyone who has it can post to that channel.
2. Set it and redeploy:

   ```sh
   teploy secret set SHIP_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
   teploy deploy
   ```

The worker posts `{"text": "..."}` when a run:

- parks for a decision: `Ship run run-a is parked on a plan review — https://ship.example.com/runs/run-a`
  (also "a merge decision", "an approval" or "a question: …")
- completes: `Ship run run-b completed → <pull request URL> — <run link>`
- fails or is cancelled: `Ship run run-c FAILED — <run link>`

Progress events (`running`, `queued`) aren't posted. Delivery goes through the
worker's outbox: a post that Slack refuses, or that can't reach Slack, stays
owed and is retried with backoff. A failed post never affects the run.

**What it does not do (yet):** replies go to the webhook's channel, not into
the thread of the mention that started the run. Replying in Slack doesn't steer
a run. Approvals happen in the dashboard (follow the link). Threaded
conversation is planned as programme item B4.

## Launching: proposed or auto

New sources default to **propose**: tasks wait in the Inbox for a person to
launch them. To launch automatically, flip the source to **auto** on the
dashboard **Sources** page, or set it in the worker environment:

```sh
SHIP_INTAKE_POLICIES={"slack":"propose","linear":"auto"}
```

Auto is still bounded by the daily launch cap, the concurrency ceiling and the
per-source daily budget (`SHIP_DAILY_BUDGET_USD`). Anyone who can mention the
bot, or label a Linear issue, can propose work, so keep Slack on `propose`
unless the channel membership is the trust boundary you want.

## Environment variables

| Variable | Process | Meaning |
|---|---|---|
| `SHIP_SLACK_SIGNING_SECRET` | web | Slack app signing secret. Unset means `/hooks/slack` answers 503. |
| `SHIP_LINEAR_SIGNING_SECRET` | web | Linear webhook signing secret. Unset means `/hooks/linear` answers 503. |
| `SHIP_SLACK_WEBHOOK_URL` | worker | Incoming-webhook URL for result messages. Unset means no Slack messages. |
| `SHIP_PUBLIC_URL` | web, worker | Dashboard address, used for run links. |
| `SHIP_REPO_ALLOWLIST` | web, worker | Repositories a `repo:` token may name (projects add to it). |
| `SHIP_INTAKE_POLICIES` | worker | JSON map of source to `ignore`, `propose` or `auto`. |
| `SHIP_WEBHOOK_MAX_BYTES` | web | Body size cap for every webhook (default 1 MiB). |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Slack says "Your URL didn't respond with the value of the challenge parameter" | Ship answered 503 because the signing secret isn't set (redeploy after `teploy secret set`), or 401 because the secret is wrong (the Client Secret was copied instead of the Signing Secret), or the proxy doesn't route `/hooks/slack`. Check with the curl in 1b. |
| Mentions do nothing; the web log shows 401 `stale or missing slack timestamp` | The server clock is off by more than 5 minutes. Enable NTP. `teploy-ship doctor` reports clock skew. |
| Mentions do nothing and no request shows in the web log | The bot isn't in the channel (`/invite @ship`), `app_mention` isn't subscribed, or the app wasn't reinstalled after a scope change. |
| Ship answers `403 repository not allowed` (visible in a Linear delivery's response, or by replaying the request) | The `repo:` URL isn't in `SHIP_REPO_ALLOWLIST` and isn't a registered project. Add it, or register the project. |
| A Linear issue doesn't appear | It has no `ship` label, the webhook doesn't include **Issues**, or the issue's team isn't selected in the webhook. Linear shows each delivery and its response code on the webhook page. |
| Linear deliveries get `401 stale linear webhookTimestamp` | The server clock is off. Enable NTP. |
| Task appears but never runs | The source is on `propose`: launch it from the Inbox, or set the source to `auto`. |
| No Slack messages when runs finish | `SHIP_SLACK_WEBHOOK_URL` isn't set on the **worker**, or the URL was revoked (the worker log shows `[notify] slack webhook 4xx`). Messages carry bare run ids when `SHIP_PUBLIC_URL` is unset. |
