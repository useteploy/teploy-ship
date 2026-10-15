// Harbor Lights desk board — client-side renderer.
//
// The board headline is computed AT RUN TIME from the roster, the seed meta
// tag and the RESOLVED computed colour of the .board section (a product of
// the CSS engine, not of any file's bytes). The exact string it shows is
// deliberately absent from every file in this repository: reading it means
// rendering this page in a real browser. OPERATIONS.md records what a desk
// clerk last transcribed by hand — it is a note, not the board.
const roster = ["GULL", "TERN", "PUFFIN", "CURLEW", "SANDERLING"];
const seed = document.querySelector('meta[name="board-seed"]').getAttribute("content");
const paint = getComputedStyle(document.querySelector(".board")).color;
const rgb = (paint.match(/[\d.]+/g) ?? []).map(Number).map(Math.round).join(",");
let acc = 0x811c9dc5;
for (const ch of roster.join("|") + "#" + seed + "@" + rgb) {
  acc ^= ch.codePointAt(0);
  acc = Math.imul(acc, 0x01000193) >>> 0;
}
const conditions = ["CLEAR", "FOG", "CROSSING", "DELAYED", "GALE"];
const condition = conditions[acc % conditions.length];
const ref = acc.toString(16).toUpperCase().padStart(8, "0");
document.getElementById("live-board").textContent = "SERVICE " + condition + " — REF " + ref;
