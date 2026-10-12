# Installing Fleet on Windows

Fleet runs on your own machine and shows every Claude Code session you have, across your git repos, in one browser window.
You need Windows 10 or 11 and access to this GitHub repo. Everything else is installed for you.

## The short way

Open PowerShell in the folder where your git repos live (for example `C:\Users\you\code`) and run:

```
git clone https://github.com/bustosn/claude-fleet.git
cd claude-fleet
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

The installer:
1. installs Git, Node.js and Claude Code if any are missing (Windows may ask for permission)
2. asks where your git repos live (Enter takes the folder you cloned into)
3. installs packages and builds the app
4. signs you in to Claude Code if you are not already
5. starts Fleet, sets it to start again when you log in, and opens http://127.0.0.1:7777

Running it again is safe. To update later: `git pull`, then run the installer again.

## Handing this to Claude Code

You can paste this file into Claude Code and ask it to set Fleet up. The section below is written for it.

### Instructions for Claude Code

You are installing Fleet for the person you are talking to. Follow these steps in order and stop to report if one fails.

1. **Ask the person one question first:** which folder their git repos live in. Fleet lists every repo that is a folder directly inside it. Offer their likely code folder (look for one under their home folder that contains several folders with a `.git` inside) and let them confirm.
2. **Clone, if not already cloned.** Clone into that repos folder: `git clone https://github.com/bustosn/claude-fleet.git`. The repo is private; if git asks to sign in to GitHub, tell the person a browser window will open for it and let them finish. If the clone fails with "repository not found", their GitHub account has not been given access yet; stop and tell them.
3. **Run the installer non-interactively** from the clone, with the folder from step 1:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Yes -ReposRoot "C:\path\they\gave"
   ```
   `-Yes` skips its questions, since your shell cannot answer them. It takes a few minutes the first time. It prints `==> Done` and `running at http://127.0.0.1:7777` when it has worked.
4. **Confirm it is up:** `Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7777/api/config` returns JSON.
5. **Tell the person** Fleet is at http://127.0.0.1:7777, that it starts by itself when they log in, and how to update (`git pull`, then the installer again).

If something fails, the installer's last line says why. Common cases:

| Message | What to do |
|---|---|
| `winget is not available` | Have the person install "App Installer" from the Microsoft Store, then rerun. |
| `installed but is not on PATH yet` | A new tool was installed. Open a new PowerShell window and rerun the same command. |
| `Node is still v18…` (or older) | An old Node.js is installed. Have the person remove it in Settings > Apps, then rerun. |
| `not signed in` (a warning, not a failure) | Have the person run `claude auth login` in their own terminal. Fleet works without it, but its chats will not start. |
| `npm install failed` | Read the npm error above it. A network or proxy problem is the usual cause; rerun once it is fixed. |
| `Fleet did not come up` | Read `state\fleet.log` in the clone; its last lines name the problem. |
| Port 7777 already in use | Rerun with `-Port 7787` (any free port), and tell the person the new address. |

Do not edit `fleet.config.json` by hand unless the installer cannot write it; it holds the repos folder and port and is specific to this machine.

## Uninstalling

```
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove
```

stops Fleet and removes the logon task. Then delete the `claude-fleet` folder. Your Claude Code sessions are untouched; Fleet only reads them.
