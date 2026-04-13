# Open Docs

Chatbot grounded in the real [OpenClaw docs](https://github.com/aidencullo/openclaw/tree/main/docs). https://ourclaw.uk/

## Architecture

Build time:

```text
../openclaw/docs/**/*.md
  -> build-index.js
  -> docs-index.json
  -> docs-chunks.json
```

Runtime:

```text
browser
  -> Lunr keyword retrieval over docs-index.json
  -> sends top candidate chunks to /api/chat
  -> server-side embedding rerank with OPENAI_EMBEDDING_MODEL
  -> server-side OpenAI Responses inference with OPENAI_MODEL
  -> browser renders answer + citations
```

If `/api/chat` is unavailable, the browser falls back to the old public Pollinations endpoint so the GitHub Pages static deployment still works while the domain is moved to a serverless host.

## Serverless deployment

Deploy on Vercel or another host that supports Node API routes from `api/chat.js`.

Required environment:

- `OPENAI_API_KEY`

Optional environment:

- `OPENAI_MODEL` (default: `gpt-5.4-mini`)
- `OPENAI_EMBEDDING_MODEL` (default: `text-embedding-3-small`)
- `OPENAI_REASONING_EFFORT` (empty by default)
- `OPENAI_EMBEDDINGS=off` to disable embedding rerank and use lexical candidates only
- `OPENAI_BASE_URL` for an OpenAI-compatible gateway

The GitHub Pages workflow only serves the static fallback. To use the upgraded backend on `ourclaw.uk`, point the domain at the serverless deployment and configure `OPENAI_API_KEY` there.
