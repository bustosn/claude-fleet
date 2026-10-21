# Installing Fleet on a Mac

Fleet runs on your own machine and shows every Claude Code session you have, across your git repos, in one browser window.
You need a Mac and access to this GitHub repo. Everything else is installed for you.

## The short way

Open Terminal in the folder where your git repos live (for example `~/code`) and run:

```
git clone https://github.com/bustosn/claude-fleet.git
cd claude-fleet
./scripts/install.sh
```

If `git` opens a dialog offering the command line developer tools, click Install, wait for it to finish, and run `git clone` again.

The installer:
1. installs the Xcode command line tools, Homebrew, Git, Node.js and Claude Code if any are missing (Homebrew asks for your Mac password)
2. asks where your git repos live (Enter takes the folder you cloned into)
3. installs packages and builds the app
4. signs you in to Claude Code if you are not already
5. starts Fleet, sets it to start again when you log in (and to restart itself within seconds if it ever crashes), and opens http://127.0.0.1:7777

Running it again is safe. To update later: `git pull`, then run the installer again.

### Already running Fleet with `npm start`?

Run `git pull`, then `./scripts/install.sh`. It keeps your `fleet.config.json`, skips the tools you already have, and stops the Fleet you started by hand before taking over. You no longer need a Terminal window open for Fleet; close the one running `npm start`. If you wrote `~/Library/LaunchAgents/com.fleet.plist` by hand from an older version of this file, the installer replaces it.

### Starting and stopping

```
scripts/autostart.sh restart    # or npm run restart
scripts/autostart.sh stop       # until the next login
scripts/autostart.sh remove     # stop it and no longer start at login
```

The log is `state/fleet.log`. The launch agent keeps the PATH you installed with, so if you later move Node or Claude Code (a new nvm version, say), run `scripts/autostart.sh restart` from a Terminal where they work.

Optional: `git config core.hooksPath scripts/hooks` makes a `git pull` on main rebuild and restart Fleet by itself.

## Handing this to Claude Code

You can paste this file into Claude Code and ask it to set Fleet up. The section below is written for it.

### Instructions for Claude Code

You are installing Fleet on a Mac for the person you are talking to. Follow these steps in order and stop to report if one fails. Do not use any `.ps1` file; they are Windows-only.

1. **Ask the person one question first:** which folder their git repos live in. Fleet lists every repo that is a folder directly inside it. Offer their likely code folder (look under their home folder for one containing several folders with a `.git` inside) and let them confirm.
2. **Check two things your shell cannot do for them.** If `xcode-select -p` fails, run `xcode-select --install` and tell the person to click Install in the dialog; wait for `xcode-select -p` to succeed. If `brew` is missing and `git` is missing or `node -v` is below v20, tell the person to install Homebrew from https://brew.sh in their own Terminal, since it needs their password.
3. **Clone, if not already cloned.** Into that repos folder: `git clone https://github.com/bustosn/claude-fleet.git`. The repo is private; if git asks to sign in to GitHub, tell the person a browser window will open and let them finish. If the clone fails with "repository not found", their GitHub account has not been given access yet; stop and tell them.
4. **Run the installer non-interactively** from the clone, with the folder from step 1:
   ```
   ./scripts/install.sh --yes --repos-root "/path/they/gave"
   ```
   `--yes` skips its questions, since your shell cannot answer them. It takes a few minutes the first time. It prints `==> Done` and `running at http://127.0.0.1:7777` when it has worked.
5. **Confirm it is up:** `curl -s http://127.0.0.1:7777/api/config` returns JSON.
6. **Tell the person** Fleet is at http://127.0.0.1:7777, that it starts by itself when they log in, and how to update (`git pull`, then the installer again). If the installer warned they are not signed in, ask them to run `claude auth login` in their own Terminal.

If something fails, the installer's last line says why. Common cases:

| Message | What to do |
|---|---|
| `Xcode command line tools are still missing` | The install dialog was closed or is still running. Finish it, then rerun. |
| `Homebrew is needed ... asks for your password` | Install Homebrew from https://brew.sh in a Terminal, then rerun. |
| `node on PATH is still v18…` | An older Node from nvm or nodejs.org comes first on PATH. `nvm install 20 && nvm alias default 20`, or remove the old Node, then rerun. |
| `installed but is not on PATH yet` | Open a new Terminal window and rerun. |
| `not signed in` (a warning, not a failure) | Run `claude auth login` in Terminal. Fleet works without it, but its chats will not start. |
| `npm install failed` | Read the npm error above it. A network or proxy problem is the usual cause; rerun once it is fixed. |
| `port 7777 is in use by something that is not Fleet` | Stop that program, or rerun with `--port 7787` (any free port) and use that address. |
| `Fleet did not come up` | Read `state/fleet.log` in the clone; its last lines name the problem. |
| A terminal tab cannot find `brew`, `node` or `claude` | Terminals open as a login shell and read `~/.zprofile`; make sure Homebrew's and nvm's setup lines are there, not only in `~/.zshrc`. |

Do not edit `fleet.config.json` by hand unless the installer cannot write it; it holds the repos folder and port and is specific to this machine. Leave `aws.profile` empty: the AWS credential hub's defaults assume Windows.

## Not available on a Mac yet

- `npm run ship` (it merges dev, smoke-tests and restarts; update with `git pull` and the installer instead).
- The daily morning pull (`scripts/install-morning-pull.ps1`).
- The AWS credential hub.

## Uninstalling

```
scripts/autostart.sh remove
```

stops Fleet and removes the launch agent. Then delete the `claude-fleet` folder. Your Claude Code sessions are untouched; Fleet only reads them.
