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
    const RealDate = window.Date;
    class TestDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [2026, 9, 9, 17, 30, 0])); }
      static now() { return new RealDate(2026, 9, 9, 17, 30, 0).getTime(); }
    }
    window.Date = TestDate;
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
const targetDay = $("#grid .day.target");
check(targetDay !== null, "un jour est ciblé dès l'ouverture");
const targetName = targetDay?.querySelector(".day-name")?.textContent;
check(["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"].includes(targetName), `la destination est un jour ouvré (${targetName ?? "introuvable"})`);
const targetTime = targetDay?.querySelector(".day-date time");
check(targetTime?.dateTime === "2026-10-12", "après la dernière séance du vendredi, lundi est affiché à l'ouverture");
if (targetTime?.dateTime) {
  const [year, month, day] = targetTime.dateTime.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  const months = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const targetWeekStart = `${String(date.getDate()).padStart(2, "0")} ${months[date.getMonth()]}`;
  check(title.includes(targetWeekStart), `la semaine de la journée ciblée est affichée (${targetWeekStart})`);
}

console.log("\n— interface simplifiée —");
check(!$(".legend") && !/Repères\s*:/i.test(window.document.body.textContent), "la section « Repères » a été supprimée");
check(!$("#changes") && !/1 séance annulée/i.test(window.document.body.textContent), "aucun encart global ni liste d'annulations");
check(!$("#liveBanner") && !$("#liveStatus") && !/synchro GitHub/i.test(window.document.body.textContent), "le statut de synchronisation n'est plus affiché");
check(!$(".week-progress") && !$("#weekProgress"), "la barre de progression hebdomadaire a été supprimée");
check(!$("#refresh") && !/Actualiser|refreshCurrentWeek/.test(html), "le bouton et le code de rafraîchissement manuel ont été supprimés");
check(!scheduledIntervals.some(({ delay }) => delay === 5 * 60 * 1000 || delay === 60 * 1000), "aucune actualisation automatique après le chargement");

console.log("\n— annulation détectée (CM de BDD du 1er octobre) —");
let back = 0;
for (; back < 8 && !/28 Septembre/.test($("#weekTitle").textContent); back++) $("#prev").click();
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

console.log("\n— le planning officiel n'invente pas de séance « à vérifier » —");
check(window.document.querySelector("#grid .card.ghost") === null, "aucune carte « à vérifier » sur la semaine affichée");
check(!/À VÉRIFIER/.test($("#grid").textContent), "le badge « à vérifier » n'est plus affiché dans le planning");
check(!$("#changes"), "aucun encart global de cours manquant");

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
