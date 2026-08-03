# Dashboard frontend build (M2.1)

`dashboard/dist/index.html` is still the legacy hand-authored single-file SPA
and keeps working with **zero build step** — `npm start` serves it as-is.

`dashboard/src/` is a new, separate Preact codebase for panels that will
eventually replace pieces of the legacy script. It builds to a single bundle,
`dashboard/dist/review.js`, which is committed (not generated at deploy time)
and loaded by an added `<script src="review.js"></script>` tag at the end of
`index.html`.

## Build

```
npm run build:ui
```

Runs `vite build --config dashboard/vite.config.ts` and writes
`dashboard/dist/review.js`. Re-run this and commit the output whenever
`dashboard/src/**` changes — there is no watch/dev-server wiring yet.

## Structure

- `dashboard/src/main.tsx` — entry point; calls `mountPanel` once per panel.
- `dashboard/src/mount.tsx` — `mountPanel(containerId, Component)`. Each
  panel gets its own container div in `index.html` and its own `render()`
  call — no panel reaches into another panel's tree or a shared root.
- `dashboard/src/bridge.ts` — the *only* coupling point to the legacy
  script: namespaced `window` CustomEvents (`emit`/`on`). No shared globals
  or shared state objects with the legacy code.
- `dashboard/src/panels/` — one file per panel. `ReviewPanel.tsx` is the
  current placeholder for the gated-review UI (ALP-1553) — it renders
  nothing visible yet; the real review/diff UI is a later milestone.

## Conventions for new panels

1. Add a container div to `dashboard/dist/index.html` (e.g.
   `<div id="my-panel-root"></div>`) and call `mountPanel('my-panel-root',
   MyPanel)` from `main.tsx`.
2. Style with the existing CSS custom properties already defined in
   `index.html` (`var(--bg)`, `var(--accent)`, `var(--border)`, etc.) —
   don't pull in a CSS framework. This keeps new panels visually consistent
   with the legacy UI without needing a shared stylesheet build step.
3. Talk to the legacy script only through `dashboard/src/bridge.ts`.

## Verifying a change

- `npm run build:ui` succeeds and updates `dashboard/dist/review.js`.
- `npx tsc --noEmit` still passes (dashboard/src has its own
  `dashboard/tsconfig.json` and is intentionally excluded from the root
  gateway typecheck).
- Load the dashboard in a browser: the legacy UI should render unchanged,
  and `document.querySelector('[data-testid="review-panel-mounted"]')`
  should exist in the DOM (proves the Preact root mounted).
