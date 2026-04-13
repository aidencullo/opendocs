# Agents guide

Guidance for any coding agent (Claude, Codex, Cursor, etc.) working in this repo. If you are Claude Code, also read `CLAUDE.md`.

## What this repo is

A small RAG chatbot for the OpenClaw docs. The static frontend still works on GitHub Pages, but the upgraded path uses a serverless `/api/chat` route for controlled server-side inference and embedding rerank.

## The whole pipeline

1. `build-index.js` chunks markdown from `../openclaw/docs/**/*.md` (800 chars, 100 overlap) and builds a Lunr full-text search index.
2. The index (`docs-index.json`) and the raw chunk map (`docs-chunks.json`) are committed so GitHub Pages can serve them as static assets.
3. In the browser, `app.js` loads both JSONs, calls `lunr.search(query)` for candidate chunks, and posts those candidates to `/api/chat`.
4. `api/chat.js` reranks the candidates with OpenAI embeddings and calls the OpenAI Responses API server-side.
5. If `/api/chat` is unavailable, the browser falls back to the public Pollinations endpoint so static GitHub Pages deployments do not break.

Retrieval starts as lexical (Lunr BM25-ish), the production path reranks with embeddings, and generation is server-side OpenAI Responses.

## Rules

- **No secrets in source.** `OPENAI_API_KEY` must live in the serverless host environment. Never commit a real key.
- **Keep it lightweight.** No framework, no bundler, no build step beyond `npm run build` (which only regenerates the two JSON files). Dependencies are loaded via `<script>` from unpkg.
- **Regenerate the index** after editing `build-index.js` or when the upstream docs change. The JSON artifacts are checked in intentionally.
- **Public deploy.** Anything shipped in `_site/` is world-readable. Treat build-time injection as "public with extra steps" — only throwaway keys belong in the secret.

## Don't

- Add embeddings, a vector DB, or any ML dependency.
- Add a framework (React, Next.js, Svelte, etc.).
- Add a bundler or transpiler.
- Commit node_modules, `_site`, or secrets.

If a task seems to require a vector DB, framework, bundler, or committed secret, stop and ask the human first.

## Layout

```
index.html            chat UI
style.css             styles
app.js                retrieval + Anthropic API call (browser)
api/chat.js           serverless inference + embedding rerank
build-index.js        doc chunker + Lunr index builder (Node)
docs-index.json       committed Lunr index (~9 MB)
docs-chunks.json      committed chunk-id → {title, path, content} map (~3 MB)
.github/workflows/    GitHub Pages deploy + key injection
```
