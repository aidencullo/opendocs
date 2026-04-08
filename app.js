let searchIndex = null;
let chunksMap = null;
let isReady = false;

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const TOP_K = 8;

// Injected at deploy time by the GitHub Actions workflow.
// Left as the placeholder string locally so nothing secret is committed.
const BUILD_TIME_API_KEY = "__ANTHROPIC_API_KEY__";
const HAS_BUILD_TIME_KEY =
  BUILD_TIME_API_KEY && !BUILD_TIME_API_KEY.startsWith("__");

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

// Call Anthropic API
async function callClaude(userMessage, context) {
  const apiKey = HAS_BUILD_TIME_KEY
    ? BUILD_TIME_API_KEY
    : localStorage.getItem("anthropic_api_key");
  if (!apiKey) {
    throw new Error("Please enter your Anthropic API key first.");
  }

  const systemPrompt = `You are Open Docs, a helper bot whose job is to make setting up OpenClaw (a self-hosted AI gateway that connects messaging apps to AI agents) less annoying.

Answer based ONLY on the provided documentation context. If the context doesn't contain enough information to answer, say so honestly.

Keep answers concise and practical. Prefer step-by-step setup instructions when the user is trying to get something working. Use markdown formatting. When referencing docs, mention the source path.

Documentation context:
${context}`;

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
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err.error?.message || `API error: ${response.status}`
    );
  }

  const data = await response.json();
  return data.content[0].text;
}

// Simple markdown rendering
function renderMarkdown(text) {
  return text
    // Code blocks
    .replace(/```(\w*)\n([\s\S]*?)```/g, "<pre><code>$2</code></pre>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // Line breaks to paragraphs
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// Add message to chat
function addMessage(role, content, sources = null) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  let html = `<div class="message-content">${renderMarkdown(content)}</div>`;

  if (sources && sources.length > 0) {
    const uniquePaths = [...new Set(sources.map((s) => s.path))].slice(0, 5);
    const linkIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M7 7h10v10"/></svg>`;
    const buttons = uniquePaths
      .map((p) => {
        const url = `https://docs.openclaw.ai/${p.replace(/\.md$/, "").replace(/\/index$/, "")}`;
        const label = p.replace(/\.md$/, "").replace(/\/index$/, "");
        return `<a href="${url}" target="_blank" rel="noopener">${label}${linkIcon}</a>`;
      })
      .join("");
    html += `<div class="sources"><span class="sources-label">Sources</span>${buttons}</div>`;
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

  addMessage("user", query);

  // Show thinking indicator
  const thinkingDiv = addMessage("assistant", "Searching docs and thinking...");
  thinkingDiv.querySelector(".message-content").classList.add("thinking");

  try {
    // Retrieve relevant chunks
    const chunks = retrieveContext(query);

    if (chunks.length === 0) {
      thinkingDiv.remove();
      addMessage(
        "assistant",
        "I couldn't find any relevant documentation for that query. Try rephrasing or asking about a specific OpenClaw feature."
      );
      sendBtn.disabled = false;
      return;
    }

    const context = buildContext(chunks);

    // Call Claude
    const answer = await callClaude(query, context);

    thinkingDiv.remove();
    addMessage("assistant", answer, chunks);
  } catch (err) {
    thinkingDiv.remove();
    addMessage("assistant", `Error: ${err.message}`);
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

// Initialize
loadIndex();
