# OpenClaw Docs RAG

A tiny retrieval-augmented chatbot for the [OpenClaw](https://github.com/openclaw/openclaw) documentation. Runs entirely in the browser — no server, no vector database, no embeddings.

**Live:** https://aidencullo.github.io/openclaw-rag-chatbot/

## How the RAG works

1. `build-index.js` walks `../openclaw/docs/*.md`, strips frontmatter and code blocks, and splits each file into ~800-char chunks with 100-char overlap.
2. It feeds every chunk into [Lunr](https://lunrjs.com/) (a client-side full-text search library, BM25-ish) and serializes the index to `docs-index.json`. The raw chunk text is saved separately to `docs-chunks.json`.
3. In the browser, `app.js` loads both JSONs, runs `lunr.search(query)` to retrieve the top 8 chunks, stuffs them into a system prompt, and calls the Anthropic Messages API directly from the page.

That's the whole pipeline: lexical retrieval → prompt stuffing → LLM. No embeddings, no reranker, no server.

## Run locally

```
cd openclaw-rag-chatbot
npm install
npm run build           # regenerate docs-index.json / docs-chunks.json
python3 -m http.server  # serve on http://localhost:8000
```

Open the page, paste your Anthropic API key (stored in `localStorage`), and ask questions.

## Deploy

`.github/workflows/deploy.yml` publishes the static files to GitHub Pages on every push to `main`.

### Optional: hardcoded API key

To skip the key-paste UI, set a repo secret and the workflow will inject it at build time:

```
gh secret set ANTHROPIC_API_KEY --repo aidencullo/openclaw-rag-chatbot
gh workflow run "Deploy to GitHub Pages" --repo aidencullo/openclaw-rag-chatbot
```

**Warning:** the injected key is baked into the deployed `app.js` in plaintext. Anyone who visits the site can read it from the page source. Only use a restricted / throwaway key, and rotate it if the link ever goes public.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `style.css` | Chat UI |
| `app.js` | Retrieval + Anthropic API call |
| `build-index.js` | Chunks the docs and builds the Lunr index |
| `docs-index.json` | Serialized Lunr index (committed) |
| `docs-chunks.json` | Chunk id → `{title, path, content}` map (committed) |
| `.github/workflows/deploy.yml` | GitHub Pages deploy + optional key injection |
