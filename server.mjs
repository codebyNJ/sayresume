// SayResume local server: static UI + LaTeX compile (tectonic) + local LLM edits (oMLX).
// Binds to 127.0.0.1 only; nothing leaves this machine.
import http from "node:http";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, normalize, extname } from "node:path";
import { promisify } from "node:util";
import { parseBlocks, parseMoves, applyEdits, moveSection, extractLatex, noChange, newDuplicateSection, lostSection } from "./edits.mjs";

// ponytail: keyword heuristic for "the user meant to drop/rename a section"; good enough for spoken commands
const ASKED_TO_DROP = /remov|delet|drop|get rid|cut|take out|merge|combine|renam|replac|call it|change .* to|instead/i;

const run = promisify(execFile);
const PORT = Number(process.env.PORT || 3000);
const LLM_URL = process.env.LLM_URL || "http://127.0.0.1:8002/v1/chat/completions";
const MODEL = process.env.LLM_MODEL || "Qwen3.5-9B-4bit";
let KEY = process.env.LLM_API_KEY;
if (!KEY) try { KEY = JSON.parse(await readFile(join(homedir(), ".omlx/settings.json"), "utf8")).auth?.api_key; } catch {}

const EDIT_PROMPT = `You edit a LaTeX resume. The user gives spoken commands (dictated, so expect filler words and loose references like "that job" or "the second bullet").
Reply ONLY with one or more SEARCH/REPLACE blocks, nothing else:
<<<<<<< SEARCH
exact lines copied from the current file
=======
the new lines
>>>>>>> REPLACE
Rules:
- SEARCH must copy existing lines exactly and match only one place; include a neighbouring line if needed. Keep blocks small.
- To add something, SEARCH an anchor line and REPLACE with the anchor plus the new lines. To delete, leave REPLACE empty.
- To move a whole section, do NOT use SEARCH/REPLACE. Write one line per move instead:
MOVE: <section title> BEFORE <section title>      (or AFTER)
- Keep the LaTeX valid. In normal text escape % & $ # _ as \\% \\& \\$ \\# \\_ (e.g. 40\\%).
- Only change what was asked. Never invent employers, dates, degrees, metrics or skills; use only facts in the file or the command.
- Write numbers as digits. Rewritten bullets: concise, start with a strong verb.
- "Shorten" means remove words while keeping the meaning; do not swap in other content.
- If the command is unclear, reply exactly: NOCHANGE: <one short question>`;

const IMPORT_PROMPT = `Convert the resume text into a complete LaTeX document that follows the STYLE TEMPLATE exactly (same preamble, same commands, same layout).
Keep the person's original wording, sections and order. Do not invent anything; drop template content that has no counterpart.
Escape % & $ # _ in text. Reply with ONLY the LaTeX document, from \\documentclass to \\end{document}.`;

async function chat(messages) {
  const r = await fetch(LLM_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(KEY && { authorization: "Bearer " + KEY }) },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 4096, messages, chat_template_kwargs: { enable_thinking: false } }),
    signal: AbortSignal.timeout(180_000),
  }).catch(e => { throw new Error(`Local model not reachable at ${LLM_URL} (${e.message}). Is oMLX running?`); });
  const text = await r.text();
  if (!r.ok) throw new Error(`Local model error ${r.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).choices[0].message.content ?? "";
}

// ponytail: one compile at a time is plenty for a single local user
async function compile(tex) {
  const dir = await mkdtemp(join(tmpdir(), "sayresume-"));
  try {
    await writeFile(join(dir, "main.tex"), tex);
    await run("tectonic", ["--chatter", "minimal", "main.tex"], { cwd: dir, timeout: 120_000 });
    return { ok: true, pdf: (await readFile(join(dir, "main.pdf"))).toString("base64") };
  } catch (e) {
    const log = String(e.stderr || e.message).split("\n").filter(l => /error|!|Undefined|Missing/i.test(l)).slice(0, 8).join("\n");
    return { ok: false, log: log || String(e.stderr || e.message).slice(-600) };
  } finally { rm(dir, { recursive: true, force: true }); }
}

// Ask -> apply -> compile. On any failure, show the model what went wrong and retry (3 tries).
async function edit(tex, cmd) {
  const msgs = [{ role: "system", content: EDIT_PROMPT }, { role: "user", content: `FILE:\n${tex}\n\nCOMMAND: ${cmd}` }];
  let err;
  for (let i = 0; i < 3; i++) {
    const out = await chat(msgs);
    const q = noChange(out);
    if (q) return { tex, message: q };
    try {
      const blocks = parseBlocks(out), moves = parseMoves(out);
      if (!blocks.length && !moves.length) throw new Error("No SEARCH/REPLACE blocks or MOVE lines found in your reply.");
      const next = moves.reduce(moveSection, applyEdits(tex, blocks)); // text edits target the original, so they go first
      const dup = newDuplicateSection(tex, next);
      if (dup) throw new Error(`Section "${dup}" now appears twice. To move a section use a MOVE line instead.`);
      const lost = lostSection(tex, next);
      if (lost && !ASKED_TO_DROP.test(cmd)) throw new Error(`Section "${lost}" disappeared but the user did not ask to remove or rename it. To move a section use a MOVE line.`);
      const c = await compile(next);
      if (!c.ok) throw new Error("The edited LaTeX failed to compile:\n" + c.log);
      return { tex: next, blocks, moves, pdf: c.pdf, tries: i + 1 };
    } catch (e) { err = e.message; }
    msgs.push({ role: "assistant", content: out }, { role: "user", content: `That didn't work: ${err}\nReply with corrected SEARCH/REPLACE blocks against the ORIGINAL file.` });
  }
  throw new Error(`Couldn't make that edit (${err.split("\n")[0]}). Try rephrasing.`);
}

async function extractText(name, b64) {
  const ext = extname(name).toLowerCase(), buf = Buffer.from(b64, "base64");
  if ([".txt", ".md"].includes(ext)) return buf.toString("utf8");
  const dir = await mkdtemp(join(tmpdir(), "sayresume-"));
  try {
    const f = join(dir, "in" + ext);
    await writeFile(f, buf);
    if (ext === ".pdf") return (await run("pdftotext", ["-layout", f, "-"])).stdout;
    if ([".docx", ".doc", ".rtf", ".odt", ".html"].includes(ext)) return (await run("textutil", ["-convert", "txt", "-stdout", f])).stdout;
    throw new Error("Upload a .tex, .pdf, .docx, .rtf or .txt file.");
  } finally { rm(dir, { recursive: true, force: true }); }
}

async function importResume(name, b64) {
  const text = (await extractText(name, b64)).trim();
  if (text.length < 50) throw new Error("Couldn't read text from that file (scanned PDF?). Try a .docx or .txt.");
  const style = await readFile("public/sample.tex", "utf8");
  const msgs = [{ role: "system", content: IMPORT_PROMPT }, { role: "user", content: `STYLE TEMPLATE:\n${style}\n\nRESUME TEXT:\n${text.slice(0, 12_000)}` }];
  let err;
  for (let i = 0; i < 3; i++) {
    const out = await chat(msgs);
    try {
      const tex = extractLatex(out), c = await compile(tex);
      if (!c.ok) throw new Error("It failed to compile:\n" + c.log);
      return { tex, pdf: c.pdf };
    } catch (e) { err = e.message; }
    msgs.push({ role: "assistant", content: out }, { role: "user", content: `${err}\nReply with the corrected full LaTeX document only.` });
  }
  throw new Error(`Import failed (${err.split("\n")[0]}).`);
}

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".tex": "text/plain" };
const send = (res, status, obj) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(obj));

http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    if (req.method === "POST" && path.startsWith("/api/")) {
      const chunks = []; let size = 0;
      for await (const c of req) { if ((size += c.length) > 20e6) return send(res, 413, { error: "File too large." }); chunks.push(c); }
      const b = JSON.parse(Buffer.concat(chunks));
      if (path === "/api/compile") return send(res, 200, await compile(String(b.tex)));
      if (path === "/api/edit") {
        if (!String(b.cmd || "").trim()) return send(res, 400, { error: "Say a command first." });
        return send(res, 200, await edit(String(b.tex), String(b.cmd).slice(0, 1000)));
      }
      if (path === "/api/import") return send(res, 200, await importResume(String(b.name), String(b.data)));
      return send(res, 404, { error: "Unknown endpoint" });
    }
    if (path === "/api/health") {
      const r = await fetch(LLM_URL.replace(/chat\/completions$/, "models"), { headers: KEY ? { authorization: "Bearer " + KEY } : {}, signal: AbortSignal.timeout(3000) }).catch(() => null);
      const ids = r?.ok ? (await r.json()).data.map(m => m.id) : [];
      return send(res, 200, { model: MODEL, up: !!r?.ok, loaded: ids.includes(MODEL), available: ids });
    }
    const file = join("public", normalize(path === "/" ? "/index.html" : path));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch (e) {
    if (res.headersSent) return;
    e.code === "ENOENT" ? res.writeHead(404).end("Not found") : send(res, 500, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`SayResume on http://localhost:${PORT}  (model: ${MODEL} via ${LLM_URL})`));
