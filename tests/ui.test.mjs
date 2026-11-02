/**
 * Test d'interface mobile : agenda « Tous », calendrier (choix du mois puis
 * du jour), cartes compactes et ciel animé.
 *
 *   npm run test:ui        (nécessite : npm install)
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
  console.log("⚠️  jsdom n'est pas installé — test d'interface ignoré (npm install).");
  process.exit(0);
}

const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(await readFile(path.join(ROOT, "data", "edt.json"), "utf8"));

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
const visibleDays = () => $$("#grid .day").filter((day) => !day.classList.contains("hidden"));

console.log("\n— ouverture sur téléphone —");
check($("#grid .day") !== null, "la grille affiche des journées");
check(window.document.body.dataset.view === "day", "sur téléphone, l'app ouvre un seul jour (vue « jour »)");
check(visibleDays().length === 1, `une seule colonne visible à l'ouverture (${visibleDays().length})`);

console.log("\n— en-tête : mois abrégés —");
const longTitle = $("#weekTitle .title-long")?.textContent ?? "";
const shortTitle = $("#weekTitle .title-short")?.textContent ?? "";
console.log(`      titre long : ${longTitle}`);
console.log(`      titre court : ${shortTitle}`);
check(Boolean(longTitle) && Boolean(shortTitle), "le titre existe en version longue et en version courte");
check(/Semaine \d+/.test(longTitle), "la version longue indique le numéro de semaine");
check(/(janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc)\./.test(longTitle), "les mois sont abrégés dans le titre");
check(/^S\d+ · /.test(shortTitle), `la version téléphone est compacte (${shortTitle})`);
check($("#weekTitleBtn") !== null, "le titre est un bouton qui ouvre le calendrier");

console.log("\n— vue « Tous » sur téléphone —");
$('.tab[data-day="all"]').click();
await wait(30);
check(window.document.body.dataset.view === "all", "l'onglet « Tous » active la vue semaine");
check(visibleDays().length === 5, `les 5 jours sont affichés (${visibleDays().length})`);
check($$("#grid .day-head[data-day-head]").length === 5, "chaque en-tête de jour est actif (appui pour isoler un jour)");
check($$("#grid .card").every((card) => card.querySelector(".card-main")), "chaque carte a un contenu structuré (ligne d'agenda)");
const foot = $("#grid .day-foot")?.textContent ?? "";
check(/\d+ h( \d{2})? de cours · fin à \d{2}:\d{2}/.test(foot), `chaque journée annonce son volume horaire (${foot})`);
const firstTime = $("#grid .card-time");
check(Boolean(firstTime.querySelector(".ct-start")?.textContent) && Boolean(firstTime.querySelector(".ct-end")?.textContent), "l'heure est découpée début / fin pour la colonne mobile");
check(firstTime.querySelector(".ct-sep")?.textContent.trim() === "-", "le séparateur d'heure est conservé pour le texte");
check(/^[\d:]{5}\s+-\s+[\d:]{5}/.test((firstTime.textContent ?? "").replace(/[A-Za-zÉÈ]+$/, "").trim()) || / - /.test(firstTime.textContent), "le texte de l'heure reste lisible (« 09:40 - 11:10 »)");

const wednesday = $('#grid .day[data-day="2"] .day-head');
wednesday.click();
await wait(30);
check(window.document.body.dataset.view === "day", "un appui sur l'en-tête isole le jour");
check(visibleDays().length === 1 && visibleDays()[0].dataset.day === "2", "seul le mercredi reste affiché");
check($('.tab[data-day="2"]').classList.contains("active"), "l'onglet du jour suit la sélection");

console.log("\n— calendrier : choisir un mois précis —");
$('.tab[data-day="all"]').click();
$("#weekTitleBtn").click();
await wait(30);
check(!$("#calendarDialog").hidden, "le bouton du titre ouvre le calendrier");
check($("#calTitle").textContent === "Octobre 2026", `le mois affiché est celui de la semaine ouverte (${$("#calTitle").textContent})`);
check($$("#calMonths .cal-month").length === 12, "les 12 mois sont proposés");
check($$("#calGrid .cal-day").length === 42, "la grille couvre 6 semaines (42 jours)");
check($$("#calGrid .cal-day:not(:disabled)").length > 10, "les jours du semestre sont sélectionnables");
check($$("#calGrid .cal-day.weekend:disabled").length > 0, "les week-ends ne sont pas sélectionnables");
check($$("#calGrid .cal-day .cal-dot.has").length > 0, "les journées avec cours portent un point");
check($("#calGrid .cal-day.week-selected") !== null, "la semaine ouverte est mise en évidence");
check($$("#calGrid .cal-day.selected").length === 1, "le jour de référence est cerclé dans le calendrier");
check($(".cal-month.active")?.textContent === "Oct.", "le mois courant est actif dans la barre des mois");
const summary = $("#calSummary").textContent;
check(/\d+ séances? sur \d+ jours?/.test(summary), `le mois annonce son nombre de séances (${summary})`);

console.log("\n— calendrier : sauter à un jour précis —");
$('#calGrid .cal-day[data-date="2026-10-21"]').click();
await wait(60);
check($("#calendarDialog").hidden, "le calendrier se referme après le choix");
check(/19–23 oct\./.test($("#weekTitle .title-long").textContent), `la semaine du 19 octobre est affichée (${$("#weekTitle .title-long").textContent})`);
check(visibleDays().length === 1 && visibleDays()[0].dataset.day === "2", "sur téléphone, le jour choisi (mercredi) est isolé");
check($('#grid .day[data-day="2"] .day-date time')?.dateTime === "2026-10-21", "la date ouverte est bien le 21 octobre");

console.log("\n— calendrier : navigation par mois et par année —");
$("#weekTitleBtn").click();
await wait(20);
$('#calMonths [data-month="11"]').click();
await wait(20);
check($("#calTitle").textContent === "Décembre 2026", `le mois choisi s'affiche (${$("#calTitle").textContent})`);
check($(".cal-month.active")?.textContent === "Déc.", "le mois sélectionné est actif");
const decDays = $$('#calGrid .cal-day:not(:disabled):not(.outside)').length;
check(decDays > 10, `décembre propose ses journées de cours (${decDays})`);

$("#calNextMonth").click();
$("#calNextMonth").click();
await wait(20);
check($("#calTitle").textContent === "Janvier 2027", `on atteint janvier, publié par la synchro (${$("#calTitle").textContent})`);
check($("#calNextMonth").disabled === true && $("#calNextYear").disabled === true, "la navigation s'arrête à la dernière semaine publiée");
$("#calPrevYear").click();
await wait(20);
check($("#calTitle").textContent === "Août 2026", `le recul d'un an reste borné au premier mois publié (${$("#calTitle").textContent})`);
check($("#calPrevMonth").disabled === true, "le mois le plus ancien disponible est borné");

console.log("\n— calendrier : retour à aujourd'hui et clavier —");
$("#calToday").click();
await wait(60);
check($("#calendarDialog").hidden, "« Aujourd'hui » referme le calendrier");
check(/5–9 oct\.|12–16 oct\./.test($("#weekTitle .title-long").textContent), `la semaine du jour est ouverte (${$("#weekTitle .title-long").textContent})`);

$("#weekTitleBtn").click();
await wait(20);
const focused = window.document.activeElement;
check(focused?.classList.contains("cal-day"), "l'ouverture place le focus sur un jour du calendrier");
window.document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await wait(20);
check($("#calendarDialog").hidden, "Échap referme le calendrier");

console.log("\n— en-tête accessible —");
check($("#weekTitleBtn").getAttribute("aria-haspopup") === "dialog", "le bouton du titre annonce un dialogue");
check($("#weekTitleBtn").getAttribute("aria-controls") === "calendarDialog", "le bouton du titre pointe vers le calendrier");
check($("#calTitle").getAttribute("id") === "calTitle" && $(".cal-panel").getAttribute("role") === "dialog", "le panneau est un dialogue accessible");

console.log("\n— cartes annulées sur téléphone —");
const cancelled = $("#grid .card.cancelled");
check(cancelled === null || cancelled.querySelector(".card-flag") !== null, "une carte annulée affiche son étiquette dédiée sur téléphone");

console.log("\n— ciel de nuit : étoiles filantes —");
check($("#sky") !== null && $("#skyMeteors") !== null, "la couche « ciel » existe");
check(/@keyframes meteor-fly/.test(html) && /\.meteor\{/.test(html), "les étoiles filantes sont animées en CSS");
check(/prefers-reduced-motion:reduce\)\{\s*\n?\s*\.meteor/.test(html), "les animations sont coupées si l'utilisateur préfère réduire les mouvements");
window.document.documentElement.dataset.theme = "dark";
window.startSky();
window.spawnMeteor("star");
await wait(10);
const meteor = $("#skyMeteors .meteor");
check(meteor !== null, "une étoile filante est créée en mode sombre");
const meteorStyle = meteor?.getAttribute("style") ?? "";
check(/--angle:\s*[\d.]+deg/.test(meteorStyle) && /--dur:\s*[\d.]+s/.test(meteorStyle) && /--travel:\s*[\d.]+vw/.test(meteorStyle), "sa trajectoire et sa durée varient à chaque passage");
window.stopSky();
check($$("#skyMeteors .meteor").length === 0, "passer en thème clair (ou masquer l'onglet) nettoie le ciel");
window.document.documentElement.dataset.theme = "light";

console.log("\n— verre dépoli en mode sombre —");
check(/\[data-theme="dark"\] \.card\.maths\{background:color-mix\(in srgb,var\(--maths-bg\) 74%,transparent\)\}/.test(html), "les cartes de matière laissent voir le ciel (transparence légère)");
check(/\[data-theme="dark"\] \.day\{background:color-mix\(in srgb,var\(--surface\) 46%,transparent\)\}/.test(html), "les colonnes sont translucides en mode sombre");
check(/\[data-theme="dark"\] \.bar\{background:color-mix\(in srgb,var\(--surface\) 62%,transparent\)\}/.test(html), "la barre d'outils est translucide en mode sombre");

console.log("\n— mise en page mobile —");
check(/body\[data-view="all"\] \.day-head\{cursor:pointer\}/.test(html), "les en-têtes sont cliquables en vue « Tous »");
check(/\.day-head\{\s*\n\s*position:sticky/.test(html), "les en-têtes de jour restent visibles pendant le défilement");
check(/\.ct-sep\{display:none\}/.test(html), "sur téléphone, l'heure s'affiche sur deux lignes");
check(/\.grid\{[\s\S]{0,200}display:flex;[\s\S]{0,80}flex-direction:column;/.test(html), "la grille mobile empile les jours en colonne");

console.log("\n— erreurs JavaScript —");
check(errors.length === 0, `aucune erreur console (${errors.length})`);
if (errors.length) errors.forEach((error) => console.log(`      ${error}`));

if (failures.length) {
  console.log(`\n❌ ${failures.length} échec(s)`);
  failures.forEach((failure) => console.log(`   - ${failure}`));
  process.exitCode = 1;
} else {
  console.log("\n✅ tout est vert");
}
