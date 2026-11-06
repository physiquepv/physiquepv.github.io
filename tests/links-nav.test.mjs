/**
 * Liens eCampus, fin du « maintenir pour supprimer une matière », navigation
 * jour par jour (‹ › en bas) et mémorisation du jour consulté.
 *
 *   npm run test:links      (nécessite : npm install)
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
  console.log("⚠️  jsdom n'est pas installé — test des liens ignoré (npm install).");
  process.exit(0);
}

const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(await readFile(path.join(ROOT, "data", "edt.json"), "utf8"));
const config = JSON.parse(await readFile(path.join(ROOT, "edt.config.json"), "utf8"));

// La config publiée peut corriger une URL : on remplace celle des maths par un
// autre identifiant valide, et on glisse une clé/URL piège qui doit être ignorée.
const remoteConfig = {
  ...config,
  courseLinks: {
    ...config.courseLinks,
    maths: "https://ecampus.paris-saclay.fr/course/view.php?id=999999",
    pirate: "https://exemple.fr/piège",
  },
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
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true, writable: true });
    const RealDate = window.Date;
    class TestDate extends RealDate {
      constructor(...args) { super(...(args.length ? args : [2026, 9, 9, 17, 30, 0])); }
      static now() { return new RealDate(2026, 9, 9, 17, 30, 0).getTime(); }
    }
    window.Date = TestDate;
    window.matchMedia = (query) => ({ matches: false, media: query, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    window.Element.prototype.animate = function animate() { return { finished: Promise.resolve(), cancel() {} }; };
    window.scrollTo = () => {};
    window.fetch = async (url) => {
      const target = String(url);
      if (target.includes("edt.config.json")) return { ok: true, status: 200, json: async () => remoteConfig };
      if (target.includes("data/edt.json")) return { ok: true, status: 200, json: async () => data };
      if (target.includes("api.github.com")) return { ok: true, status: 200, json: async () => ({ workflow_runs: [{ updated_at: new Date().toISOString() }] }) };
      throw new Error(`réseau bloqué dans le test : ${target}`);
    };
  },
});

const { window } = dom;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await new Promise((resolve) => window.addEventListener("load", resolve));
await wait(400);

const $ = (selector) => window.document.querySelector(selector);
const $$ = (selector) => [...window.document.querySelectorAll(selector)];
const failures = [];
const check = (condition, label) => {
  console.log(`${condition ? "  ✓" : "  ✗"} ${label}`);
  if (!condition) failures.push(label);
};
const label = () => $("#dayNavLabel")?.textContent ?? "";
const weekendPanel = () => $("#grid .day.weekend-day");
const dispatch = (element, type, init = {}) => element.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }));

console.log("\n— un clic sur une matière ouvre sa page eCampus —");
const links = $$("#grid .card.is-link");
check(links.length > 0, `les cours officiels sont des liens (${links.length})`);
check(links.every((card) => card.tagName === "A"), "la carte entière est un <a> (accessible au clavier)");
check(links.every((card) => card.getAttribute("target") === "_blank" && (card.getAttribute("rel") ?? "").includes("noopener")), "ouverture dans un nouvel onglet, sans accès à la page d'origine");
check(links.every((card) => /^https:\/\/ecampus\.paris-saclay\.fr\/course\/view\.php\?id=\d+$/.test(card.getAttribute("href"))), "toutes les URL pointent vers un cours eCampus officiel");
check(links.every((card) => /eCampus/.test(card.getAttribute("aria-label") ?? "")), "le lien est annoncé aux lecteurs d'écran");
check(links.every((card) => card.getAttribute("title")?.includes("cliquer pour ouvrir")), "l'info-bulle indique le clic");
check(links.every((card) => card.querySelector(".card-ext") !== null), "une icône signale le lien externe");

const expected = config.courseLinks;
const byFamily = new Map(links.map((card) => [card.dataset.cat, card.getAttribute("href")]));
check(byFamily.get("socio") === expected.socio, "Démographie → cours 229297");
check(byFamily.get("maths") === "https://ecampus.paris-saclay.fr/course/view.php?id=999999", "les URL de edt.config.json sont bien prises en compte (maths surchargé)");
check(byFamily.get("anglais") === expected.anglais, "Anglais → cours 230269");
check(byFamily.get("info") === expected.info, "SQL / bases de données → cours 231179");
check(byFamily.get("macro") === expected.macro, "Macroéconomie → cours 230499");
check(byFamily.get("micro") === expected.micro, "Microéconomie → cours 229574");
check(links.every((card) => Object.values(window.eval("COURSE_LINKS")).includes(card.getAttribute("href"))), "aucune URL piège n'est reprise de la configuration");
check(window.eval("courseLinkFor({source:'personal', cat:'maths', title:'RDV'})") === "", "un événement personnel n'est jamais un lien eCampus");

console.log("\n— impression : les titres restent cliquables —");
window.dispatchEvent(new window.Event("beforeprint"));
const printLinks = $$("#print .p-link");
check(printLinks.length > 0 && printLinks.every((a) => a.getAttribute("href").startsWith("https://ecampus.paris-saclay.fr/")), "le PDF conserve les liens des matières");

console.log("\n— on ne peut plus supprimer une matière en la maintenant —");
const official = $("#grid .card.is-link");
const dialog = $("#holdDialog");
dispatch(official, "pointerdown", { button: 0, clientX: 10, clientY: 10 });
await wait(620);
dispatch(official, "pointerup", { button: 0 });
check(dialog.hidden === true, "un appui long sur un cours n'ouvre plus aucune suppression");
const menuEvent = new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true });
official.dispatchEvent(menuEvent);
check(dialog.hidden === true && menuEvent.defaultPrevented === false, "le clic droit sur un cours reste le menu du navigateur");
check($("#resetHidden") === null && !/schedule_hidden/.test(window.localStorage.getItem("schedule_hidden") ?? ""), "l'ancien mécanisme « matières masquées » a disparu");

console.log("\n— les événements personnels, eux, restent supprimables —");
window.eval(`savePersonal([{ id: "perso-1", date: "2026-10-12", time: "18:00 - 19:00", startMin: 1080, endMin: 1140, type: "RDV", title: "Dentiste", cat: "personal", tag: "#santé" }])`);
window.eval("refreshCurrentView()");
const personal = $('#grid .card[data-source="personal"]');
check(personal !== null, "un événement personnel importé s'affiche");
check(personal?.tagName === "ARTICLE" && personal.getAttribute("href") === null, "il n'ouvre pas eCampus");
dispatch(personal.querySelector(".card-delete"), "click");
await wait(20);
check(dialog.hidden === false, "la croix × ouvre la confirmation de suppression");
dispatch($("#holdDelete"), "click");
await wait(20);
check(dialog.hidden === true, "la confirmation referme le dialogue");
check($('#grid .card[data-source="personal"]') === null && window.eval("loadPersonal().length") === 0, "l'événement est retiré de l'agenda et du navigateur");

console.log("\n— boutons ‹ › : un jour à la fois, week-end compris —");
check($("#dayNav") !== null && $("#prevDay") !== null && $("#nextDay") !== null, "la barre du bas contient les deux boutons");
check(/Lundi 12 oct\. 2026/.test(label()), `le jour affiché est annoncé (${label()})`);
window.eval("showDay('2026-10-12')");
check(/Lundi 12 oct\. 2026/.test(label()), "le lundi est le jour de référence");
dispatch($("#nextDay"), "click");
await wait(20);
check(/Mardi 13 oct\. 2026/.test(label()), `lundi → mardi (${label()})`);
check(weekendPanel() === null, "un jour ouvré garde la grille de la semaine");
dispatch($("#prevDay"), "click");
dispatch($("#prevDay"), "click");
await wait(20);
check(/Dimanche 11 oct\. 2026/.test(label()), `lundi → dimanche, comme demandé (${label()})`);
check(weekendPanel() !== null && weekendPanel().dataset.day === "6", "le dimanche s'affiche dans son propre panneau");
check($("#grid").classList.contains("single"), "le week-end occupe toute la largeur");
dispatch($("#prevDay"), "click");
await wait(20);
check(/Samedi 10 oct\. 2026/.test(label()) && weekendPanel()?.dataset.day === "5", "dimanche → samedi");
dispatch($("#prevDay"), "click");
await wait(20);
check(/Vendredi 9 oct\. 2026/.test(label()), "samedi → vendredi (semaine précédente)");
check(weekendPanel() === null && $$("#grid .day").length === 5, "on revient aux 5 jours de la semaine sans samedi de cours");
check(window.document.body.dataset.view === "day" && $$('#grid .day:not(.hidden)')[0]?.dataset.day === "4", "sur téléphone, seul le vendredi est affiché");

console.log("\n— bornes et retour à la semaine —");
window.eval("showDay(addDaysISO(state_view.weeks.at(-1), 6))");
await wait(20);
check($("#nextDay").disabled === true, "le dernier dimanche publié bloque le bouton ›");
const lastLabel = label();
dispatch($("#nextDay"), "click");
await wait(20);
check(label() === lastLabel, "cliquer sur un bouton désactivé ne change rien");
window.eval("showDay('2026-10-11')");
dispatch(window.document.querySelector('.tab[data-day="0"]'), "click");
await wait(20);
check(weekendPanel() === null && $$("#grid .day").length === 5, "un onglet ramène du week-end à la semaine sans samedi de cours");

console.log("\n— le navigateur retient les informations —");
window.eval("showDay('2026-10-14')");
check(window.localStorage.getItem("schedule_last_day") === "2026-10-14", "le dernier jour consulté est mémorisé");
check(window.eval("typeof CONFIG.myTd") === "string" && window.eval("typeof loadPersonal") === "function", "le TD et l'agenda personnel restent stockés localement");
check(window.localStorage.getItem("schedule_hidden") === null, "les anciennes règles de matières masquées sont effacées");

console.log("\n— samedi avec cours officiel : la semaine garde sa colonne —");
const satMonday = window.eval("displayedWeekKey()");
const satISO = window.eval(`addDaysISO("${satMonday}", 5)`);
const saturdayEvent = {
  id: "cm-samedi-nav",
  start: `${satISO}T09:40:00`,
  end: `${satISO}T11:10:00`,
  description: "CM\r\n\r\n<br />\r\n\r\nAMPHI G - FERMAT\r\n\r\n<br />\r\n\r\nLSMA302-Analyse et Algèbre linéaire 2 [LSMA302]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 [S3MIASHS]",
  eventCategory: "CM",
  backgroundColor: "#00FFFF",
  modules: ["LSMA302"],
};
window.eval(`(() => {
  state.weeks[${JSON.stringify(satMonday)}].events.push(${JSON.stringify(saturdayEvent)});
  state_view.recurring = findRecurringCancellations(state.weeks);
  refreshDisplayedWeek();
})()`);
window.eval(`showDay("${satISO}")`);
await wait(20);
check(/Samedi/.test(label()) && weekendPanel() === null, "le samedi de cours s'ouvre dans la grille, pas comme un week-end vide");
check($$("#grid .day").length === 6, "la colonne samedi est présente");
dispatch($("#nextDay"), "click");
await wait(20);
check(/Dimanche/.test(label()) && weekendPanel()?.dataset.day === "6", "samedi de cours → dimanche isolé");
dispatch($("#prevDay"), "click");
await wait(20);
check(/Samedi/.test(label()) && weekendPanel() === null && $$("#grid .day").length === 6, "dimanche → samedi de cours retrouve la colonne officielle");
dispatch($("#prevDay"), "click");
await wait(20);
check(/Vendredi/.test(label()) && weekendPanel() === null, "samedi de cours → vendredi reste dans la même semaine");

console.log("\n— erreurs JavaScript —");
check(errors.length === 0, `aucune erreur console (${errors.length})`);
errors.slice(0, 5).forEach((error) => console.log(`      ${error}`));

if (failures.length) {
  console.log(`\n❌ ${failures.length} échec(s)`);
  failures.forEach((failure) => console.log(`   - ${failure}`));
  process.exitCode = 1;
} else {
  console.log("\n✅ tout est vert");
}
