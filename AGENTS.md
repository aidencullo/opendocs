# Agents guide

Guidance for any coding agent (Claude, Codex, Cursor, etc.) working in this repo. If you are Claude Code, also read `CLAUDE.md`.

## What this repo is

A minimal, static, client-side RAG chatbot for the OpenClaw docs. Deployed to GitHub Pages. No backend, no embeddings, no framework.

## The whole pipeline

1. `build-index.js` chunks markdown from `../openclaw/docs/**/*.md` (800 chars, 100 overlap) and builds a Lunr full-text search index.
2. The index (`docs-index.json`) and the raw chunk map (`docs-chunks.json`) are committed so GitHub Pages can serve them as static assets.
3. In the browser, `app.js` loads both JSONs, calls `lunr.search(query)` for the top 8 chunks, concatenates them into a system prompt, and calls the Anthropic Messages API directly from the page.

That's it. Retrieval is lexical (Lunr BM25-ish), generation is Claude.

## Rules

- **No secrets in source.** The placeholder string `__ANTHROPIC_API_KEY__` in `app.js` is injected at deploy time by `.github/workflows/deploy.yml` using `secrets.ANTHROPIC_API_KEY`. Never replace it with a real key in a commit.
- **Stay static.** No Node server, no Next.js, no bundler, no build step beyond `npm run build` (which only regenerates the two JSON files). Dependencies are loaded via `<script>` from unpkg.
- **Regenerate the index** after editing `build-index.js` or when the upstream docs change. The JSON artifacts are checked in intentionally.
- **Public deploy.** Anything shipped in `_site/` is world-readable. Treat build-time injection as "public with extra steps" — only throwaway keys belong in the secret.

## Don't

- Add a backend, API route, or proxy.
- Add embeddings, a vector DB, or any ML dependency.
- Add a framework (React, Next.js, Svelte, etc.).
- Add a bundler or transpiler.
- Commit node_modules, `_site`, or secrets.

If a task seems to require any of the above, stop and ask the human first — the constraint is the point.

## Layout

```
index.html            chat UI
style.css             styles
app.js                retrieval + Anthropic API call (browser)
build-index.js        doc chunker + Lunr index builder (Node)
docs-index.json       committed Lunr index (~9 MB)
docs-chunks.json      committed chunk-id → {title, path, content} map (~3 MB)
.github/workflows/    GitHub Pages deploy + key injection
```
