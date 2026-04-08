# Claude orientation

A throwaway, static RAG demo over the OpenClaw docs. Everything runs in the browser; there is no backend.

## Architecture in one paragraph

`build-index.js` reads markdown from `../openclaw/docs/`, chunks it (800 chars, 100 overlap), and builds a [Lunr](https://lunrjs.com/) full-text index serialized to `docs-index.json`. The raw chunks live in `docs-chunks.json`. In the browser, `app.js` loads both, runs `lunr.search(query)` to pull the top 8 chunks, stuffs them into a system prompt, and calls the Anthropic Messages API directly via `fetch` with `anthropic-dangerous-direct-browser-access: true`. No embeddings, no server, no vector store.

## Workflow

- **Auto commit and push.** When the user asks for a change, make the edits and immediately commit + push in the same flow — no "want me to commit?" prompt. Deploy is wired to `main`, so pushing *is* deploying.

## Conventions

- **Never commit an API key.** `app.js` has a placeholder `const BUILD_TIME_API_KEY = "__ANTHROPIC_API_KEY__"`. The GitHub Actions workflow (`.github/workflows/deploy.yml`) replaces that placeholder with `secrets.ANTHROPIC_API_KEY` when deploying. Leave the placeholder alone in source.
- **Regenerating the index**: run `npm run build` after any change to `build-index.js` or the upstream `openclaw/docs` tree. The two JSON artifacts are committed on purpose so GitHub Pages can serve them without a build step.
- **Deploy model**: static site, pushed to `main`, deployed by `.github/workflows/deploy.yml`. There is no other CI.
- **No framework, no bundler.** Keep dependencies minimal. Lunr is loaded via unpkg `<script>` tag.

## Things that will bite you

- The deployed `app.js` is public. Anything injected at build time (the API key) is visible to anyone viewing the page source. Only throwaway keys should ever go in the `ANTHROPIC_API_KEY` secret.
- `docs-index.json` is ~9 MB. If it grows much larger, load time on Pages will suffer — prefer lowering `CHUNK_SIZE` before adding more aggressive indexing.
- The `DOCS_DIR` path in `build-index.js` is relative to a sibling checkout of `openclaw` at `../openclaw/docs`. Rebuilding the index requires that directory to exist locally.

## Out of scope

Do not add: a backend, a vector DB, an embeddings pipeline, a build/bundle step, or a framework. If a change seems to require any of those, stop and ask — the whole point is that this is ~300 lines of static code.
