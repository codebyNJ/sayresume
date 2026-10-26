// Vercel build step: fetch the Linux tectonic binary and pre-fill its package cache,
// so the first compile in a cold function is fast. Skipped on macOS (the local server uses the installed tectonic).
import { mkdir, writeFile, readFile, chmod, rm, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import tls from "node:tls";

if (process.platform !== "linux") { console.log("prepare-tectonic: not Linux, skipping (using system tectonic)"); process.exit(0); }

const VERSION = "0.17.0";   // keep in step with the tectonic you test with locally
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}/tectonic-${VERSION}-${arch}-unknown-linux-musl.tar.gz`;
const bin = join(process.cwd(), "bin"), cache = join(bin, "cache"), tmp = join(bin, "tmp");

await rm(bin, { recursive: true, force: true });
await mkdir(cache, { recursive: true }); await mkdir(tmp, { recursive: true });

console.log("prepare-tectonic: downloading", url);
const r = await fetch(url, { redirect: "follow" });
if (!r.ok) throw new Error(`download failed: ${r.status}`);
await writeFile(join(tmp, "t.tar.gz"), Buffer.from(await r.arrayBuffer()));
execFileSync("tar", ["-xzf", join(tmp, "t.tar.gz"), "-C", bin]);
await chmod(join(bin, "tectonic"), 0o755);
console.log("prepare-tectonic:", execFileSync(join(bin, "tectonic"), ["--version"]).toString().trim());

// tectonic panics without system CA certs (e.g. slim images), so give it Node's own root certificates.
await writeFile(join(tmp, "ca.pem"), tls.rootCertificates.join("\n"));
const env = { ...process.env, HOME: tmp, TECTONIC_CACHE_DIR: cache, SSL_CERT_FILE: join(tmp, "ca.pem") };
const compile = (name, tex) => {
  const f = join(tmp, name + ".tex");
  return writeFile(f, tex).then(() => execFileSync(join(bin, "tectonic"), ["--chatter", "minimal", f], { env, cwd: tmp, stdio: "pipe", timeout: 600_000 }));
};

// The sample resume must compile, or the build fails loudly rather than shipping a broken app.
await compile("sample", await readFile("public/sample.tex", "utf8"));
console.log("prepare-tectonic: sample.tex compiled");

// Warm the packages resumes commonly use. A package missing from the bundle is skipped, not fatal.
const pkgs = "geometry hyperref enumitem titlesec xcolor fontawesome5 fontawesome tabularx array multicol fancyhdr parskip lmodern marvosym latexsym graphicx ragged2e setspace microtype tabu longtable booktabs tcolorbox paracol etoolbox ifthen calc textcomp fontenc inputenc babel soul url xparse amsmath amssymb".split(" ");
let ok = 0;
for (const p of pkgs) {
  try { await compile("w", `\\documentclass{article}\n\\usepackage{${p}}\n\\begin{document}x\\end{document}\n`); ok++; } catch { console.log("  (skipped", p + ")"); }
}
console.log(`prepare-tectonic: warmed ${ok}/${pkgs.length} packages`);

await rm(tmp, { recursive: true, force: true });
console.log("prepare-tectonic: cache files:", (await readdir(cache)).join(", "));
