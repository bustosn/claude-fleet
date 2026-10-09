# 01 — Layout and design system

Fleet reads as a crafted tool, not template output. Reference class: Linear, VS Code's chrome, lazygit's density with real typography. The look borrows the shell of a colleague's Grove app and keeps its rules: dense, quiet, one accent.

## Shell

```
┌ title bar (44px): Fleet mark · sidebar toggle · jump pill (Ctrl+K) · Overview · Hub · theme ┐
├ sidebar (300px, resizable, Ctrl+B) ─────────┬ main ───────────────────────────────────────┤
│ Projects                                     │ Overview: four columns by state             │
│  ▾ COR3                                      │ Chat: header, stream, composer              │
│     ⎇ JL-bluesnap-transport-null-guard ●1 ↑1 │ Worktree: facts, sessions here, saved chats │
│        ● COR3 chat ready           chat      │ Session: what a tty/bg session is doing     │
│     ⎇ JL-7488-dlocal-webhook-ingestion ↓143  │ Hub: tiles for chores                       │
│  ▸ ETL                            development│                                             │
│ Sessions outside a repo                      │                                             │
│ Saved conversations (filter)  +              │                                             │
├ status strip (28px): counts · AWS pill · needs-you bell ───────────────────────────────────┘
```

Sessions are nested under the worktree they run in. That nesting is the memorable thing; everything else stays quiet.

## Tokens

All color, radius, and type values are CSS variables in `web/src/styles.css`; components use Tailwind utilities bound to those tokens (`bg-surface`, `text-fg-muted`, `border-line`). No raw hex in components.

- Dark is the default; light is a full set of its own values, not an inversion. `data-theme` on the root switches instantly.
- Accent: a muted sea blue, used for selection, focus, links, and primary buttons only.
- Status: good / warn / serious / crit, each distinct from the accent, always paired with a label or icon.
- Type: Segoe UI Variable at 13px, 12px in chrome, tabular numerals for counts. Cascadia Code for branches, paths, ids.
- Rows are 28px. Radius 6px, 10px for panels. One shadow, for popovers.

## Interaction rules

- Every row that represents a thing opens that thing in the main pane. No drawers over the content.
- `Ctrl+K` jumps anywhere: sessions, worktrees, saved conversations, actions.
- Destructive actions take two clicks on the same button (the second click confirms), not a modal.
- Async buttons show their working state inline. Nothing bounces; status dots pulse only while working, and not at all under reduced motion.
