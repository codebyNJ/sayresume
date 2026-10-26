import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBlocks, parseMoves, applyEdits, moveSection, extractLatex, noChange, newDuplicateSection, lostSection, droppedWords, isAddOnly, notAdded } from "./lib/edits.mjs";

const tex = readFileSync(new URL("./public/sample.tex", import.meta.url), "utf8");
const block = (s, r) => `<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

// model reply with thinking, prose and two blocks
const reply = `<think>hmm</think>Sure:\n${block("  \\item Worked on the checkout page", "  \\item Rebuilt the checkout page")}\n\n${block("  \\item Helped with code reviews", "  \\item Helped with code reviews\n  \\item Reduced page load time by 40\\%")}`;
const blocks = parseBlocks(reply);
assert.equal(blocks.length, 2);
const out = applyEdits(tex, blocks);
assert.match(out, /Rebuilt the checkout page/);
assert.match(out, /Helped with code reviews\n  \\item Reduced page load time by 40\\%/);
assert.doesNotMatch(out, /Worked on the checkout/);

// sloppy markers from a small model (seen with gemma-4-e2b): missing <<<<<<<, short =====
assert.deepEqual(parseBlocks("SEARCH\na\nb\n=====\nc\n>>>>>>> REPLACE"), [{ search: "a\nb", replace: "c" }]);
assert.equal(parseBlocks("```\n<<<<<<<SEARCH\na\n=======\n\nREPLACE\n```").length, 1);

// no ======= divider at all (seen from a free cloud model): old text ends at ">>> REPLACE", new text runs to the next block
assert.deepEqual(parseBlocks("<<<<<<< SEARCH\nFull-stack Developer\n>>>>>>> REPLACE\nFull Stack Engineer\n<<<<<<< SEARCH\nx\n>>>>>>> REPLACE\ny\nz"),
  [{ search: "Full-stack Developer", replace: "Full Stack Engineer" }, { search: "x", replace: "y\nz" }]);
assert.equal(parseBlocks("<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE").length, 1);   // the proper form still wins

// "add" must not overwrite what's already there
assert.ok(isAddOnly("Um, add my job at Google")); assert.ok(isAddOnly("Ah, also add AWS and Docker")); assert.ok(isAddOnly("Can you add a bullet"));
assert.ok(!isAddOnly("Change my headline to X")); assert.ok(!isAddOnly("Make my bullets stronger")); assert.ok(!isAddOnly("Remove the projects section"));
const renamed = applyEdits(tex, [{ search: "Software Engineer, Acme Pay", replace: "Software Engineer, Google" }]);
assert.deepEqual(droppedWords(tex, renamed), ["acme"]);
assert.deepEqual(droppedWords(tex, applyEdits(tex, [{ search: "PostgreSQL, Git", replace: "PostgreSQL, Git, AWS, Docker" }])), []);
assert.deepEqual(droppedWords(tex, applyEdits(tex, [{ search: "  \\item Helped with code reviews", replace: "  \\item Helped with code reviews\n  \\item Reduced page load time by 40%" }])), []);

// an "add" edit that adds none of what was asked (e.g. an unrelated move) is flagged
assert.deepEqual(notAdded("add my job at Google", tex, tex), ["google"]);
assert.deepEqual(notAdded("add my job at Google", tex, tex.replace("Git", "Git\n\\textbf{Engineer, Google}")), []);
assert.deepEqual(notAdded("add AWS and Docker to my skills", tex, tex.replace("Git", "Git, AWS, Docker")), []);
assert.deepEqual(notAdded("add a bullet about reduced page load time by forty percent", tex, tex.replace("Git", "Git\nReduced page load time")), []);
assert.deepEqual(notAdded("add another bullet to the checkout page", tex, tex), []);       // nothing new was named -> no check

// delete (empty REPLACE) and whitespace-drifted SEARCH
assert.equal(parseBlocks(block("x", "")).at(0).replace, "");
assert.doesNotMatch(applyEdits(tex, [{ search: "\\item Fixed bugs in the payments API   ", replace: "" }]), /Fixed bugs/);

// errors: not found, ambiguous, empty
assert.throws(() => applyEdits(tex, [{ search: "\\item Nope", replace: "" }]), /not found/);
assert.throws(() => applyEdits(tex, [{ search: "\\begin{itemize}", replace: "" }]), /matches 2 places/);
assert.throws(() => applyEdits(tex, [{ search: " ", replace: "x" }]), /empty/);
// unescaped percent after a number gets escaped; already-escaped stays as is
assert.match(applyEdits(tex, [{ search: "Git", replace: "Git (40% faster, 5\\% more)" }]), /Git \(40\\% faster, 5\\% more\)/);
// a stray trailing \\ on a bullet is removed, but \\ elsewhere is untouched
assert.match(applyEdits(tex, [{ search: "  \\item Helped with code reviews", replace: "  \\item Helped with code reviews\n  \\item Cut load time by 40\\% \\\\" }]), /load time by 40\\%\n/);
assert.match(applyEdits(tex, [{ search: "\\textit{Bengaluru}", replace: "\\textit{Bengaluru} \\\\" }]), /Bengaluru\} \\\\/);
// "$&" in replacement must be literal, not a regex back-reference
assert.match(applyEdits(tex, [{ search: "Git", replace: "Git, $& AWS" }]), /Git, \$& AWS/);

// a "move" that forgot to delete the original
const copied = applyEdits(tex, [{ search: "\\section*{Experience}", replace: "\\section*{Skills}\nGit\n\n\\section*{Experience}" }]);
assert.equal(newDuplicateSection(tex, copied), "skills");
assert.equal(newDuplicateSection(tex, out), null);

// MOVE lines: parsed loosely, executed by code, content preserved exactly
const order = t => [...t.matchAll(/\\section\*\{([^}]*)\}/g)].map(m => m[1]).join(",");
const mv = parseMoves("Sure.\nMOVE: Skills BEFORE Experience\n- MOVE: \"education\" after summary");
assert.deepEqual(mv.map(m => m.where), ["BEFORE", "AFTER"]);
const moved = mv.reduce(moveSection, tex);
assert.equal(order(moved), "Summary,Education,Skills,Experience,Projects");
assert.equal(moved.length, tex.length);                                   // nothing lost or duplicated
assert.equal(order(moveSection(tex, { section: "Summary", where: "AFTER", target: "Skills" })), "Experience,Projects,Education,Skills,Summary");
assert.match(moveSection(tex, { section: "Summary", where: "AFTER", target: "Skills" }), /Git\n\n\\section\*\{Summary\}[\s\S]*\n\\end\{document\}/);
assert.throws(() => moveSection(tex, { section: "Hobbies", where: "AFTER", target: "Skills" }), /no section called "Hobbies"/);
assert.equal(lostSection(tex, tex.replace(/\\section\*\{Education\}[\s\S]*?(?=\\section)/, "")), "education");
assert.equal(lostSection(tex, moved), null);
assert.equal(noChange("MOVE: Skills BEFORE Experience"), null);
assert.deepEqual(parseMoves("MOVE: \\section*{Skills} BEFORE \\section*{Experience}")[0], { section: "Skills", where: "BEFORE", target: "Experience" });
// deleting a section doesn't leave a pile of blank lines
assert.doesNotMatch(applyEdits(tex, [{ search: "\\section*{Projects}\n\\textbf{Kirana Billing App} \\hfill 2024", replace: "" }]), /\n\n\n/);

assert.equal(extractLatex("here:\n```latex\n" + tex + "```"), tex);
assert.throws(() => extractLatex("no latex"));
assert.equal(noChange("NOCHANGE: Which job do you mean?"), "Which job do you mean?");
assert.equal(noChange(reply), null);
console.log("ok");
