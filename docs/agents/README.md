# Working on Fleet as an agent

Start here if you are a Claude session asked to change this app.

## Orientation

- `server/` is a Node + TypeScript API, run with `tsx` (no build step). `server/index.ts` is the route list; `server/collector.ts` builds the snapshot; `server/chat.ts` hosts chats; `server/dialogue.ts` runs two chats against each other on a topic; `server/fleetTools.ts` is the agent-to-agent toolset; `server/aws.ts` is the credential hub.
- `web/` is React + TypeScript + Vite + Tailwind. `web/src/lib/store.ts` holds all UI state (one external store, no context tree). Views live in `web/src/views`, shell pieces in `web/src/components`.
- `shared/types.ts` is the contract between the two. Change it first, then both sides.
- `docs/plans/` is the design intent. Where it disagrees with the code, the code wins; update the doc.

## Running

```
npm run dev        # API on 7778 with restart-on-change, Vite on 5178 with HMR
npm run check      # typecheck both sides and build the web app
node scripts/smoke.mjs http://127.0.0.1:7778   # the running dev API renders in headless Chrome; ship runs this against every build before the restart
npm start          # daily instance: API on 7777 serving dist/web
```

The daily instance on 7777 belongs to the person using the app. Never restart it from a dev task; it ends their live chats.

## Conventions

- Comments explain the non-obvious in one line; no docblocks, no commented-out code.
- No raw colors in components; use the tokens in `styles.css`.
- Status is always a dot plus a label. Selection and interaction use the accent; nothing else does.
- Destructive buttons confirm by a second click, not a modal.
- Keys and tokens never reach a log line or an event payload. The AWS hub shows expiry and identity only.
- Do not add dependencies for things a few lines of code can do. Current list: express, the Agent SDK, zod, puppeteer-core, node-pty, ws, react, lucide-react, @xterm/xterm (+ addon-fit), tailwind, vite, typescript, tsx.

## Decisions already made

- Backend stays Node because the Agent SDK is a Node library. A desktop shell (Tauri) would wrap this server, not replace it.
- Never build a fallback inside a `useStore` selector (`s.x || []`, `.map`, `.filter`): a fresh value each read makes useSyncExternalStore loop until React gives up, and the page is blank. Select the raw field; apply the fallback outside.
- `claude agents --json` is the source of truth for sessions. The jobs folder and transcript files are read best-effort only; their format is not a stable contract.
- Chats that resume a session currently open in a terminal are forked, never shared.
- Automated approval of the AWS SSO consent page is off. The code exists (`server/awsApprove.ts`) but the user's Entra tenant prompts for sign-in in a fresh profile every time, which defeats the purpose.
