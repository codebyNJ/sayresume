const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get: k => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } };

// Versions live in the browser (localStorage); the server never stores your resume.
let hist = [], pos = -1, pdfB64 = null, pdfUrl = null;
const tex = () => hist[pos];

async function api(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({ error: `Server error ${r.status}` }));
  if (!r.ok || data.error) throw new Error(data.error || `Server error ${r.status}`);
  return data;
}

function save() {
  store.set("hist", JSON.stringify(hist.slice(-30)));
  $("saved").textContent = "· saved in this browser";
}

function showPdf(b64) {
  pdfB64 = b64;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: "application/pdf" }));
  $("pdf").src = pdfUrl + "#toolbar=0&navpanes=0&view=FitH";
  $("cstat").textContent = "· up to date";
}

async function recompile() {
  $("cstat").textContent = "· compiling…";
  const c = await api("/api/compile", { tex: tex() }).catch(e => ({ ok: false, log: e.message }));
  if (c.ok) showPdf(c.pdf); else $("cstat").textContent = "· LaTeX error: " + c.log.split("\n")[0];
}

// Put a new version on the stack; highlight the first changed spot in the source.
function commit(next, pdf, focusText) {
  hist = hist.slice(0, pos + 1).concat([next]); pos = hist.length - 1;
  $("src").value = next; save();
  if (focusText) {
    const i = next.indexOf(focusText);
    if (i >= 0) { $("src").focus(); $("src").setSelectionRange(i, i + focusText.length); $("src").blur(); scrollSrcTo(i); }
    $("src").classList.remove("flash"); void $("src").offsetWidth; $("src").classList.add("flash");
  }
  pdf ? showPdf(pdf) : recompile();
}
function scrollSrcTo(i) {
  const line = $("src").value.slice(0, i).split("\n").length;
  $("src").scrollTop = Math.max(0, (line - 6) * 18.75);
}
function go(to) { if (to < 0 || to >= hist.length) return false; pos = to; $("src").value = tex(); save(); recompile(); return true; }

function say(cls, html) { const e = document.createElement("div"); e.className = "m " + cls; e.innerHTML = html; $("log").append(e); $("log").scrollTop = 1e9; return e; }
const diff = blocks => `<div class="diff">${blocks.map(b =>
  b.search.split("\n").map(l => `<div class="d">- ${esc(l.trim())}</div>`).join("") +
  b.replace.split("\n").filter(l => l.trim()).map(l => `<div class="a">+ ${esc(l.trim())}</div>`).join("")).join("<br>")}</div>`;

let busy = false;
async function run(text) {
  text = text.trim();
  if (!text || busy) return;
  $("cmd").value = "";
  // Short spoken controls ("actually undo that", "go back", "download the pdf") never need the model.
  const c = text.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const short = c.split(" ").length <= 6;
  if (short && /\b(undo|revert that|take that back)\b/.test(c)) { say("you", esc(text)); return say("", go(pos - 1) ? "Undone." : "Nothing to undo."); }
  if (short && /\bredo\b/.test(c)) { say("you", esc(text)); return say("", go(pos + 1) ? "Redone." : "Nothing to redo."); }
  if (short && /\b(download|export)\b/.test(c)) { say("you", esc(text)); return download(/\b(tex|latex|source)\b/.test(c) ? "tex" : "pdf"); }
  busy = true; $("cmd").disabled = true;
  say("you", esc(text));
  const reply = say("", "Thinking… (local model)");
  const t0 = performance.now();
  try {
    const r = await api("/api/edit", { tex: tex(), cmd: text });
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.message) reply.innerHTML = `🤔 ${esc(r.message)}`;
    else {
      const focus = r.blocks.at(-1)?.replace.trim().split("\n")[0].trim() || (r.moves[0] && `{${r.moves[0].section}`) || null;
      commit(r.tex, r.pdf, focus);
      const moves = r.moves.map(m => `<div class="a">↕ moved ${esc(m.section)} ${m.where.toLowerCase()} ${esc(m.target)}</div>`).join("");
      reply.innerHTML = `Done in ${secs}s${r.tries > 1 ? ` <small>(self-corrected, ${r.tries} tries)</small>` : ""}${diff(r.blocks)}${moves && `<div class="diff">${moves}</div>`}`;
    }
  } catch (e) { reply.className = "m err"; reply.textContent = e.message; }
  busy = false; $("cmd").disabled = false; $("cmd").focus();
}

// Dictation tools (Wispr, macOS Dictation…) and paste insert many characters at once -> send after a short pause.
// Plain typing (1 char per event) waits for Enter.
let timer, dictated = false;
$("cmd").addEventListener("input", e => {
  clearTimeout(timer);
  if (e.inputType === "insertFromPaste" || e.inputType === "insertReplacementText" || (e.data || "").length > 2) dictated = true;
  if (dictated) timer = setTimeout(() => { dictated = false; run($("cmd").value); }, 1200);
});
$("cmd").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); clearTimeout(timer); dictated = false; run($("cmd").value); } });

// Manual edits to the source also become versions (debounced).
let srcTimer;
$("src").addEventListener("input", () => {
  clearTimeout(srcTimer); $("cstat").textContent = "· editing…";
  srcTimer = setTimeout(() => { if ($("src").value !== tex()) commit($("src").value); }, 900);
});

function download(kind) {
  const name = "resume." + kind;
  const blob = kind === "tex" ? new Blob([tex()], { type: "text/plain" }) : pdfB64 && new Blob([Uint8Array.from(atob(pdfB64), c => c.charCodeAt(0))], { type: "application/pdf" });
  if (!blob) return say("err", "No PDF yet.");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  say("", `Downloaded ${name}.`);
}

$("file").addEventListener("change", async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  if (f.name.toLowerCase().endsWith(".tex")) { commit(await f.text()); return say("", `Loaded ${esc(f.name)}.`); }
  const w = say("", `Reading ${esc(f.name)} and converting to LaTeX with the local model… (can take a minute)`);
  try {
    const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result.split(",")[1]); r.onerror = no; r.readAsDataURL(f); });
    const r = await api("/api/import", { name: f.name, data });
    commit(r.tex, r.pdf); w.textContent = `Imported ${f.name}. Now say what to fix.`;
  } catch (err) { w.className = "m err"; w.textContent = err.message; }
});

$("undo").onclick = () => go(pos - 1); $("redo").onclick = () => go(pos + 1);
$("dlTex").onclick = () => download("tex"); $("dlPdf").onclick = () => download("pdf");
$("reset").onclick = async () => commit(await (await fetch("/sample.tex")).text());

for (const c of ["Make my Acme bullets sound stronger", "Add a bullet under Acme: cut page load time by 40%", "Move skills above experience", "Shorten my summary to one line", "Remove the projects section", "Undo"]) {
  const b = document.createElement("button"); b.textContent = c; b.onclick = () => run(c); $("chips").append(b);
}

async function health() {
  const h = await fetch("/api/health").then(r => r.json()).catch(() => ({}));
  $("status").className = "pill " + (h.loaded ? "ok" : "bad");
  $("status").textContent = h.loaded ? `local model: ${h.model}` : h.up ? `model ${h.model} not in oMLX` : "oMLX not running";
}

try { hist = JSON.parse(store.get("hist")) || []; } catch {}
if (!hist.length) hist = [await (await fetch("/sample.tex")).text()];
pos = hist.length - 1; $("src").value = tex();
recompile(); health(); setInterval(health, 15000);
