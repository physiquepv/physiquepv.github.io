/**
 * Test du mode dégradé : aucune source réseau disponible (ni data/edt.json ni
 * CELCAT). La page continue à fonctionner avec l'emploi du temps de secours,
 * sans badge d'état global.
 *
 *   npm run test:offline
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import("jsdom"));
} catch {
  console.log("⚠️  jsdom n'est pas installé — test hors-ligne ignoré (npm install).");
  process.exit(0);
}
const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const errors = [];
const scheduledIntervals = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push(e.message));
vc.on("error", (...a) => errors.push(a.join(" ")));
vc.on("warn", () => {});
const dom = new JSDOM(html, {
  url: "https://physiquepv.github.io/", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(window) {
    window.matchMedia = (q) => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    window.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
    window.scrollTo = () => {};
    const originalSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      scheduledIntervals.push({ callback, delay: Number(delay) });
      return originalSetInterval(callback, delay, ...args);
    };
    window.fetch = async (url) => { throw new Error(`hors-ligne: ${url}`); };
  },
});
await new Promise((r) => dom.window.addEventListener("load", r));
await new Promise((r) => setTimeout(r, 600));
const $ = (s) => dom.window.document.querySelector(s);
const fails = [];
const check = (c, l) => { console.log(`${c ? "  ✓" : "  ✗"} ${l}`); if (!c) fails.push(l); };
console.log("\n— mode hors-ligne (aucune source réseau) —");
check(dom.window.document.querySelectorAll("#grid .day").length === 5, "la grille reste affichée");
check(dom.window.document.querySelectorAll("#grid .card").length > 0, "des cours de secours sont affichés");
check(!$(".legend") && !$("#changes"), "la section Repères et l'encart global sont absents");
check(!$("#liveBanner") && !$("#liveStatus"), "aucun statut de synchronisation n'est affiché");
check(!$("#refresh") && !$(".week-progress"), "le bouton manuel et la progression de semaine sont absents");
check($("#print").innerHTML.includes("print-table"), "l'impression de secours fonctionne");
const backgroundRefresh = scheduledIntervals.find(({ delay }) => delay === 5 * 60 * 1000);
check(Boolean(backgroundRefresh) && /loadEverything/.test(String(backgroundRefresh?.callback)), "la synchro automatique reste planifiée même hors ligne");
check(errors.length === 0, `aucune erreur JS (${errors.length})`);
errors.slice(0, 3).forEach((e) => console.log("      " + e));
console.log(fails.length ? `\n❌ ${fails.length} échec(s)` : "\n✅ tout est vert");
process.exit(fails.length ? 1 : 0);
