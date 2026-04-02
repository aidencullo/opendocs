const fs = require("fs");
const path = require("path");
const lunr = require("lunr");

const DOCS_DIR = path.resolve(__dirname, "../openclaw/docs");
const OUTPUT_INDEX = path.resolve(__dirname, "docs-index.json");
const OUTPUT_CHUNKS = path.resolve(__dirname, "docs-chunks.json");
const CHUNK_SIZE = 800; // chars per chunk
const CHUNK_OVERLAP = 100;

function getAllMarkdownFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip i18n, assets, images, generated
      if (
        [".i18n", "assets", "images", ".generated", "zh-CN", "ja-JP"].includes(
          entry.name
        )
      )
        continue;
      results.push(...getAllMarkdownFiles(fullPath));
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

function stripFrontmatter(content) {
  if (content.startsWith("---")) {
    const end = content.indexOf("---", 3);
    if (end !== -1) {
      return content.slice(end + 3).trim();
    }
  }
  return content;
}

function chunkText(text, chunkSize, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
    if (end === text.length) break;
  }
  return chunks;
}

function processDoc(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const content = stripFrontmatter(raw);
  const title = extractTitle(content) || path.basename(filePath, ".md");
  const relPath = path.relative(DOCS_DIR, filePath);

  // Clean content: remove HTML tags, excessive whitespace
  const cleaned = content
    .replace(/<[^>]+>/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/```[\s\S]*?```/g, "[code block]")
    .trim();

  const textChunks = chunkText(cleaned, CHUNK_SIZE, CHUNK_OVERLAP);

  return textChunks.map((chunk, i) => ({
    id: `${relPath}#${i}`,
    title,
    path: relPath,
    content: chunk,
    section: i,
  }));
}

console.log("Scanning docs directory:", DOCS_DIR);
const files = getAllMarkdownFiles(DOCS_DIR);
console.log(`Found ${files.length} markdown files`);

const allChunks = [];
for (const file of files) {
  try {
    const chunks = processDoc(file);
    allChunks.push(...chunks);
  } catch (err) {
    console.warn(`Skipping ${file}: ${err.message}`);
  }
}

console.log(`Created ${allChunks.length} chunks`);

// Build lunr index
console.log("Building search index...");
const idx = lunr(function () {
  this.ref("id");
  this.field("title", { boost: 10 });
  this.field("content");
  this.field("path", { boost: 2 });

  for (const chunk of allChunks) {
    this.add(chunk);
  }
});

// Save serialized index
fs.writeFileSync(OUTPUT_INDEX, JSON.stringify(idx));
console.log(`Index written to ${OUTPUT_INDEX} (${(fs.statSync(OUTPUT_INDEX).size / 1024 / 1024).toFixed(1)} MB)`);

// Save chunks for retrieval
const chunksMap = {};
for (const chunk of allChunks) {
  chunksMap[chunk.id] = {
    title: chunk.title,
    path: chunk.path,
    content: chunk.content,
  };
}
fs.writeFileSync(OUTPUT_CHUNKS, JSON.stringify(chunksMap));
console.log(`Chunks written to ${OUTPUT_CHUNKS} (${(fs.statSync(OUTPUT_CHUNKS).size / 1024 / 1024).toFixed(1)} MB)`);
