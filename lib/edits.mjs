// Pure text logic for the understanding layer. No I/O. Tested by test.mjs.

export const stripThink = s => s.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/\r\n/g, "\n");

// Loose on the markers: small models often drop or miscount the <<< / === / >>>.
const BLOCK = /(?:^|\n)[ \t]*<*[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n[ \t]*={3,}[ \t]*\n([\s\S]*?)\n?[ \t]*>*[ \t]*REPLACE\b/g;
export const parseBlocks = s => [...stripThink(s).matchAll(BLOCK)].map(m => ({ search: m[1], replace: m[2] }));

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Each SEARCH must match exactly once. Exact match first; then a fallback that
// ignores indentation/trailing spaces, since small local models drift on whitespace.
export function applyEdits(tex, blocks) {
  blocks.forEach(({ search, replace }, n) => {
    replace = replace.replace(/(\d)%/g, "$1\\%") // "40%" would start a LaTeX comment and silently eat the line
      .replace(/^([ \t]*\\item\b[^\n]*?)[ \t]*\\\\[ \t]*$/gm, "$1");  // some models end bullets with a stray \\ (blank line)
    const where = `Edit ${n + 1} (SEARCH starting "${search.trim().split("\n")[0].slice(0, 60)}")`;
    if (!search.trim()) throw new Error(`${where}: SEARCH is empty.`);
    const exact = tex.split(search).length - 1;
    if (exact === 1) { tex = tex.replace(search, () => replace); return; }
    if (exact > 1) throw new Error(`${where}: matches ${exact} places; include more surrounding lines.`);
    const re = new RegExp(search.split("\n").map(l => "[ \\t]*" + escRe(l.trim()) + "[ \\t]*").join("\\n"), "g");
    const hits = [...tex.matchAll(re)];
    if (hits.length !== 1) throw new Error(`${where}: ${hits.length ? "matches " + hits.length + " places" : "not found"}; copy the lines exactly from the file.`);
    tex = tex.slice(0, hits[0].index) + replace + tex.slice(hits[0].index + hits[0][0].length);
  });
  return tex.replace(/\n{3,}/g, "\n\n"); // deletions leave stacked blank lines
}

export function extractLatex(s) {
  s = stripThink(s);
  const i = s.indexOf("\\documentclass"), j = s.lastIndexOf("\\end{document}");
  if (i < 0 || j < i) throw new Error("Reply did not contain a full LaTeX document (\\documentclass ... \\end{document}).");
  return s.slice(i, j + "\\end{document}".length) + "\n";
}

// Section moves are done by code, not text surgery: the model only says
// "MOVE: <section> BEFORE|AFTER <section>", so a move can't lose or duplicate content.
export const parseMoves = s => [...stripThink(s).matchAll(/^[ \t>*-]*MOVE:\s*(.+?)\s+(BEFORE|AFTER)\s+(.+?)\s*$/gim)]
  .map(m => ({ section: secName(m[1]), where: m[2].toUpperCase(), target: secName(m[3]) }));
// models sometimes write the LaTeX heading ("\section*{Skills}") instead of the title
const secName = s => s.replace(/\\section\*?\{([^}]*)\}/, "$1").replace(/["'`]/g, "").trim();

function sectionsOf(tex) {
  const end = tex.lastIndexOf("\\end{document}");
  const heads = [...tex.matchAll(/^\\section\*?\{([^}]*)\}/gm)].filter(m => m.index < end);
  return heads.map((h, k) => ({ title: h[1].trim(), start: h.index, end: k + 1 < heads.length ? heads[k + 1].index : end }));
}
function pick(secs, name) {
  const n = name.trim().toLowerCase();
  const s = secs.find(x => x.title.toLowerCase() === n) || secs.find(x => x.title.toLowerCase().includes(n) || n.includes(x.title.toLowerCase()));
  if (!s) throw new Error(`MOVE: no section called "${name}". Sections are: ${secs.map(x => x.title).join(", ")}.`);
  return s;
}
export function moveSection(tex, { section, where, target }) {
  const a = pick(sectionsOf(tex), section);
  const piece = tex.slice(a.start, a.end), rest = tex.slice(0, a.start) + tex.slice(a.end);
  const b = pick(sectionsOf(rest), target);
  if (b.title === a.title) throw new Error("MOVE: section and target are the same.");
  const at = where === "BEFORE" ? b.start : b.end;
  return rest.slice(0, at) + piece + rest.slice(at);
}

// Safety nets for edits that compile but damage the resume.
const titles = tex => sectionsOf(tex).map(s => s.title.toLowerCase());
export function newDuplicateSection(before, after) {
  const had = new Set(titles(before).filter((t, i, a) => a.indexOf(t) !== i));
  return titles(after).find((t, i, a) => a.indexOf(t) !== i && !had.has(t)) ?? null;
}
export const lostSection = (before, after) => titles(before).find(t => !titles(after).includes(t)) ?? null;

// "NOCHANGE: question" means the model needs clarification instead of editing.
export function noChange(s) {
  const m = stripThink(s).match(/NOCHANGE:?\s*([^\n]*)/);
  return m && !parseBlocks(s).length && !parseMoves(s).length ? (m[1].trim() || "Nothing to change.") : null;
}
