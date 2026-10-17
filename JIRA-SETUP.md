# Connecting Fleet to Jira

Once this is set up, the board can work from Jira tickets in two ways:

- **Link a ticket by hand.** Paste a key (`PROJ-123`) or a ticket link into **New task**. The agent reads the ticket's description and its latest comments, then works on its own `fleet/proj-123-…` branch.
- **Pick up tickets automatically.** Give Fleet a JQL query and it checks it every few minutes. Each new match becomes a task and starts as soon as a slot is free. Each ticket is picked up only once.

Fleet only **reads** from Jira. It never comments on, moves, or edits tickets.

## The short way

1. **Update Fleet.** In the claude-fleet folder, run `git pull`. If Fleet doesn't restart on its own afterwards, run `npm run restart`.
2. **Make an API token.** Go to https://id.atlassian.com/manage-profile/security/api-tokens, choose **Create API token**, and copy the token.
3. **Store the token outside the repo.** In a PowerShell window of your own (not inside a Claude chat, so the token doesn't end up in a transcript), run:
   ```
   setx JIRA_API_TOKEN "paste-the-token-here"
   ```
4. **Add a `jira` section to `fleet.config.json`.** This file isn't tracked by git, so it stays on this machine:
   ```json
   "jira": {
     "baseUrl": "https://YOURCOMPANY.atlassian.net",
     "email": "you@yourcompany.com",
     "apiToken": "",
     "repos": {
       "PROJ": "C:/Users/you/code/the-repo-for-PROJ"
     },
     "jql": "",
     "everyMinutes": 5
   }
   ```
   - `baseUrl`: open any ticket in your browser and copy everything before `/browse/`.
   - `email`: the address you sign in to Jira with.
   - `apiToken`: leave this empty. Fleet reads `JIRA_API_TOKEN` instead.
   - `repos`: maps each project key (the part of a ticket key before the dash) to the folder its tickets should be worked in. If a ticket's project isn't mapped, Fleet also accepts a ticket label that matches the name of a repo folder.
   - `jql`: leave this empty for now. Hand-linking works without it. Turning on automatic pickup is covered below.
5. **Restart Fleet** with `npm run restart`. On the board, **New task** now has a **Jira ticket** field. Paste a key and the ticket's summary should appear under it.

## Turning on automatic pickup

Set `jql` to a query that only matches tickets you mean to hand to an agent. The safest setup is a label nobody uses yet, so nothing gets picked up until you add that label to a ticket:

```
assignee = currentUser() AND labels = fleet AND statusCategory = "To Do"
```

Paste the query into Jira's issue search first and check what it matches. **Every match starts an agent**, up to `dispatch.maxConcurrent` (4 by default) at a time, and the rest wait in Queued.

After a restart, the board header shows `Jira: checked … ago` and a **check now** button. If a matching ticket has no folder (its project isn't in `repos` and none of its labels names a repo), it is skipped and the header shows "N tickets without a folder". Hover over that text to see which tickets.

## If something is wrong

| What you see | What to do |
|---|---|
| New task has no Jira field, just a note about fleet.config.json | `baseUrl` or the token is missing. `setx` only reaches programs started after it ran, so run `npm run restart`. If that's not enough, sign out of Windows and back in. |
| "Jira rejected the credentials (401)" | Check that `email` is the one you sign in to Jira with, and that the token was copied whole. |
| "Not found in Jira (404)" | Check the key, or your account can't see that project. |
| `unable to get local issuer certificate` or `self-signed certificate in certificate chain` | A company proxy is inspecting HTTPS traffic. Get the company root certificate as a `.pem` file, run `setx NODE_EXTRA_CA_CERTS "C:\path\to\company-root.pem"`, then restart Fleet. |
| A ticket says "No folder for PROJ-123" | Add `PROJ` under `repos`, or choose the working directory in the New task form. |
| Your company hosts Jira itself (the URL isn't `*.atlassian.net`) | Leave `email` empty and set `JIRA_API_TOKEN` to a personal access token from your Jira profile. Fleet then uses Jira Data Center's API. |

## Handing this to Claude Code

You can point Claude Code at this file and ask it to set Jira up. The section below is written for it.

### Instructions for Claude Code

You are connecting the person's Fleet install to their company Jira. Fleet is the repo this file is in. Work through these steps in order, and stop and report if one fails.

1. **Update.** Run `git pull` in the Fleet repo. Confirm that `server/jira.ts` exists.
2. **Find the config.** Open `fleet.config.json` in the repo root (it isn't tracked by git). Note `port` (default 7777) and `reposRoot`. If it already has a `jira` section, show it to the person and ask what to change rather than replacing it.
3. **Ask the person for these, in one message:**
   - their Jira URL (a ticket link works; you need the part before `/browse/`)
   - the email they sign in to Jira with
   - which Jira project keys they work in, and which repo each one belongs to. List the folders under `reposRoot` that contain a `.git` folder so they can pick.
   - whether they want automatic pickup now, or hand-linking only for the moment
4. **The token. Do not ask for it in the chat.** Tell them to create one at https://id.atlassian.com/manage-profile/security/api-tokens and run `setx JIRA_API_TOKEN "<token>"` in a separate PowerShell window. Wait until they say it's done. If their Jira URL isn't `*.atlassian.net`, the token is a personal access token from their Jira profile instead, and `email` stays empty.
5. **Write the `jira` section** into `fleet.config.json` in the shape shown in the short way above:
   - `apiToken` stays empty.
   - `repos` paths use forward slashes.
   - Keep the file valid JSON and don't touch the other sections.
   - Set `jql` only if they asked for automatic pickup. In that case, suggest the label-based query above and tell them to try it in Jira's issue search before you save it, because every match starts an agent.
6. **Restart.** Run `npm run restart` from the repo. The `setx` value only reaches processes started after it ran. If Fleet still doesn't see the token after the restart, have them sign out of Windows and back in, then restart again.
7. **Verify** (replace 7777 with the configured port):
   - `(Invoke-RestMethod http://127.0.0.1:7777/api/snapshot).jira` should show `enabled : True`.
   - `Invoke-RestMethod http://127.0.0.1:7777/api/jira/issue/<A-REAL-KEY>` should return the ticket's summary and a `cwd` from `repos`. Ask the person for a ticket key they can see.
   - If `jql` is set: `Invoke-RestMethod -Method Post http://127.0.0.1:7777/api/jira/poll` should return `error` empty. Report any `unmapped` tickets. **This call starts agents on every new match**, so run it only after the person has agreed to the query.
8. **If verification fails**, use the troubleshooting table above. A certificate error means a corporate proxy: ask the person for their company's root certificate rather than turning TLS checks off.
9. **Report back:**
   - what's configured, with the token left out
   - what the verification returned
   - how to use it: New task → paste a ticket key or link, or add the label to a ticket if automatic pickup is on

Never commit `fleet.config.json`, and never write the token into any file.
