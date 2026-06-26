# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Nature

This is a **deployment-only repository** — it contains compiled build output for GitHub Pages, not the TypeScript/React source code. The actual source (`.ts`, `.tsx`, `package.json`, `vite.config.ts`, etc.) lives in a separate development repo that gets built and copied here.

Workflow: develop in the source repo → build with Vite → copy output files here → commit and push to trigger GitHub Pages deployment.

## Entry Points

Four standalone HTML pages serve different audiences:

| File | Purpose |
|---|---|
| `index.html` | Admin interface — tournament management (React app via Vite bundle) |
| `live.html` | Live bracket view for streaming/audience, self-contained with inline JS |
| `public.html` | Public read-only bracket display |
| `overlay.html` | OBS stream overlay (transparent background, no controls) |

`index.html` loads a hashed Vite bundle from `/assets/`. The other three pages are largely self-contained with inline JavaScript.

## Assets

`/assets/` contains Vite-emitted bundles with content-hash filenames (e.g., `index-D14P7Qxh.js`). After each build, `index.html` must reference the new hash. Old bundles accumulate here — they are safe to delete when no longer referenced by any HTML file.

## Debug / Version Tracking

`__manus__/version.json` records the build timestamp and a short commit hash. Update this manually or via the build pipeline after deploying. `__manus__/debug-collector.js` is an agent-friendly logging utility injected at runtime.

## Design System

All pages share a "Cold Steel" CSS custom-property palette:

```
--cb-bg: #0a0a0a       --cb-purple: #9b6dff
--cb-panel: #111115    --cb-green:  #22c55e
--cb-border: #222228   --cb-gold:   #f59e0b
--cb-text: #e8e8f0
```

Font: **Saira Condensed** (Google Fonts, weights 400/600/800).

## Bracket Connector Architecture

The bracket rendering engine draws right-angle connector lines between match slots using a gutter-aware corridor layout. Key constraints carried forward from the commit history:

- Connectors route through a vertical gutter between columns (not across match boxes).
- Same-column connectors (e.g., finals) enter from the right side.
- Compact mode re-measures DOM positions after layout settles before drawing connectors.
- The spacer between connector segments is 20 px.

When modifying `live.html` or `index.html` connector logic, preserve these invariants to avoid misaligned drop-lines.

## Deployment

Hosted at GitHub Pages under the base path `/codebreakers-bracket/`. All asset URLs in `index.html` must be prefixed with this base path.
