let searchIndex = null;
let chunksMap = null;
let isReady = false;

// Pollinations is free and requires no API key. OpenAI-compatible endpoint.
const LLM_API_URL = "https://text.pollinations.ai/openai";
const LLM_MODEL = "openai";
const TOP_K = 8;
const LLM_TIMEOUT_MS = 30000;

let currentAbort = null;
let currentPhraseInterval = null;
let currentThinkingDiv = null;
let pendingAttachments = []; // { name, type, base64, dataUrl }

// DOM elements
const messagesEl = document.getElementById("messages");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const apiKeyInput = document.getElementById("api-key");
const apiKeyHint = document.getElementById("api-key-hint");
const saveKeyBtn = document.getElementById("save-key-btn");
const statusEl = document.getElementById("index-status");

// Pollinations needs no key — hide the API key UI entirely.
const keySection = document.getElementById("api-key-section");
if (keySection) keySection.style.display = "none";

// Session usage tracking (Pollinations is keyless, so no server-side dashboard —
// we accumulate tokens and request counts client-side for the bottom-right badge).
const usage = { requests: 0, tokens: 0, model: "—" };
const usageModelEl = document.getElementById("usage-model");
const usageRequestsEl = document.getElementById("usage-requests");
const usageTokensEl = document.getElementById("usage-tokens");

function renderUsage() {
  usageModelEl.textContent = usage.model;
  usageRequestsEl.textContent = usage.requests;
  usageTokensEl.textContent = usage.tokens;
}
renderUsage();

// Load search index and chunks
async function loadIndex() {
  try {
    statusEl.textContent = "Loading search index...";
    const [indexRes, chunksRes] = await Promise.all([
      fetch("docs-index.json"),
      fetch("docs-chunks.json"),
    ]);

    const serializedIndex = await indexRes.json();
    searchIndex = lunr.Index.load(serializedIndex);

    chunksMap = await chunksRes.json();

    isReady = true;
    statusEl.textContent = `Index loaded - ${Object.keys(chunksMap).length} chunks ready`;
  } catch (err) {
    statusEl.textContent = "Failed to load index. Run 'npm run build' first.";
    console.error("Failed to load index:", err);
  }
}

// Search for relevant chunks
function retrieveContext(query) {
  if (!searchIndex || !chunksMap) return [];

  const resultMap = new Map();

  function addResult(ref, score) {
    const chunk = chunksMap[ref];
    if (!chunk?.content) return;
    const existing = resultMap.get(ref);
    if (!existing || score > existing.score) {
      resultMap.set(ref, { id: ref, score, ...chunk });
    }
  }

  function addSearchResults(searchQuery, multiplier = 1) {
    try {
      searchIndex.search(searchQuery).forEach((r) => addResult(r.ref, r.score * multiplier));
    } catch (err) {
      console.warn("Search query failed:", searchQuery, err);
    }
  }

  function sectionFromRef(ref) {
    const match = ref.match(/#(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  addSearchResults(query, 1);

  const normalized = query.toLowerCase();
  const modelIntent =
    /\b(model|models|provider|providers|llama|ollama|openrouter|groq|mistral)\b/.test(normalized);

  if (modelIntent) {
    addSearchResults("model providers ollama openrouter models set onboard", 0.9);

    const pathBoosts = {
      "providers/models.md": 40,
      "cli/models.md": 38,
      "cli/onboard.md": 34,
      "providers/ollama.md": /\b(llama|ollama|local)\b/.test(normalized) ? 39 : 35,
      "providers/openrouter.md": /\b(llama|openrouter|hosted|cloud)\b/.test(normalized) ? 37 : 33,
    };

    for (const [ref, chunk] of Object.entries(chunksMap)) {
      const boost = pathBoosts[chunk.path];
      if (boost) {
        addResult(ref, boost - sectionFromRef(ref) / 10);
      }
    }
  }

  const ranked = [...resultMap.values()].sort((a, b) => b.score - a.score);

  if (modelIntent) {
    const pathCounts = {};
    const diversified = [];
    for (const result of ranked) {
      pathCounts[result.path] = pathCounts[result.path] || 0;
      if (pathCounts[result.path] >= 2) continue;
      diversified.push(result);
      pathCounts[result.path] += 1;
      if (diversified.length === TOP_K) return diversified;
    }
  }

  return ranked.slice(0, TOP_K);
}

// Format retrieved chunks into context string
function buildContext(chunks) {
  return chunks
    .map(
      (c, i) =>
        `[Source ${i + 1}: ${c.path}]\n${c.title}\n---\n${c.content}`
    )
    .join("\n\n");
}

function buildSystemPrompt(context) {
  return `You are Open Docs, a helper bot whose job is to make setting up OpenClaw (a self-hosted AI gateway that connects messaging apps to AI agents) less annoying.

Answer based ONLY on the provided documentation context. If the context doesn't contain enough information to answer, say so honestly.

Style rules (strict):
- No greetings. Never open with "Hey", "Hi", "Hello", "Welcome", or similar.
- No emoji.
- No "how can I help you today" menus or bulleted lists of options asking the user what they want.
- No self-introduction. Do not say who you are or what you do.
- Answer the question directly. If the user's message is vague, ask one short clarifying question — do not offer a menu of possibilities.
- Keep answers concise and practical. Prefer step-by-step setup instructions when the user is trying to get something working.
- Use markdown formatting.
- Cite sources inline using [1], [2], etc. matching the source numbers provided. Place the citation right after the claim it supports. Only cite sources you actually use.

Documentation context:
${context}`;
}

// Call Pollinations (OpenAI-compatible, free, no key required)
async function callLLM(userMessage, context, signal, attachments) {
  // OpenAI-format content array: text + images via image_url
  const content = [{ type: "text", text: userMessage }];
  for (const att of attachments) {
    if (att.type.startsWith("image/")) {
      content.push({
        type: "image_url",
        image_url: { url: att.dataUrl },
      });
    }
  }

  const requestAbort = new AbortController();
  let didTimeout = false;
  const timeout = setTimeout(() => {
    didTimeout = true;
    requestAbort.abort();
  }, LLM_TIMEOUT_MS);
  const abortRequest = () => requestAbort.abort();
  signal.addEventListener("abort", abortRequest, { once: true });

  let response;
  try {
    response = await fetch(LLM_API_URL, {
      signal: requestAbort.signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: "system", content: buildSystemPrompt(context) },
          { role: "user", content },
        ],
      }),
    });
  } catch (err) {
    if (didTimeout) {
      throw new Error("The model request timed out after 30 seconds. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortRequest);
  }

  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`API error: ${response.status} ${err}`);
  }

  const data = await response.json();

  if (!data.choices?.[0]?.message?.content) {
    throw new Error("API response did not include an assistant message.");
  }

  // Update session usage badge with the model + token counts from this response.
  if (data.model) usage.model = data.model;
  if (data.usage?.total_tokens) usage.tokens += data.usage.total_tokens;
  usage.requests += 1;
  renderUsage();

  return data.choices[0].message.content;
}

// Build source URL map from chunks: { 1: { path, url }, 2: ... }
function buildSourceMap(chunks) {
  const map = {};
  if (!chunks) return map;
  chunks.forEach((c, i) => {
    const path = c.path;
    const url = `https://docs.openclaw.ai/${path.replace(/\.md$/, "").replace(/\/index$/, "")}`;
    map[i + 1] = { path, url };
  });
  return map;
}

// Simple markdown rendering
function renderMarkdown(text, sourceMap) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  let result = escaped
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Images (must come before links)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="chat-img">')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Inline citations: turn [1], [2] etc. into superscript links
  if (sourceMap) {
    result = result.replace(/\[(\d+)\]/g, (match, num) => {
      const src = sourceMap[parseInt(num)];
      if (!src) return match;
      return `<a href="${src.url}" target="_blank" rel="noopener" class="cite" title="${src.path}">[${num}]</a>`;
    });
  }

  // Line breaks to paragraphs
  return result
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Add message to chat
function addMessage(role, content, sources = null) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  const sourceMap = buildSourceMap(sources);
  let html = `<div class="message-content">${renderMarkdown(content, sourceMap)}</div>`;

  // Show a compact source legend if the answer has inline citations
  const citedNums = [...content.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1]));
  const uniqueCited = [...new Set(citedNums)].filter((n) => sourceMap[n]).sort((a, b) => a - b);

  if (uniqueCited.length > 0) {
    const legend = uniqueCited
      .map((n) => {
        const s = sourceMap[n];
        const label = s.path.replace(/\.md$/, "").replace(/\/index$/, "");
        return `<a href="${s.url}" target="_blank" rel="noopener">[${n}] ${label}</a>`;
      })
      .join("");
    html += `<div class="sources">${legend}</div>`;
  }

  div.innerHTML = html;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Handle send
async function handleSend() {
  const query = userInput.value.trim();
  if (!query || !isReady) return;

  // Cancel any in-flight request
  if (currentAbort) {
    currentAbort.abort();
    clearInterval(currentPhraseInterval);
    if (currentThinkingDiv) currentThinkingDiv.remove();
  }
  const abort = new AbortController();
  currentAbort = abort;

  // Grab and clear attachments
  const attachments = [...pendingAttachments];
  pendingAttachments = [];
  document.getElementById("attachments").innerHTML = "";

  userInput.value = "";
  sendBtn.disabled = true;

  document.getElementById("app").classList.remove("landing");
  document.getElementById("chat-container").classList.remove("centered");

  // Show user message with image previews
  let userHtml = query;
  if (attachments.length > 0) {
    const imgs = attachments
      .filter((a) => a.type.startsWith("image/"))
      .map((a) => `![${a.name}](${a.dataUrl})`)
      .join("\n");
    if (imgs) userHtml = imgs + "\n\n" + query;
  }
  addMessage("user", userHtml);

  // Show thinking indicator without depending on another external API.
  currentThinkingDiv = addMessage("assistant", "Thinking...");
  const thinkingDiv = currentThinkingDiv;
  const thinkingContent = thinkingDiv.querySelector(".message-content");
  thinkingContent.classList.add("thinking");

  const thinkingPhrases = [
    "Finding the closest docs...",
    "Checking the relevant OpenClaw pages...",
    "Asking the model...",
  ];
  let phraseIndex = 0;
  thinkingContent.textContent = thinkingPhrases[phraseIndex];
  currentPhraseInterval = setInterval(() => {
    phraseIndex = (phraseIndex + 1) % thinkingPhrases.length;
    if (!abort.signal.aborted) thinkingContent.textContent = thinkingPhrases[phraseIndex];
  }, 4000);
  const phraseInterval = currentPhraseInterval;

  try {
    // Retrieve relevant chunks
    const chunks = retrieveContext(query);

    if (chunks.length === 0) {
      clearInterval(phraseInterval);
      thinkingDiv.remove();
      addMessage(
        "assistant",
        "I couldn't find any relevant documentation for that query. Try rephrasing or asking about a specific OpenClaw feature."
      );
      sendBtn.disabled = false;
      return;
    }

    const context = buildContext(chunks);
    const answer = await callLLM(query, context, abort.signal, attachments);

    if (abort.signal.aborted) return;

    clearInterval(phraseInterval);
    currentThinkingDiv = null;
    thinkingDiv.remove();
    addMessage("assistant", answer, chunks);
  } catch (err) {
    if (err.name === "AbortError" || abort.signal.aborted) return;
    console.error("Model call failed:", err.message);
    clearInterval(phraseInterval);
    currentThinkingDiv = null;
    thinkingDiv.remove();
    addMessage("assistant", err.message || "Service is temporarily unavailable. Please check back later.");
  }

  currentAbort = null;
  sendBtn.disabled = false;
  userInput.focus();
}

// Event listeners
sendBtn.addEventListener("click", handleSend);

userInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});


// Theme toggle
const themeToggleBtn = document.getElementById("theme-toggle");
const prefersLight =
  window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
const savedTheme =
  localStorage.getItem("theme") || (prefersLight ? "light" : "dark");
document.documentElement.setAttribute("data-theme", savedTheme);

themeToggleBtn.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
});

// File attachments
const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const attachmentsEl = document.getElementById("attachments");
const inputArea = document.getElementById("input-area");

function readFileAsBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1];
      resolve({ name: file.name, type: file.type, base64, dataUrl });
    };
    reader.readAsDataURL(file);
  });
}

function renderAttachmentPreview(att) {
  const div = document.createElement("div");
  div.className = "attachment-preview";

  if (att.type.startsWith("image/")) {
    div.innerHTML = `<img src="${att.dataUrl}" alt="${att.name}"><button class="remove-btn">&times;</button>`;
  } else {
    div.innerHTML = `<div class="file-label">${att.name}</div><button class="remove-btn">&times;</button>`;
  }

  div.querySelector(".remove-btn").addEventListener("click", () => {
    pendingAttachments = pendingAttachments.filter((a) => a !== att);
    div.remove();
  });

  attachmentsEl.appendChild(div);
}

async function addFiles(files) {
  for (const file of files) {
    const att = await readFileAsBase64(file);
    pendingAttachments.push(att);
    renderAttachmentPreview(att);
  }
}

attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files.length) addFiles(fileInput.files);
  fileInput.value = "";
});

// Drag and drop
inputArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  inputArea.classList.add("drag-over");
});

inputArea.addEventListener("dragleave", () => {
  inputArea.classList.remove("drag-over");
});

inputArea.addEventListener("drop", (e) => {
  e.preventDefault();
  inputArea.classList.remove("drag-over");
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});

// Also support paste
userInput.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// Initialize
loadIndex();
