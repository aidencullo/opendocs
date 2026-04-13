const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT || "";
const MAX_CANDIDATES = 32;
const TOP_K = 8;
const MAX_CHUNK_CHARS = 1200;
const REQUEST_TIMEOUT_MS = 25000;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function cleanCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  const id = String(candidate.id || "").slice(0, 200);
  const title = String(candidate.title || "").slice(0, 200);
  const path = String(candidate.path || "").slice(0, 300);
  const content = String(candidate.content || "").slice(0, MAX_CHUNK_CHARS);
  const score = Number.isFinite(candidate.score) ? candidate.score : 0;
  if (!id || !path || !content) return null;
  return { id, title, path, content, score };
}

function buildSystemPrompt(context) {
  return `You are Open Docs, a helper bot whose job is to make setting up OpenClaw (a self-hosted AI gateway that connects messaging apps to AI agents) less annoying.

Answer based ONLY on the provided documentation context. If the context does not contain enough information to answer, say so honestly.

Style rules:
- No greetings.
- No emoji.
- Answer directly.
- Keep answers concise and practical.
- Prefer setup commands when the user is trying to get something working.
- Use markdown formatting.
- Cite sources inline using [1], [2], etc. matching the source numbers provided. Put citations immediately after the supported claim.

Documentation context:
${context}`;
}

function buildContext(chunks) {
  return chunks
    .map((chunk, index) => `[Source ${index + 1}: ${chunk.path}]\n${chunk.title}\n---\n${chunk.content}`)
    .join("\n\n");
}

function buildUserContent(message, attachments) {
  const content = [{ type: "input_text", text: message }];
  for (const attachment of attachments || []) {
    if (
      attachment &&
      typeof attachment.dataUrl === "string" &&
      typeof attachment.type === "string" &&
      attachment.type.startsWith("image/") &&
      attachment.dataUrl.startsWith("data:image/")
    ) {
      content.push({ type: "input_image", image_url: attachment.dataUrl });
    }
  }
  return content;
}

function extractResponseText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text;
  }

  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if ((content.type === "output_text" || content.type === "text") && content.text) {
        return content.text;
      }
    }
  }

  return "";
}

function usageTotal(usage) {
  if (!usage) return 0;
  return usage.total_tokens || usage.totalTokens || (usage.input_tokens || 0) + (usage.output_tokens || 0);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

async function openaiFetch(path, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${OPENAI_BASE_URL}${path}`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify(payload),
        });

        if (response.ok) return response.json();

        const text = await response.text().catch(() => "");
        lastError = new Error(`OpenAI ${path} failed with ${response.status}: ${text}`);
        if (![408, 409, 429, 500, 502, 503, 504].includes(response.status)) break;
      } catch (err) {
        lastError = err;
        if (err.name === "AbortError") break;
      }

      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }

    throw lastError || new Error(`OpenAI ${path} failed`);
  } finally {
    clearTimeout(timeout);
  }
}

async function rerankCandidates(message, candidates) {
  if (process.env.OPENAI_EMBEDDINGS === "off" || candidates.length <= TOP_K) {
    return candidates.slice(0, TOP_K);
  }

  const inputs = [
    message,
    ...candidates.map((candidate) => `${candidate.title}\n${candidate.path}\n${candidate.content}`),
  ];

  try {
    const data = await openaiFetch("/embeddings", {
      model: OPENAI_EMBEDDING_MODEL,
      input: inputs,
    });

    const embeddings = (data.data || []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
    const queryEmbedding = embeddings[0];
    if (!queryEmbedding) return candidates.slice(0, TOP_K);

    const maxLexicalScore = Math.max(...candidates.map((candidate) => candidate.score), 1);
    return candidates
      .map((candidate, index) => {
        const semantic = embeddings[index + 1]
          ? cosineSimilarity(queryEmbedding, embeddings[index + 1])
          : 0;
        const lexical = Math.max(0, candidate.score) / maxLexicalScore;
        return {
          ...candidate,
          score: semantic * 0.8 + lexical * 0.2,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_K);
  } catch (err) {
    console.warn("[opendocs] embedding rerank failed, using lexical candidates", err.message);
    return candidates.slice(0, TOP_K);
  }
}

async function answerWithOpenAI(message, sources, attachments) {
  const body = {
    model: OPENAI_MODEL,
    instructions: buildSystemPrompt(buildContext(sources)),
    input: [
      {
        role: "user",
        content: buildUserContent(message, attachments),
      },
    ],
  };

  if (OPENAI_REASONING_EFFORT) {
    body.reasoning = { effort: OPENAI_REASONING_EFFORT };
  }

  const data = await openaiFetch("/responses", body);
  const answer = extractResponseText(data);
  if (!answer) throw new Error("OpenAI response did not include output text");

  return {
    answer,
    model: data.model || OPENAI_MODEL,
    usage: {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      totalTokens: usageTotal(data.usage),
    },
  };
}

module.exports = async function handler(req, res) {
  const started = Date.now();

  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(res, 500, { error: "OPENAI_API_KEY is not configured" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const message = String(body.message || "").trim();
    const candidates = (Array.isArray(body.candidates) ? body.candidates : [])
      .slice(0, MAX_CANDIDATES)
      .map(cleanCandidate)
      .filter(Boolean);
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 4) : [];

    if (!message) return json(res, 400, { error: "message is required" });
    if (!candidates.length) return json(res, 400, { error: "candidates are required" });

    const sources = await rerankCandidates(message, candidates);
    const result = await answerWithOpenAI(message, sources, attachments);

    console.info(
      "[opendocs] chat",
      JSON.stringify({
        ms: Date.now() - started,
        model: result.model,
        candidates: candidates.length,
        sources: sources.map((source) => source.path),
        tokens: result.usage.totalTokens,
      })
    );

    return json(res, 200, {
      answer: result.answer,
      model: result.model,
      usage: result.usage,
      sources,
    });
  } catch (err) {
    console.error("[opendocs] chat failed", err);
    return json(res, 500, { error: "Chat request failed" });
  }
};
