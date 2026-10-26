// SayResume engine, shared by the local server (server.mjs) and the Vercel functions (api/*.mjs).
// Two model backends behind one interface: "local" (oMLX on this machine) and "cloud" (OpenRouter).
import { readFile, writeFile, mkdtemp, rm, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import tls from "node:tls";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseBlocks, parseMoves, applyEdits, moveSection, extractLatex, noChange, newDuplicateSection, lostSection, droppedWords, isAddOnly, notAdded, clonedBullets, inventedWords } from "./edits.mjs";

const run = promisify(execFile);
const env = process.env;
const ON_VERCEL = !!env.VERCEL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ponytail: keyword heuristic for "the user meant to drop/rename a section"; good enough for spoken commands
const ASKED_TO_DROP = /remov|delet|drop|get rid|cut|take out|merge|combine|renam|replac|call it|change .* to|instead/i;

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

const IMPORT_PROMPT = `Convert the resume text into a complete LaTeX document that uses the SKELETON below: keep its preamble and commands exactly, and replace every ALL-CAPS placeholder with content from the resume text.
Rules:
- Use ONLY what is written in the resume text. Never invent or guess anything, including a job's location, a headline or a summary.
- If the resume has no value for a placeholder, delete that whole line or element (for example the location line, the headline, or the dates). A city in the contact line is where the person lives, not where a job was; leave the job's LOCATION out unless the resume states it next to that job.
- Keep the resume's own capitalisation; do not convert text to upper case.
- Repeat the \\textbf/\\begin{itemize} entry block once per job, project or degree; repeat \\section* once per section, keeping the person's section names, wording and order.
- A section that is only text (such as Skills) has no entries: put its text straight under the \\section*.
- Escape % & $ # _ in text. Reply with ONLY the LaTeX document, from \\documentclass to \\end{document}.`;

// Placeholder skeleton built from the sample's preamble, so no real person's content can leak into an import.
const PLACEHOLDERS = ["FULL NAME", "HEADLINE", "CONTACT DETAILS", "SECTION TITLE", "ROLE, ORGANISATION", "DATES", "LOCATION", "BULLET", "PLAIN TEXT"];
const skeleton = sample => sample.slice(0, sample.indexOf("\\begin{document}")) + `\\begin{document}

\\begin{center}
  {\\LARGE\\bfseries FULL NAME} \\\\[2pt]
  HEADLINE \\\\[2pt]
  \\small CONTACT DETAILS (separated by \\;|\\;)
\\end{center}

\\section*{SECTION TITLE}
\\textbf{ROLE, ORGANISATION} \\hfill DATES \\\\
\\textit{LOCATION}
\\begin{itemize}
  \\item BULLET
\\end{itemize}

\\section*{SECTION TITLE}
PLAIN TEXT

\\end{document}
`;

export class Http extends Error { constructor(status, message) { super(message); this.status = status; } }

// ---------- backends ----------
// Free OpenRouter models come and go; override with CLOUD_MODELS="a:free,b:free".
const CLOUD_MODELS = "nvidia/nemotron-3.5-lightning:free,dots-studio/dots-3-note-preview:free,nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free";

function backend(name) {
  if (name === "local") {
    if (ON_VERCEL) throw new Http(503, "Local mode only works when SayResume runs on your own computer. Use Cloud here.");
    return { url: env.LLM_URL || "http://127.0.0.1:8002/v1/chat/completions", models: [env.LLM_MODEL || "Qwen3.5-9B-4bit"], key: env.LLM_API_KEY, local: true };
  }
  if (name === "cloud") {
    if (!env.OPENROUTER_API_KEY) throw new Http(503, "Cloud mode isn't configured: the server has no OPENROUTER_API_KEY.");
    return { url: env.CLOUD_URL || "https://openrouter.ai/api/v1/chat/completions", models: (env.CLOUD_MODELS || CLOUD_MODELS).split(",").map(s => s.trim()).filter(Boolean), key: env.OPENROUTER_API_KEY };
  }
  throw new Http(400, "Unknown model backend.");
}

let omlxKey;
async function localKey(b) {
  if (b.key) return b.key;
  omlxKey ??= await readFile(join(homedir(), ".omlx/settings.json"), "utf8").then(s => JSON.parse(s).auth?.api_key || "", () => "");
  return omlxKey;
}

// A whole request must finish inside the Vercel function limit (120 s), so cloud calls share one deadline.
const BUDGET_MS = ON_VERCEL ? 100_000 : 300_000;
const PER_MODEL_MS = Number(env.CLOUD_TIMEOUT_MS) || 40_000;

async function chat(name, messages, t0 = Date.now()) {
  const b = backend(name), key = b.local ? await localKey(b) : b.key;
  let last;
  for (const model of b.models) {          // cloud: fall through the list when a free model is busy or slow
    const left = BUDGET_MS - (Date.now() - t0);
    if (!b.local && left < 8_000) throw new Http(504, `The free cloud models are slow right now${last ? ` (${last})` : ""}. Try again, or switch to Local.`);
    let r, text;
    try {
      r = await fetch(b.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key && { authorization: "Bearer " + key }), "x-title": "SayResume" },
        // reasoning off: free "thinking" models otherwise spend 30+ s deliberating over a small edit
        body: JSON.stringify({ model, temperature: 0, max_tokens: 4096, messages, ...(b.local ? { chat_template_kwargs: { enable_thinking: false } } : { reasoning: { enabled: false } }) }),
        signal: AbortSignal.timeout(b.local ? 180_000 : Math.min(PER_MODEL_MS, left)),
      });
      text = await r.text();
    } catch (e) {
      if (b.local) throw new Http(503, `Local model not reachable (${e.message}). Is oMLX running? Try: omlx start`);
      last = `${model.split("/").pop()}: ${e.name === "TimeoutError" ? "timed out" : e.message}`; continue;
    }
    let data; try { data = JSON.parse(text); } catch {}
    const content = data?.choices?.[0]?.message?.content;
    if (r.ok && content) return content;
    const msg = data?.error?.message || text;
    if (/free-models-per-day|daily/i.test(msg) && r.status === 429) throw new Http(429, "The server's daily free-model limit is used up. Switch to Local, or try again tomorrow.");
    last = `${model}: ${r.status} ${String(msg).slice(0, 120)}`;
    if (r.status === 401 || r.status === 402 || r.status === 400) break;   // bad key / bad request: other models won't help
  }
  throw new Http(502, `Model unavailable (${last}). Try again in a moment.`);
}

async function probeLocal() {
  if (ON_VERCEL) return { available: false, reason: "Needs SayResume running on your own computer (a cloud server can't reach it)." };
  const b = backend("local");
  try {
    const key = await localKey(b);
    const r = await fetch(b.url.replace(/chat\/completions$/, "models"), { headers: key ? { authorization: "Bearer " + key } : {}, signal: AbortSignal.timeout(2500) });
    const ids = r.ok ? (await r.json()).data.map(m => m.id) : [];
    if (!r.ok) return { available: false, reason: `oMLX answered ${r.status}. Check its API key.` };
    return ids.includes(b.models[0]) ? { available: true, model: b.models[0] } : { available: false, reason: `Model ${b.models[0]} isn't installed in oMLX.` };
  } catch { return { available: false, reason: "oMLX isn't running. Start it with: omlx start" }; }
}

export async function health() {
  return {
    onVercel: ON_VERCEL,
    local: await probeLocal(),
    cloud: env.OPENROUTER_API_KEY ? { available: true, model: backend("cloud").models[0] } : { available: false, reason: "The server has no OPENROUTER_API_KEY." },
  };
}

// ---------- LaTeX compile ----------
let tectonic;
async function tectonicCmd() {
  if (!ON_VERCEL) return { bin: "tectonic", env };
  // Vercel: the binary and a pre-filled package cache are produced at build time (scripts/prepare-tectonic.mjs).
  // The deployment is read-only, so work from a writable copy of the cache in /tmp.
  // tectonic panics without system CA certs, so give it Node's own root certificates.
  tectonic ??= Promise.all([
    cp(join(ROOT, "bin/cache"), "/tmp/tectonic-cache", { recursive: true }).catch(() => {}),
    writeFile("/tmp/ca.pem", tls.rootCertificates.join("\n")),
  ]);
  await tectonic;
  return { bin: join(ROOT, "bin/tectonic"), env: { ...env, HOME: "/tmp", TECTONIC_CACHE_DIR: "/tmp/tectonic-cache", SSL_CERT_FILE: "/tmp/ca.pem" } };
}

async function compileOnce(tex) {
  const dir = await mkdtemp(join(tmpdir(), "sayresume-"));
  try {
    await writeFile(join(dir, "main.tex"), tex);
    const t = await tectonicCmd();
    await run(t.bin, ["--chatter", "minimal", "main.tex"], { cwd: dir, env: t.env, timeout: 100_000 });
    return { ok: true, pdf: (await readFile(join(dir, "main.pdf"))).toString("base64") };
  } catch (e) {
    const log = String(e.stderr || e.message).split("\n").filter(l => /error|!|Undefined|Missing/i.test(l) && !/fontconfig/i.test(l)).slice(0, 8).join("\n");
    return { ok: false, log: log || String(e.stderr || e.message).slice(-600) };
  } finally { rm(dir, { recursive: true, force: true }); }
}
// ponytail: one compile at a time per instance keeps the shared package cache safe; add a pool if throughput matters
let queue = Promise.resolve();
export const compile = tex => (queue = queue.then(() => compileOnce(tex), () => compileOnce(tex)));

// ---------- edit / import ----------
// Ask -> apply -> guard -> compile. On any failure, show the model what went wrong and retry (3 tries).
export async function edit(name, tex, cmd) {
  const msgs = [{ role: "system", content: EDIT_PROMPT }, { role: "user", content: `FILE:\n${tex}\n\nCOMMAND: ${cmd}` }];
  const t0 = Date.now();
  let err;
  for (let i = 0; i < 3; i++) {
    const out = await chat(name, msgs, t0);
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
      const cloned = clonedBullets(tex, next);
      if (cloned.length) throw new Error(`Your edit copies existing bullets (${cloned[0].slice(0, 50)}...). Never duplicate existing entries to make a new one. Add only what the user said; if details such as title, dates or bullets are missing, reply NOCHANGE: <question>.`);
      if (isAddOnly(cmd) && !ASKED_TO_DROP.test(cmd)) {
        const gone = droppedWords(tex, next);
        const made = inventedWords(cmd, tex, next);
        if (made.length) throw new Error(`Your edit contains wording that is in neither the resume nor the user's command (${made.slice(0, 5).join(", ")}). That is invented. Use only the user's own words; if details such as title, dates or duties are missing, reply NOCHANGE: <question>.`);
        const missing = notAdded(cmd, tex, next);
        if (missing.length) throw new Error(`Your edit doesn't add what the user mentioned (${missing.slice(0, 4).join(", ")}). Add it, or if you lack details (job title, dates...) reply NOCHANGE: <question>.`);
        if (gone.length) throw new Error(`The user only asked to ADD something, but your edit removed existing wording (${gone.slice(0, 4).join(", ")}). Keep all existing content and add the new content next to it. If you lack details to add it (job title, dates...), reply NOCHANGE: <question>.`);
      }
      const c = await compile(next);
      if (!c.ok) throw new Error("The edited LaTeX failed to compile:\n" + c.log);
      return { tex: next, blocks, moves, pdf: c.pdf, tries: i + 1 };
    } catch (e) { err = e.message; }
    msgs.push({ role: "assistant", content: out }, { role: "user", content: `That didn't work: ${err}\nReply with corrected SEARCH/REPLACE blocks against the ORIGINAL file.` });
  }
  throw new Http(422, `Couldn't make that edit (${err.split("\n")[0]}). Try rephrasing.`);
}

export async function importResume(name, text) {
  text = text.trim();
  if (text.length < 50) throw new Http(400, "Couldn't find enough text in that file (a scanned PDF?). Try a DOCX or .txt.");
  const style = skeleton(await readFile(join(ROOT, "public/sample.tex"), "utf8"));
  const msgs = [{ role: "system", content: IMPORT_PROMPT }, { role: "user", content: `SKELETON:\n${style}\n\nRESUME TEXT:\n${text.slice(0, 12_000)}` }];
  const t0 = Date.now();
  let err;
  for (let i = 0; i < 3; i++) {
    const out = await chat(name, msgs, t0);
    try {
      const tex = extractLatex(out);
      const left = PLACEHOLDERS.find(p => tex.slice(tex.indexOf("\\begin{document}")).includes(p));
      if (left) throw new Error(`The placeholder "${left}" is still in the document. Fill it from the resume or delete that line.`);
      const dup = newDuplicateSection("", tex);
      if (dup) throw new Error(`The section "${dup}" appears more than once. Use one \\section* per heading and put all of its entries under it.`);
      const c = await compile(tex);
      if (!c.ok) throw new Error("It failed to compile:\n" + c.log);
      return { tex, pdf: c.pdf };
    } catch (e) { err = e.message; }
    msgs.push({ role: "assistant", content: out }, { role: "user", content: `${err}\nReply with the corrected full LaTeX document only.` });
  }
  throw new Http(422, `Import failed (${err.split("\n")[0]}).`);
}

// ---------- HTTP layer (Web Request -> Response) ----------
const json = (obj, status = 200) => Response.json(obj, { status });
// ponytail: per-instance limiter, resets on cold start; use Vercel KV / Upstash if the public demo gets abused
const hits = new Map();
function limited(key, max) {
  const now = Date.now(), h = (hits.get(key) || []).filter(t => now - t < 60_000);
  h.push(now); hits.set(key, h);
  if (hits.size > 5000) hits.clear();
  return h.length > max;
}

export async function handle(route, req) {
  try {
    if (route === "health") return json(await health());
    if (req.method !== "POST") throw new Http(405, "POST only.");
    if (ON_VERCEL && limited(route + (req.headers.get("x-forwarded-for") || "").split(",")[0], route === "compile" ? 40 : 15))
      throw new Http(429, "Too many requests. Wait a minute.");
    let b; try { b = await req.json(); } catch { throw new Http(400, "Bad request."); }
    const tex = String(b.tex ?? "");
    if (tex.length > 200_000) throw new Http(413, "Resume is too large.");
    if (route === "compile") return json(await compile(tex));
    if (route === "edit") {
      const cmd = String(b.cmd ?? "").trim().slice(0, 1000);
      if (!cmd) throw new Http(400, "Say a command first.");
      if (!tex.trim()) throw new Http(400, "No resume loaded.");
      return json(await edit(b.backend, tex, cmd));
    }
    if (route === "import") return json(await importResume(b.backend, String(b.text ?? "")));
    throw new Http(404, "Unknown endpoint.");
  } catch (e) {
    return json({ error: e.status ? e.message : "Server error: " + e.message }, e.status || 500);
  }
}
