// Engine tests: model calls are mocked, LaTeX compile is real (needs `tectonic`).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

process.env.OPENROUTER_API_KEY = "test-key";
process.env.CLOUD_TIMEOUT_MS = "300";
process.env.LLM_API_KEY = "local-test";
delete process.env.VERCEL;
const { handle, health, edit, importResume } = await import("./lib/engine.mjs");
const { extractText } = await import("./public/extract.js");

const tex = readFileSync("./public/sample.tex", "utf8");
const block = (s, r) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;
const call = (route, body, method = "POST") => handle(route, new Request("http://x/api/" + route, { method, body: method === "POST" ? JSON.stringify(body) : undefined }));
const reply = content => Response.json({ choices: [{ message: { content } }] });
const seen = [];
const mock = fn => { globalThis.fetch = async (url, init) => { const body = init?.body && JSON.parse(init.body); seen.push({ url: String(url), body }); return fn(String(url), body); }; };

// --- cloud edit goes to OpenRouter with the cloud key, compiles for real
mock(() => reply(block("  \\item Worked on the checkout page", "  \\item Rebuilt the checkout page")));
let r = await call("edit", { backend: "cloud", tex, cmd: "stronger" });
assert.equal(r.status, 200);
let d = await r.json();
assert.match(d.tex, /Rebuilt the checkout page/);
assert.ok(d.pdf.length > 5000, "got a real PDF");
assert.match(seen[0].url, /openrouter\.ai/);
assert.equal(seen[0].body.chat_template_kwargs, undefined);               // local-only parameter must not reach cloud

// --- cloud: busy first model -> falls to the next
seen.length = 0; let n = 0;
mock(() => ++n === 1 ? Response.json({ error: { message: "Provider returned error" } }, { status: 429 }) : reply(block("  \\item Helped with code reviews", "  \\item Reviewed code")));
r = await call("edit", { backend: "cloud", tex, cmd: "x" });
assert.equal(r.status, 200);
assert.notEqual(seen[0].body.model, seen[1].body.model);

// --- cloud: daily free limit -> stop at once with a clear message
seen.length = 0;
mock(() => Response.json({ error: { message: "Rate limit exceeded: free-models-per-day" } }, { status: 429 }));
r = await call("edit", { backend: "cloud", tex, cmd: "x" });
assert.equal(r.status, 429); assert.match((await r.json()).error, /daily free-model limit/); assert.equal(seen.length, 1);

// --- hung model / body that times out mid-read: clean error, not "Server error"; each model gets its own timeout
seen.length = 0;
globalThis.fetch = (url, init) => { seen.push(init.body); return new Promise((_, no) => init.signal.addEventListener("abort", () => no(init.signal.reason))); };
const keepAlive = setInterval(() => {}, 50);   // AbortSignal.timeout timers are unref'd; the real server's listener keeps node alive
let t = Date.now(); r = await call("edit", { backend: "cloud", tex, cmd: "x" });
clearInterval(keepAlive);
assert.equal(r.status, 502); assert.match((await r.json()).error, /timed out/); assert.equal(seen.length, 4); assert.ok(Date.now() - t < 4000);   // every default model got tried, each with its own timeout
globalThis.fetch = async () => ({ ok: true, status: 200, text: () => Promise.reject(Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" })) });
r = await call("edit", { backend: "cloud", tex, cmd: "x" });
assert.equal(r.status, 502); assert.doesNotMatch((await r.json()).error, /^Server error/);
assert.equal(JSON.parse(seen[0]).reasoning.enabled, false);                // cloud asks free models not to "think"

// --- bad key -> one attempt, no pointless retries
seen.length = 0;
mock(() => Response.json({ error: { message: "No auth" } }, { status: 401 }));
r = await call("edit", { backend: "cloud", tex, cmd: "x" });
assert.equal(r.status, 502); assert.equal(seen.length, 1);

// --- local backend: talks to oMLX with the local model and the no-thinking flag
seen.length = 0;
mock(() => reply(block("  \\item Worked on the checkout page", "  \\item Built the checkout page")));
r = await call("edit", { backend: "local", tex, cmd: "x" });
assert.equal(r.status, 200);
assert.match(seen[0].url, /127\.0\.0\.1:8002/); assert.equal(seen[0].body.model, "Qwen3.5-9B-4bit"); assert.equal(seen[0].body.chat_template_kwargs.enable_thinking, false);

// --- model asks a question instead of editing
mock(() => reply("NOCHANGE: Which job do you mean?"));
d = await (await call("edit", { backend: "cloud", tex, cmd: "add my job" })).json();
assert.equal(d.message, "Which job do you mean?"); assert.equal(d.pdf, undefined);

// --- self-correction: first reply doesn't match, second does; the error was shown to the model
seen.length = 0; n = 0;
mock(() => reply(++n === 1 ? block("\\item Nonexistent line", "x") : block("  \\item Worked on the checkout page", "  \\item Built checkout")));
d = await (await call("edit", { backend: "cloud", tex, cmd: "x" })).json();
assert.equal(d.tries, 2); assert.match(seen[1].body.messages.at(-1).content, /not found/);

// --- "add my job at Google": a model that overwrites the Acme job instead of adding is sent back; a question is accepted
seen.length = 0; n = 0;
mock(() => reply(++n === 1 ? block("\\textbf{Software Engineer, Acme Pay} \\hfill 2023 -- Present \\\\", "\\textbf{Software Engineer, Google} \\hfill 2023 -- Present \\\\") : "NOCHANGE: What was your title and dates at Google?"));
d = await (await call("edit", { backend: "cloud", tex, cmd: "Um, add my job at Google" })).json();
assert.match(d.message, /title and dates/); assert.match(seen[1].body.messages.at(-1).content, /only asked to ADD something.*acme/);
// ...and an irrelevant edit (a move) for "add my job at Google" is rejected, not applied
seen.length = 0; n = 0;
mock(() => reply(++n === 1 ? "MOVE: Experience BEFORE Education" : "NOCHANGE: Which role did you have at Google?"));
d = await (await call("edit", { backend: "cloud", tex, cmd: "Add my job at Google" })).json();
assert.match(d.message, /Which role/); assert.match(seen[1].body.messages.at(-1).content, /doesn't add what the user mentioned \(google\)/);
// ...and cloning the Acme entry as a fake Google job is sent back
seen.length = 0; n = 0;
const acmeBlock = tex.slice(tex.indexOf("\\textbf{Software Engineer, Acme Pay}"), tex.indexOf("\\section*{Projects}")).trim();
mock(() => reply(++n === 1 ? block(acmeBlock, acmeBlock + "\n\n" + acmeBlock.replace("Acme Pay", "Google")) : "NOCHANGE: Which role and dates at Google?"));
d = await (await call("edit", { backend: "cloud", tex, cmd: "Add my job at Google" })).json();
assert.match(d.message, /role and dates/); assert.match(seen[1].body.messages.at(-1).content, /copies existing bullets/);
// ...but the same overwrite is fine when the user asked to change it
n = 0; mock(() => reply(block("\\textbf{Software Engineer, Acme Pay} \\hfill 2023 -- Present \\\\", "\\textbf{Software Engineer, Google} \\hfill 2023 -- Present \\\\")));
d = await (await call("edit", { backend: "cloud", tex, cmd: "Change my employer to Google" })).json();
assert.match(d.tex, /Software Engineer, Google/);

// --- input validation
assert.equal((await call("edit", { backend: "cloud", tex, cmd: "  " })).status, 400);
assert.equal((await call("edit", { backend: "nope", tex, cmd: "x" })).status, 400);
assert.equal((await call("edit", { backend: "cloud", tex: "", cmd: "x" })).status, 400);
assert.equal((await call("edit", { backend: "cloud", tex: "x".repeat(200_001), cmd: "x" })).status, 413);
assert.equal((await call("edit", {}, "GET")).status, 405);
assert.equal((await call("import", { backend: "cloud", text: "too short" })).status, 400);

// --- compile endpoint
d = await (await call("compile", { tex })).json(); assert.ok(d.ok && d.pdf);
d = await (await call("compile", { tex: "\\documentclass{article}\\begin{document}\\undefined\\end{document}" })).json(); assert.equal(d.ok, false); assert.ok(d.log);

// --- import: the model gets a placeholder skeleton, never the sample person's content; unfilled placeholders are rejected and retried
seen.length = 0; n = 0;
const filled = tex.replace("Aarav Mehta", "Priya Sharma");
mock(() => reply(++n === 1 ? tex.replace("Aarav Mehta", "FULL NAME") : "```latex\n" + filled + "\n```"));
d = await importResume("cloud", readFileSync("./fixtures/resume.txt", "utf8"));
assert.match(d.tex, /Priya Sharma/); assert.ok(d.pdf);
const prompt = seen[0].body.messages.map(m => m.content).join("\n");
assert.match(prompt, /SKELETON/); assert.match(prompt, /ROLE, ORGANISATION/);
for (const leak of ["Aarav", "Acme", "Kirana", "VTU", "page load"]) assert.ok(!prompt.includes(leak), "sample content leaked into import prompt: " + leak);
assert.match(seen[1].body.messages.at(-1).content, /placeholder "FULL NAME"/);

// duplicate headings (one section split in two) are rejected and retried
seen.length = 0; n = 0;
const dupTex = filled.replace("\\section*{Education}", "\\section*{Experience}");
mock(() => reply(++n === 1 ? dupTex : filled));
d = await importResume("cloud", readFileSync("./fixtures/resume.txt", "utf8"));
assert.equal(seen.length, 2); assert.match(seen[1].body.messages.at(-1).content, /"experience" appears more than once/);

// --- health
mock(url => url.endsWith("/models") ? Response.json({ data: [{ id: "Qwen3.5-9B-4bit" }] }) : reply("x"));
let h = await (await call("health", null, "GET")).json();
assert.equal(h.local.available, true); assert.equal(h.cloud.available, true); assert.equal(h.onVercel, false);
mock(() => { throw new Error("ECONNREFUSED"); });
h = await health(); assert.equal(h.local.available, false); assert.match(h.local.reason, /omlx start/);

// --- on Vercel: local is refused, cloud still works, health says why
const out = execFileSync("node", ["--input-type=module", "-e", `
  const { handle } = await import("./lib/engine.mjs");
  const h = await (await handle("health", new Request("http://x"))).json();
  const r = await handle("edit", new Request("http://x", { method: "POST", body: JSON.stringify({ backend: "local", tex: "x", cmd: "x" }) }));
  console.log(JSON.stringify({ local: h.local, cloud: h.cloud, onVercel: h.onVercel, status: r.status, err: (await r.json()).error }));
`], { env: { ...process.env, VERCEL: "1", OPENROUTER_API_KEY: "k" } }).toString();
const v = JSON.parse(out);
assert.equal(v.onVercel, true); assert.equal(v.local.available, false); assert.equal(v.cloud.available, true);
assert.equal(v.status, 503); assert.match(v.err, /your own computer/);

// --- browser-side extraction (docx is a zip of XML; PDF.js path is covered in the browser test)
const docx = new File([readFileSync("./fixtures/resume.docx")], "resume.docx");
const text = await extractText(docx);
assert.match(text, /PRIYA SHARMA/); assert.match(text, /Power BI & Excel/); assert.match(text, /\n- Automated weekly reports/);
assert.equal(await extractText(new File(["hello resume"], "a.txt")), "hello resume");
await assert.rejects(() => extractText(new File(["x"], "a.png")), /Upload a/);
await assert.rejects(() => extractText(new File(["not a zip"], "a.docx")), /valid \.docx/);

console.log("engine ok");
