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
  const months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const targetWeekStart = `${date.getDate()}–`;
  check(title.includes(targetWeekStart) && title.includes(months[date.getMonth()]), `la semaine de la journée ciblée est affichée (${targetWeekStart}… ${months[date.getMonth()]})`);
}

console.log("\n— interface simplifiée —");
check(!$(".legend") && !/Repères\s*:/i.test(window.document.body.textContent), "la section « Repères » a été supprimée");
check(!$("#changes") && !/1 séance annulée/i.test(window.document.body.textContent), "aucun encart global ni liste d'annulations");
// data/edt.json ne contient pas de journal de changements : rien à signaler, donc
// ni bandeau ni cloche (le comportement « il y a du nouveau » est couvert par
// tests/changes.test.mjs, qui alimente la page avec un planning modifié).
check($("#changeBanner") !== null && $("#changeBanner").hidden, "sans changement détecté, le bandeau reste masqué");
check($("#changesBtn") !== null && $("#changesBtn").hidden, "sans changement détecté, la cloche reste masquée");
check(!$("#liveBanner") && !$("#liveStatus") && !/synchro GitHub/i.test(window.document.body.textContent), "le statut de synchronisation n'est plus affiché");
check(!$(".week-progress") && !$("#weekProgress"), "la barre de progression hebdomadaire a été supprimée");
check(!$("#refresh") && !/Actualiser|refreshCurrentWeek/.test(html), "le bouton et le code de rafraîchissement manuel ont été supprimés");
check(!scheduledIntervals.some(({ delay }) => delay === 5 * 60 * 1000 || delay === 60 * 1000), "aucune actualisation automatique après le chargement");

console.log("\n— annulation détectée (CM de BDD du 1er octobre) —");
let back = 0;
for (; back < 8 && !/28 sept\./.test($("#weekTitle").textContent); back++) $("#prev").click();
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

console.log("\n— mobile : le double-tap ne zoome plus, mode sombre étoilé —");
check(/button,a,select,\[role="button"\],\.card\{touch-action:manipulation\}/.test(html), "touch-action:manipulation sur les contrôles (double-tap sans zoom, flèches ‹ › comprises)");
check(/\[data-theme="dark"\] body::before/.test(html) && /@keyframes star-twinkle/.test(html), "mode sombre : fond étoilé discret (body::before/::after + scintillement)");
check(/\.app\{[^}]*z-index:1/.test(html), "le contenu de l'app passe au-dessus du fond étoilé");
check(/@media print\{body::before,body::after,\.sky\{display:none!important\}/.test(html), "le fond étoilé et le ciel animé ne sont pas imprimés");

console.log("\n— mise en page sans défilement de page —");
// Aucun contrôle ne doit déplacer la page : la barre d'outils et les onglets
// restent visibles, seul le conteneur #grid peut défiler (mobile).
let pageScrolls = 0;
window.scrollTo = () => { pageScrolls++; };
$("#today").click();
$("#next").click();
$("#prev").click();
check(pageScrolls === 0, `changer de jour ou de semaine ne fait pas défiler la page (${pageScrolls} appel(s))`);
check(!/window\.scrollTo|\bscrollY\b|documentElement\.scrollTop/.test(html), "le code n'appelle plus window.scrollTo pour caler le planning");
check(/100dvh/.test(html) && /overflow:hidden/.test(html), "l'application est verrouillée sur la hauteur de l'écran");

const body = $("#grid .day .day-body");
check(body !== null, "les colonnes ont une piste horaire");
const firstCard = $("#grid .card");
const cardStyle = firstCard?.getAttribute("style") ?? "";
check(/--top:[\d.]+/.test(cardStyle) && /--h:[\d.]+/.test(cardStyle), `la carte est placée en pourcentage (${cardStyle})`);
const cardTop = Number((cardStyle.match(/--top:([\d.]+)/) ?? [])[1]);
const cardHeight = Number((cardStyle.match(/--h:([\d.]+)/) ?? [])[1]);
check(cardTop >= 0 && cardTop < 100 && cardHeight > 0 && cardTop + cardHeight <= 100.001, "la carte tient entièrement dans la journée affichée");
const hours = [...window.document.querySelectorAll("#grid .hour-scale span")];
check(hours.length >= 8 && hours.every((span) => /%$/.test(span.getAttribute("style").split(":").slice(1).join(":").trim())), `${hours.length} repères horaires positionnés en pourcentage`);

console.log("\n— boutons : icônes nettes, plus d'emoji —");
check($("#prev svg") !== null && $("#next svg") !== null, "les flèches utilisent des icônes SVG");
check($("#moreBtn svg") !== null && $("#moreBtn").textContent.trim() === "", "le bouton d'options est une icône seule");
check($("#moreMenu #theme svg") !== null && $("#themeLabel") !== null, "le basculement de thème a une icône et un libellé");
check($("#importClose").classList.contains("btn") && $("#importRun").classList.contains("btn"), "les boutons de la boîte d'import sont stylés");
check($("#importRun svg") !== null && $("#importClose svg") === null, "le bouton Importer porte une icône");
check($("#holdDelete").classList.contains("danger") && $("#holdCancel").classList.contains("btn"), "les boutons de confirmation sont stylés");
const emojiInButtons = [...window.document.querySelectorAll("button")].filter((button) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(button.textContent));
check(emojiInButtons.length === 0, `aucun emoji dans les boutons (${emojiInButtons.map((b) => b.textContent.trim()).join(" | ")})`);

console.log("\n— le calendrier ne s'arrête pas fin décembre —");
// 0. les semaines publiées par la synchro restent navigables même vides :
// data/edt.json contient déjà les semaines de janvier (pas encore de cours)
const publishedWeeks = window.eval("buildWeekList()");
check(publishedWeeks.includes("2027-01-11"), `une semaine de janvier publiée mais vide est proposée (${publishedWeeks[0]} → ${publishedWeeks.at(-1)})`);
check(publishedWeeks.at(-1) >= "2027-01-04", "la navigation atteint janvier avec les données publiées seules");
// 1. la liste des semaines va chercher les données publiées au-delà du semestre
// une semaine de janvier publiée par la synchro, après la fin du semestre S3
const weeks = window.eval(`(() => {
  state.weeks["2027-01-04"] = { monday: "2027-01-04", events: [{ id: "x", start: "2027-01-04T09:00:00", end: "2027-01-04T10:00:00" }] };
  return buildWeekList();
})()`);
check(weeks.includes("2027-01-04"), `les semaines de janvier sont proposées (${weeks[0]} → ${weeks.at(-1)})`);
check(weeks.at(-1) >= "2026-12-14", "la navigation va au-delà du 19 décembre");
const sem = window.eval("currentSemester([{id:'S3',group:'S3MIASHS',tdGroup:'S3MIASHS TD 2',start:'2026-09-14',end:'2026-12-19'},{id:'S4',group:'S4MIASHS',tdGroup:'S4MIASHS TD 2',start:'2027-01-04',end:'2027-05-08'}], '2027-02-10')");
check(sem?.id === "S4", `en février, le semestre courant est le S4 (${sem?.id})`);
check(window.eval("tdChoiceFor('S4MIASHS', 'S3MIASHS TD 2')") === "S4MIASHS TD 2", "le numéro de TD choisi suit le changement de semestre");
const feb = window.eval("emptyMessage('2027-02-02', 1, false, 'none')");
check(/Pas encore publié/.test(feb), `une semaine future non publiée est annoncée comme telle (« ${feb} »)`);
const spring = window.eval("emptyMessage('2027-04-06', 1, false, 'reference')");
check(!/vacances|libre/i.test(spring) || /hors période/i.test(spring), "aucune vacance n'est inventée hors semestre");

console.log("\n— impression —");
window.dispatchEvent(new window.Event("beforeprint"));
const printHtml = $("#print").innerHTML;
check(printHtml.includes('class="print-table"'), "la page d'impression utilise le tableau attendu");
check(printHtml.includes("Semaine 1") && printHtml.includes("Semaine 13"), "les 13 semaines du semestre sont imprimées");
check(!/Page 1 \/ 2/.test(printHtml) || window.document.querySelectorAll("#print .print-page").length >= 1, "l'impression n'est pas figée à deux pages");
check(window.document.querySelectorAll("#print .print-page").length >= 2, "l'impression découpe autant de pages que nécessaire");

console.log("\n— erreurs JavaScript —");
check(errors.length === 0, `aucune erreur console (${errors.length})`);
errors.slice(0, 5).forEach((error) => console.log(`      ${error}`));

console.log(`\n${failures.length ? `❌ ${failures.length} échec(s)` : "✅ tout est vert"}`);
process.exit(failures.length ? 1 : 0);
