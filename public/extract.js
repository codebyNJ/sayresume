// Turns an uploaded resume into plain text, entirely in the browser (no server-side tools needed).
// .txt/.md: as-is. .docx: unzip + strip XML. .pdf: PDF.js (vendored in /vendor, no CDN).

const NAMES = "Upload a .tex, .pdf, .docx, .txt or .md file.";

// Minimal zip reader: find one entry via the central directory and inflate it with the built-in DecompressionStream.
async function unzipEntry(buf, wanted) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65_557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That doesn't look like a valid .docx.");
  let p = v.getUint32(eocd + 16, true);
  for (let n = v.getUint16(eocd + 10, true); n > 0; n--) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    if (name === wanted) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = u8.subarray(start, start + size);
      if (method === 0) return data;
      return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    }
    p += 46 + nameLen + extra + comment;
  }
  throw new Error("No document text found in that .docx.");
}

async function docx(file) {
  const xml = new TextDecoder().decode(await unzipEntry(await file.arrayBuffer(), "word/document.xml"));
  return xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function pdf(file) {
  // URLs are built at runtime so build tools don't try to bundle the vendored PDF.js.
  const pdfjs = await import(new URL("./vendor/pdf.min.mjs", import.meta.url).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let out = "";
  for (let n = 1; n <= doc.numPages; n++) {
    let lastY = null;
    for (const it of (await (await doc.getPage(n)).getTextContent()).items) {
      if (!("str" in it)) continue;
      const y = it.transform[5];
      out += (lastY !== null && Math.abs(y - lastY) > 2 ? "\n" : out && !out.endsWith("\n") ? " " : "") + it.str;
      lastY = y;
    }
    out += "\n";
  }
  return out;
}

export async function extractText(file) {
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "txt" || ext === "md") return file.text();
  if (ext === "docx") return docx(file);
  if (ext === "pdf") return pdf(file);
  throw new Error(NAMES);
}
