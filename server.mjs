// Local server: static UI + the same API handlers that run on Vercel.
// Binds to 127.0.0.1 only. In Local mode nothing leaves this machine.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { handle } from "./lib/engine.mjs";

const PORT = Number(process.env.PORT || 3000);
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".tex": "text/plain", ".png": "image/png" };

http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    const m = path.match(/^\/api\/(edit|import|compile|health)$/);
    if (m) {
      const chunks = []; let size = 0;
      for await (const c of req) { if ((size += c.length) > 5e6) { res.writeHead(413).end(); return; } chunks.push(c); }
      const r = await handle(m[1], new Request("http://localhost" + req.url, {
        method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      }));
      res.writeHead(r.status, { "content-type": "application/json" }).end(await r.text());
      return;
    }
    const file = join("public", normalize(path === "/" ? "/index.html" : path));
    if (file.includes("..")) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch (e) {
    if (res.headersSent) return;
    e.code === "ENOENT" ? res.writeHead(404).end("Not found") : res.writeHead(500).end(e.message);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`SayResume on http://localhost:${PORT}`));
