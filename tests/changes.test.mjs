#!/usr/bin/env node
/**
 * Tests des changements de planning : « prof absent » (annulation), nouveau
 * cours, cours retiré, salle ou horaire modifiés.
 *
 *   npm run test:changes        (jsdom requis pour la seconde partie : npm install)
 *
 * Deux parties :
 *  1. noyau : comparaison de deux versions du planning (scripts/edt-changes.mjs)
 *     et fonctions d'affichage embarquées dans index.html ;
 *  2. rendu : la page elle-même, alimentée par un planning modifié, doit
 *     signaler les changements en clair (bandeau, badges, cloche, saut au cours).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { diffWeeks, mergeChangeLog, loadPageCore, summaryMarkdown, summarySubject, changeLine } from "../scripts/edt-changes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (condition, label) => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}`);
  if (!condition) failures.push(label);
};

const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(await readFile(path.join(ROOT, "data", "edt.json"), "utf8"));
const core = loadPageCore(html, [
  "parseEvent",
  "buildWeek",
  "fallbackWeeks",
  "findRecurringCancellations",
  "recurringKey",
  "normalizeGroupCode",
  "attachChanges",
  "relevantChanges",
  "changeIsUnseen",
  "changeAppliesToTd",
  "changeKey",
  "changeLabel",
  "changeSentence",
  "changeStatusLabel",
  "changeWhenLabel",
  "changeSummaryLabel",
  "CONFIG",
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const detectedAt = "2026-10-12T08:00:00.000Z";

/* ------------------------------------------------------------------ plan de test */

/** Planning modifié à partir des données réelles : un cas par type de changement. */
function mutatedWeeks() {
  const previous = clone(data.weeks);
  const next = clone(data.weeks);

  const week = next["2026-10-12"];
  const find = (suffix) => week.events.find((event) => event.id.endsWith(suffix));

  // 1. professeur absent : le CM de macro du mardi est publié en « Annulation »,
  //    avec le motif fourni par l'université
  const cm = find("5784305:9");
  cm.description = cm.description
    .replace(/^CM/, "Annulation")
    .replace(/\r\n\r\n<br \/>\r\n\r\nL2 MIASHS/, "\r\n\r\n<br />\r\n\r\nEnseignant absent (maladie)\r\n\r\n<br />\r\n\r\nL2 MIASHS");
  cm.eventCategory = "Annulation";
  cm.backgroundColor = "#333333";

  // 2. salle changée : le TD de maths du mercredi déménage
  const maths = find("5780212:9");
  maths.description = maths.description.replace(/AMPHI G - FERMAT \(117 \/ 57\)[^<]*/, "2206 - FERMAT");

  // 3. horaire modifié : le CM de bases de données du jeudi passe l'après-midi
  const bdd = find("5779518:9");
  bdd.start = "2026-10-15T14:00:00";
  bdd.end = "2026-10-15T15:30:00";

  // 4. nouveau cours : une séance de soutien apparaît le vendredi
  week.events.push({
    id: "nouveau-soutien",
    start: "2026-10-16T16:00:00",
    end: "2026-10-16T17:30:00",
    description: "TD\r\n\r\n<br />\r\n\r\n2206 - FERMAT\r\n\r\n<br />\r\n\r\nLSMA302-Soutien maths [LSMA302]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 TD 2 [S3MIASHS TD 2]",
    eventCategory: "TD",
    backgroundColor: "#FFFF00",
    modules: ["LSMA302"],
  });

  // 5. cours retiré : le TD de micro du lundi disparaît du planning
  week.events = week.events.filter((event) => !event.id.endsWith("5800994:9"));

  // 6. changement dans une autre semaine : le bandeau doit y amener l'étudiant
  next["2026-10-19"].events.push({
    id: "nouveau-lundi-suivant",
    start: "2026-10-19T18:00:00",
    end: "2026-10-19T19:00:00",
    description: "CM\r\n\r\n<br />\r\n\r\nAMPHI B - DESCARTES\r\n\r\n<br />\r\n\r\nLSSO310N-Conférence sociologie [LSSO310N]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 ( S3MIASHS ) [S3MIASHS]",
    eventCategory: "CM",
    backgroundColor: "#00FFFF",
    modules: ["LSSO310N"],
  });

  return { previous, next };
}

const { previous, next } = mutatedWeeks();
const changes = diffWeeks(previous, next, { core, detectedAt });

console.log("\n— détection des changements (comparaison du planning officiel) —");
const kinds = changes.map((change) => change.kind);
const oneOf = (kind) => changes.find((change) => change.kind === kind);
console.log(changes.map((change) => `      ${changeLine(core, change)}`).join("\n"));
check(kinds.includes("cancelled"), "une annulation (prof absent) est détectée");
check(kinds.includes("added"), "un nouveau cours est détecté");
check(kinds.includes("removed"), "un cours retiré du planning est détecté");
check(kinds.includes("moved"), "un déplacement d'horaire est détecté");
check(kinds.includes("room"), "un changement de salle est détecté");
check(oneOf("cancelled")?.title === "Macroéconomie 2", "l'annulation porte le nom de la matière");
check(oneOf("cancelled")?.type === "CM", "le type réel de la séance est conservé (pas « Annulation »)");
check(oneOf("cancelled")?.reason === "Enseignant absent (maladie)", `le motif publié est repris (« ${oneOf("cancelled")?.reason} »)`);
check(oneOf("moved")?.previous?.time === "09:40 - 11:10" && oneOf("moved")?.time === "14:00 - 15:30", "l'ancien et le nouvel horaire sont conservés");
check(oneOf("room")?.previous?.room === "AMPHI G - FERMAT" && oneOf("room")?.room === "2206 - FERMAT", "l'ancienne et la nouvelle salle sont conservées");
check(diffWeeks(previous, next, { core, detectedAt }).length === changes.length, "la comparaison est déterministe");
check(
  summarySubject(core, changes) === "1 annulation, 2 nouveaux cours, 1 cours retiré, 1 horaire modifié, 1 changement de salle",
  `résumé lisible : « ${summarySubject(core, changes)} »`,
);
check(summaryMarkdown(core, changes).includes("| 🚫 Cours annulé |"), "le résumé de workflow liste les changements");

console.log("\n— garde-fous : pas de fausses alertes —");
const untouched = diffWeeks(data.weeks, clone(data.weeks), { core, detectedAt });
check(untouched.length === 0, "un planning identique ne produit aucun changement");
check(diffWeeks({}, data.weeks, { core, detectedAt }).length === 0, "une semaine jamais vue n'est pas annoncée comme nouvelle");

// Créneau suspendu (anglais annulé chaque semaine) : ce n'est pas une information.
const ohneRecurring = clone(data.weeks);
for (const week of Object.values(ohneRecurring)) {
  for (const event of week.events) {
    if (event.eventCategory !== "Annulation") continue;
    event.eventCategory = "TD";
    event.backgroundColor = "#FFFF00";
    event.description = event.description.replace(/^Annulation/, "TD");
  }
}
const recurringChanges = diffWeeks(ohneRecurring, data.weeks, { core, detectedAt });
check(
  !recurringChanges.some((change) => change.kind === "cancelled" && /Anglais/.test(change.title)),
  `un créneau annulé chaque semaine n'est pas signalé (${recurringChanges.length} changement(s) retenu(s))`,
);

console.log("\n— journal publié : fusion, dédoublonnage, purge —");
const once = mergeChangeLog([], changes, { now: new Date(detectedAt) });
const twice = mergeChangeLog(once, changes.map((change) => ({ ...change, detectedAt: "2026-10-13T08:00:00.000Z" })), { now: new Date("2026-10-13T08:00:00.000Z") });
check(once.length === changes.length && twice.length === changes.length, "un même changement n'est enregistré qu'une fois");
check(twice[0].detectedAt === "2026-10-13T08:00:00.000Z", "un changement revu plus tard redevient une information récente");
check(mergeChangeLog(once, [], { now: new Date("2026-12-31T00:00:00.000Z") }).length === 0, "les entrées trop anciennes sont purgées");

console.log("\n— noyau d'affichage (libellés, filtrage, badges) —");
const cancelled = oneOf("cancelled");
check(core.changeLabel(cancelled).label === "Cours annulé" && core.changeLabel(cancelled).icon === "🚫", "libellé clair pour une annulation");
check(core.changeStatusLabel(oneOf("moved")) === "avant : 09:40 - 11:10", "le détail « avant » est affiché");
check(core.changeSentence(oneOf("moved")).includes("Jeudi 15 octobre · 14:00 - 15:30"), "la phrase indique le jour et le nouvel horaire");
check(core.changeStatusLabel(oneOf("room")).includes("AMPHI G - FERMAT"), "le détail de salle est affiché");
check(core.changeWhenLabel({ ...cancelled, date: "2026-10-12" }, "2026-10-12") === `Aujourd'hui · ${cancelled.time}`, "« Aujourd'hui » dans le libellé de date");

const td1Only = { kind: "added", date: "2026-10-12", time: "08:00 - 09:30", title: "Option TD 1", groups: ["S3MIASHS TD 1"] };
const promo = { kind: "added", date: "2026-10-12", time: "08:00 - 09:30", title: "Conférence promo", groups: ["S3MIASHS"] };
check(core.changeAppliesToTd(td1Only) === false && core.changeAppliesToTd(promo) === true, "seuls les changements du TD affiché (ou de la promo) sont signalés");
check(core.relevantChanges([{ ...cancelled, date: "2025-01-01" }], core.CONFIG, { today: "2026-10-12" }).length === 0, "les changements trop anciens sortent du bandeau");
check(core.changeIsUnseen({ detectedAt }, "") === true && core.changeIsUnseen({ detectedAt }, detectedAt) === false, "« ✓ Vu » mémorise ce qui a déjà été lu");

const reference = core.fallbackWeeks.find((week) => week.monday === "2026-10-12");
const view = core.buildWeek("2026-10-12", next["2026-10-12"].events, reference, { live: true, recurringCancellations: core.findRecurringCancellations(next) });
const attached = core.attachChanges(view, changes, core.CONFIG, { all: true });
const attachedCourses = attached.days.flatMap((day) => day.courses);
check(attachedCourses.some((course) => course.removed && course.title === "Microéconomie 2"), "un cours retiré devient une carte « retiré » dans la grille");
check(attachedCourses.some((course) => course.changes?.some((change) => change.kind === "room")), "un changement de salle est accroché à sa carte");
check(attachedCourses.some((course) => (course.changes ?? []).length && core.changeLabel(course.changes[0]).short.length > 0), "les badges ont un libellé court affichable");

/* ------------------------------------------------------------------ rendu réel */

let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import("jsdom"));
} catch {
  console.log("\n⚠️  jsdom n'est pas installé — test de rendu des changements ignoré (npm install).");
  console.log(failures.length ? `\n❌ ${failures.length} échec(s)` : "\n✅ tout est vert (noyau seul)");
  process.exit(failures.length ? 1 : 0);
}

const served = {
  ...data,
  generatedAt: detectedAt,
  changes: mergeChangeLog([], changes, { now: new Date(detectedAt) }),
  weeks: next,
};
const errors = [];
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
    window.Element.prototype.animate = () => ({ finished: Promise.resolve(), cancel() {} });
    window.scrollTo = () => {};
    window.fetch = async (target) => {
      const url = String(target);
      if (url.includes("data/edt.json")) return { ok: true, status: 200, json: async () => served };
      throw new Error(`réseau bloqué dans le test : ${url}`);
    };
  },
});

const { window } = dom;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await new Promise((resolve) => window.addEventListener("load", resolve));
await wait(400);
const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => [...window.document.querySelectorAll(selector)];

console.log("\n— affichage : emploi du temps direct sans bandeau jaune ni doublons —");
check($("#changeBanner") === null && !$(".changes"), "aucun bandeau jaune n'est affiché au-dessus de l'emploi du temps");
check($("#changesBtn") === null, "aucune cloche de changements dans la barre d'outils");
check($$("#grid .card.removed").length === 0, "les cours retirés ne sont pas réinjectés en double dans la grille");
check($$("#grid .card-change").length === 0 && $$("#grid .day-alert").length === 0, "aucun badge ni puce parasite sur les cartes ou les journées");

const gridText = $("#grid").textContent;
check(/Soutien maths/.test(gridText), "le nouveau cours est ajouté directement dans l'emploi du temps");
check(/2206 - FERMAT/.test(gridText), "la nouvelle salle est affichée directement sur le cours");
check(/14:00 - 15:30/.test(gridText), "le nouvel horaire est affiché directement dans l'emploi du temps");
const cancelledCard = $("#grid .card.cancelled");
check(cancelledCard !== null, "une séance annulée par CELCAT reste signalée sur sa carte");
check(/Enseignant absent/.test(cancelledCard?.textContent ?? ""), "la carte indique le motif publié par l'université");
check(!/Annulation/.test(cancelledCard?.textContent ?? ""), "l'étiquette CELCAT « Annulation » n'est pas répétée sur la carte");

console.log("\n— impression & erreurs —");
window.dispatchEvent(new window.Event("beforeprint"));
const printHtml = $("#print").innerHTML;
check(/ANNULÉ/i.test(printHtml), "l'impression signale les cours annulés");
check(errors.length === 0, `aucune erreur JavaScript (${errors.length})`);
errors.slice(0, 4).forEach((error) => console.log(`      ${error}`));

console.log(failures.length ? `\n❌ ${failures.length} échec(s)` : "\n✅ tout est vert");
process.exit(failures.length ? 1 : 0);
