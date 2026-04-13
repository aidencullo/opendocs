# Claude orientation

A small RAG app over the OpenClaw docs. The browser still does local Lunr candidate retrieval, but the upgraded production path uses a serverless `/api/chat` route for server-side model calls and embedding rerank.

## Architecture in one paragraph

`build-index.js` reads markdown from `../openclaw/docs/`, chunks it (800 chars, 100 overlap), and builds a [Lunr](https://lunrjs.com/) full-text index serialized to `docs-index.json`. The raw chunks live in `docs-chunks.json`. In the browser, `app.js` loads both, runs `lunr.search(query)` to pull candidate chunks, and posts them to `/api/chat`. The serverless route reranks candidates with OpenAI embeddings and calls the OpenAI Responses API. If `/api/chat` is unavailable, the browser falls back to Pollinations so the static GitHub Pages deployment still works.

## Workflow

- **Auto commit and push.** When the user asks for a change, make the edits and immediately commit + push in the same flow — no "want me to commit?" prompt. Deploy is wired to `main`, so pushing *is* deploying.

## Conventions

- **Never commit an API key.** `OPENAI_API_KEY` belongs in the serverless host environment. Do not put provider keys in frontend code or committed files.
- **Regenerating the index**: run `npm run build` after any change to `build-index.js` or the upstream `openclaw/docs` tree. The two JSON artifacts are committed on purpose so GitHub Pages can serve them without a build step.
- **Deploy model**: the GitHub Pages workflow still deploys the static fallback. The upgraded `/api/chat` path requires a serverless host such as Vercel with `OPENAI_API_KEY` configured.
- **No framework, no bundler.** Keep dependencies minimal. Lunr is loaded via unpkg `<script>` tag.

## Things that will bite you

- The deployed `app.js` is public. Never inject provider keys into it.
- `docs-index.json` is ~9 MB. If it grows much larger, load time on Pages will suffer — prefer lowering `CHUNK_SIZE` before adding more aggressive indexing.
- The `DOCS_DIR` path in `build-index.js` is relative to a sibling checkout of `openclaw` at `../openclaw/docs`. Rebuilding the index requires that directory to exist locally.

## Out of scope

Do not add: a vector DB, a framework, a build/bundle step, or committed secrets. If a change seems to require those, stop and ask.
