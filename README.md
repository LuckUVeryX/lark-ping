# lark-ping

A plugin for [OpenCode 2](https://opencode.ai/v2/docs/) that sends Lark DMs when
an agent finishes or needs attention.

Notifications are **off by default**. Toggle them with `/lark-ping` in each session.
Messages say `OpenCode · Finished` or `OpenCode · Needs attention` and include only
the project name and session title. Failed execution, permission requests, and
session forms trigger attention messages.

## Set up a Lark bot

1. Create an internal app in the [Lark Developer Console](https://open.larksuite.com/app).
2. Enable the bot capability and grant `im:message:send_as_bot`.
3. Include the recipient in the app's availability scope and publish the app.
4. Copy the **App ID** and **App Secret**.
5. Get the recipient's app-specific `open_id` through the
   [Lark API Explorer](https://open.larksuite.com/api-explorer), using this app's
   credentials and the lookup API's required permissions.

Supports one recipient through the international Lark API, not Feishu or group chats.

## Install the plugin

Requires [Node.js](https://nodejs.org/) 22.12 or newer. If an agent handles setup,
it needs your permission to change your global config or restart OpenCode.

1. Clone this repository and install dependencies:

   ```sh
   cd /path/to/lark-ping
   npm ci
   ```

2. Add the plugin to `~/.config/opencode/opencode.jsonc`, keeping your existing
   plugins and settings:

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "plugins": [
       {
         "package": "/absolute/path/to/lark-ping",
         "options": {
           "recipient": {
             "id": "ou_your_open_id",
           },
           "credentials": {
             "appId": "cli_your_app_id",
             "appSecret": "your_app_secret",
           },
         },
       },
     ],
   }
   ```

3. Replace the placeholders. **Do not commit the app secret.**
4. Restart the OpenCode service:

   ```sh
   opencode service restart
   ```

5. Run `opencode plugin list` to check that OpenCode loaded this checkout.

## Usage

Run `/lark-ping` to enable notifications (`Lark Ping on`); run it again to disable
them. The setting persists for that session. Only top-level sessions in the
plugin's directory are covered, not child agent sessions.

After enabling notifications, finish a turn and check Lark for a new
`OpenCode · Finished` message.

Finished notifications are suppressed while any descendant subagent is running. Subagent completion does not send a notification or replay an earlier main-agent completion; the main agent must finish its follow-up turn before notifying.

The plugin queries running sessions from the local managed OpenCode service on each main-agent completion, using its discovered authentication. It verifies that the service is the process hosting the plugin. If discovery, authentication, or the query fails, it skips the Finished notification; attention notifications are unaffected. Standalone servers are not supported for Finished notifications.

To skip completed turns shorter than one minute, add this to `options`:

```json
{
  "minimumTurnDurationMs": 60000
}
```

Use a non-negative integer in milliseconds (default: `0`). Attention messages and
completed turns with unknown duration are never suppressed by this filter.

## Development

Run these commands from the repository root. `setup:dev` applies the
`@effect/tsgo` integration to TypeScript 7 and Oxlint.

```sh
npm ci
npm run setup:dev
npm test
npm run typecheck
npm run lint
npm run format:check
```

These checks cover code quality and unit tests, not live Lark delivery.

After dependency changes, run `npm install` and commit `package-lock.json`.
GitHub Actions runs `npm ci` and `npm test` on Node.js 22 for pushes, pull requests,
and manual runs.
