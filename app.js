let searchIndex = null;
let chunksMap = null;
let isReady = false;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const QWEN_API_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
const TOP_K = 8;

// Injected at deploy time by the GitHub Actions workflow.
// Left as the placeholder string locally so nothing secret is committed.
const BUILD_TIME_API_KEY = "__ANTHROPIC_API_KEY__";
const HAS_BUILD_TIME_KEY =
  BUILD_TIME_API_KEY && !BUILD_TIME_API_KEY.startsWith("__");

const BUILD_TIME_GEMINI_KEY = "__GEMINI_API_KEY__";
const HAS_GEMINI_KEY =
  BUILD_TIME_GEMINI_KEY && !BUILD_TIME_GEMINI_KEY.startsWith("__");

const BUILD_TIME_QWEN_KEY = "__QWEN_API_KEY__";
const HAS_QWEN_KEY =
  BUILD_TIME_QWEN_KEY && !BUILD_TIME_QWEN_KEY.startsWith("__");

let selectedModel = localStorage.getItem("selected_model") || "qwen";

// DOM elements
const messagesEl = document.getElementById("messages");
const userInput = document.getElementById("user-input");
const sendBtn = document.getElementById("send-btn");
const apiKeyInput = document.getElementById("api-key");
const saveKeyBtn = document.getElementById("save-key-btn");
const statusEl = document.getElementById("index-status");

// Hide the API key prompt entirely when a build-time key was injected.
if (HAS_BUILD_TIME_KEY) {
  const keySection = document.getElementById("api-key-section");
  if (keySection) keySection.style.display = "none";
}

// Load API key from localStorage
const savedKey = localStorage.getItem("anthropic_api_key");
if (savedKey) {
  apiKeyInput.value = savedKey;
}

saveKeyBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    localStorage.setItem("anthropic_api_key", key);
    apiKeyInput.blur();
    saveKeyBtn.textContent = "Saved!";
    setTimeout(() => (saveKeyBtn.textContent = "Save"), 1500);
  }
});

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

  const results = searchIndex.search(query);
  const topResults = results.slice(0, TOP_K);

  return topResults.map((r) => ({
    id: r.ref,
    score: r.score,
    ...chunksMap[r.ref],
  })).filter((r) => r.content);
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

// Call Anthropic API
async function callClaude(userMessage, context) {
  const apiKey = HAS_BUILD_TIME_KEY
    ? BUILD_TIME_API_KEY
    : localStorage.getItem("anthropic_api_key");
  if (!apiKey) throw new Error("No Claude API key configured.");

  const response = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: buildSystemPrompt(context),
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

// Call Gemini API
async function callGemini(userMessage, context) {
  const geminiKey = HAS_GEMINI_KEY
    ? BUILD_TIME_GEMINI_KEY
    : localStorage.getItem("gemini_api_key");
  if (!geminiKey) throw new Error("No Gemini API key configured.");

  const response = await fetch(
    `${GEMINI_API_URL}/gemini-2.0-flash:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: buildSystemPrompt(context) }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
    }
  );

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.candidates[0].content.parts[0].text;
}

// Call Qwen API (DashScope, OpenAI-compatible)
async function callQwen(userMessage, context) {
  const qwenKey = HAS_QWEN_KEY
    ? BUILD_TIME_QWEN_KEY
    : localStorage.getItem("qwen_api_key");
  if (!qwenKey) throw new Error("No Qwen API key configured.");

  const response = await fetch(QWEN_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${qwenKey}`,
    },
    body: JSON.stringify({
      model: "qwen-plus",
      max_tokens: 1024,
      messages: [
        { role: "system", content: buildSystemPrompt(context) },
        { role: "user", content: userMessage },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

const MODEL_CALLERS = { claude: callClaude, gemini: callGemini, qwen: callQwen };
const MODEL_ORDER = ["claude", "gemini", "qwen"];

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
  let result = text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
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

  userInput.value = "";
  userInput.style.height = "auto";
  sendBtn.disabled = true;

  document.getElementById("app").classList.remove("landing");
  document.getElementById("chat-container").classList.remove("centered");
  messagesEl.innerHTML = "";
  addMessage("user", query);

  // Show thinking indicator with quotes fetched from API
  const thinkingDiv = addMessage("assistant", "Thinking...");
  const thinkingContent = thinkingDiv.querySelector(".message-content");
  thinkingContent.classList.add("thinking");

  async function fetchQuote() {
    try {
      const res = await fetch("https://api.quotable.io/quotes/random?limit=1");
      if (!res.ok) return null;
      const data = await res.json();
      return `${data[0].content} — ${data[0].author}`;
    } catch {
      return null;
    }
  }

  // Show first quote immediately
  fetchQuote().then((q) => { if (q) thinkingContent.textContent = q; });

  const phraseInterval = setInterval(async () => {
    const q = await fetchQuote();
    if (q) thinkingContent.textContent = q;
  }, 4000);

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

    // Try selected model first, then fall back through others
    const fallbackOrder = [selectedModel, ...MODEL_ORDER.filter((m) => m !== selectedModel)];
    let answer;
    let lastErr;
    for (const model of fallbackOrder) {
      try {
        answer = await MODEL_CALLERS[model](query, context);
        break;
      } catch (err) {
        console.warn(`${model} failed:`, err.message);
        lastErr = err;
        if (model === selectedModel) {
          thinkingDiv.querySelector(".message-content").textContent =
            "Trying backup";
        }
      }
    }

    clearInterval(phraseInterval);
    thinkingDiv.remove();
    if (answer) {
      addMessage("assistant", answer, chunks);
    } else {
      console.error("All providers failed:", lastErr?.message);
      addMessage("assistant", "Service is temporarily unavailable. Please check back later.");
    }
  } catch (err) {
    console.error("Unexpected error:", err.message);
    clearInterval(phraseInterval);
    thinkingDiv.remove();
    addMessage("assistant", "Service is temporarily unavailable. Please check back later.");
  }

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

// Auto-resize textarea
userInput.addEventListener("input", () => {
  userInput.style.height = "auto";
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + "px";
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

// Model selector
const modelBtns = document.querySelectorAll(".model-btn");
modelBtns.forEach((btn) => {
  if (btn.dataset.model === selectedModel) {
    btn.classList.add("active");
  } else {
    btn.classList.remove("active");
  }
  btn.addEventListener("click", () => {
    modelBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    selectedModel = btn.dataset.model;
    localStorage.setItem("selected_model", selectedModel);
  });
});

// Initialize
loadIndex();
