/**
 * Test de rendu (jsdom) : charge index.html, alimente data/edt.json et vérifie
 * ce que l'utilisateur voit réellement (semaine courante, annulations sur les
 * cartes, filtrage du TD, contrôles retirés, synchro automatique, impression).
 *
 *   npm run test:render      (nécessite : npm install)
 *
 * Le test est ignoré si jsdom n'est pas installé.
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
  console.log("⚠️  jsdom n'est pas installé — test de rendu ignoré (npm install).");
  process.exit(0);
}
const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(await readFile(path.join(ROOT, "data", "edt.json"), "utf8"));

const errors = [];
const scheduledIntervals = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => errors.push(`jsdomError: ${error.message}`));
virtualConsole.on("error", (...args) => errors.push(`console.error: ${args.join(" ")}`));
virtualConsole.on("warn", () => {});

const dom = new JSDOM(html, {
  url: "https://physiquepv.github.io/",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    window.matchMedia = (query) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    window.Element.prototype.animate = function animate() { return { finished: Promise.resolve(), cancel() {} }; };
    window.scrollTo = () => {};
    const originalSetInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      scheduledIntervals.push({ callback, delay: Number(delay) });
      return originalSetInterval(callback, delay, ...args);
    };
    window.fetch = async (url) => {
      const target = String(url);
      if (target.includes("data/edt.json")) {
        return { ok: true, status: 200, json: async () => data };
      }
      if (target.includes("api.github.com")) {
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ updated_at: new Date().toISOString() }] }) };
      }
      throw new Error(`réseau bloqué dans le test : ${target}`);
    };
  },
});

const { window } = dom;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await new Promise((resolve) => window.addEventListener("load", resolve));
await wait(400);

const $ = (selector) => window.document.querySelector(selector);
const failures = [];
const check = (condition, label) => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}`);
  if (!condition) failures.push(label);
};

console.log("\n— état général —");
check($("#grid .day") !== null, "la grille affiche des journées");
check(window.document.querySelectorAll("#grid .day").length === 5, "5 colonnes (lundi → vendredi)");
const title = $("#weekTitle").textContent;
console.log(`      titre affiché : ${title}`);
check(/28 Septembre/.test(title), "la semaine du 28/09/2026 est affichée (aujourd'hui = 1er octobre)");
check(/Semaine 3/.test(title), "elle porte le numéro de la semaine de référence (3)");

console.log("\n— interface simplifiée —");
check(!$(".legend") && !/Repères\s*:/i.test(window.document.body.textContent), "la section « Repères » a été supprimée");
check(!$("#changes") && !/1 séance annulée/i.test(window.document.body.textContent), "aucun encart global ni liste d'annulations");
check(!$("#liveBanner") && !$("#liveStatus") && !/synchro GitHub/i.test(window.document.body.textContent), "le statut de synchronisation n'est plus affiché");
check(!$(".week-progress") && !$("#weekProgress"), "la barre de progression hebdomadaire a été supprimée");
check(!$("#refresh") && !/Actualiser|refreshCurrentWeek/.test(html), "le bouton et le code de rafraîchissement manuel ont été supprimés");
const backgroundRefresh = scheduledIntervals.find(({ delay }) => delay === 5 * 60 * 1000);
check(Boolean(backgroundRefresh) && /loadEverything/.test(String(backgroundRefresh?.callback)), "la synchronisation automatique en arrière-plan reste planifiée toutes les cinq minutes");

console.log("\n— annulation détectée (CM de BDD du 1er octobre) —");
const cancelled = window.document.querySelectorAll("#grid .card.cancelled");
check(cancelled.length === 1, `1 carte annulée affichée (${cancelled.length})`);
if (cancelled.length) {
  const card = cancelled[0];
  console.log(`      ${card.querySelector(".card-time").textContent} — ${card.querySelector(".card-title").textContent} — ${card.querySelector(".card-tag")?.textContent}`);
  check(/Initiation bases de données/.test(card.textContent), "la matière annulée est la bonne");
  check(/annul/i.test(card.querySelector(".card-tag")?.textContent ?? ""), "l'étiquette de la carte mentionne l'annulation");
}
const dayCounts = [...window.document.querySelectorAll("#grid .day-count")];
check(dayCounts.every((count) => !count.textContent.includes("⚠")), "le nombre de cours ne contient plus de marqueur d'avertissement");

console.log("\n— filtrage du groupe —");
const cards = [...window.document.querySelectorAll("#grid .card")];
const micro = cards.filter((card) => /Microéconomie/.test(card.textContent) && /15:30/.test(card.textContent));
check(micro.length === 1, "le TD de micro du TD 02 (15:30) est présent");
check(!cards.some((card) => /13:50/.test(card.querySelector(".card-time").textContent) && /Microéconomie/.test(card.textContent)), "le TD de micro du TD 01 (13:50) est masqué");
check(cards.some((card) => /Votre TD 02/.test(card.textContent)), "les étiquettes « Votre TD 02 » sont conservées");
check(!cards.some((card) => card.classList.contains("cancelled") && /Anglais/.test(card.textContent)), "le créneau d'anglais annulé en permanence est masqué");

console.log("\n— semaine avec cours disparu (décembre) —");
let steps = 0;
for (; steps < 40 && !/14 Décembre/.test($("#weekTitle").textContent); steps++) {
  $("#next").click();
  await wait(20);
}
console.log(`      atteinte en ${steps} clic(s) : ${$("#weekTitle").textContent}`);
if (/14 Décembre/.test($("#weekTitle").textContent)) {
  const ghost = window.document.querySelector("#grid .card.ghost");
  check(ghost !== null, "le cours disparu est signalé directement sur sa carte");
  check(/Anglais UE2/.test(ghost?.textContent ?? ""), "la bonne matière manquante est identifiée");
  check(!$("#changes"), "aucun encart global ne réapparaît pour un cours manquant");
} else {
  check(false, `semaine du 14 décembre attendue, obtenue : ${$("#weekTitle").textContent}`);
}

console.log("\n— impression —");
window.dispatchEvent(new window.Event("beforeprint"));
const printHtml = $("#print").innerHTML;
check(printHtml.includes('class="print-table"'), "la page d'impression utilise le tableau attendu");
check(printHtml.includes("Semaine 1") && printHtml.includes("Semaine 13"), "les 13 semaines du semestre sont imprimées");

console.log("\n— erreurs JavaScript —");
check(errors.length === 0, `aucune erreur console (${errors.length})`);
errors.slice(0, 5).forEach((error) => console.log(`      ${error}`));

console.log(`\n${failures.length ? `❌ ${failures.length} échec(s)` : "✅ tout est vert"}`);
process.exit(failures.length ? 1 : 0);
