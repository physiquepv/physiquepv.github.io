#!/usr/bin/env node
/**
 * Tests du noyau de l'emploi du temps (index.html, section CORE-START/END).
 *
 *   node tests/edt.test.mjs
 *
 * Les cas s'appuient sur data/edt.json, c'est-à-dire sur la réponse réelle de
 * CELCAT (groupe S3MIASHS), pour vérifier que le parsing, le filtrage du TD et
 * la détection des annulations correspondent bien au planning officiel.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* --------------------------------------------------------------- helpers */
function loadCore(source) {
  const start = source.indexOf("CORE-START");
  const end = source.indexOf("CORE-END");
  assert.ok(start > 0 && end > start, "marqueurs CORE-START / CORE-END introuvables");
  const code = source.slice(source.indexOf("*/", start) + 2, source.lastIndexOf("/*", source.indexOf("CORE-END")));
  const factory = new Function(`${code}; return { parseEvent, isMyCourse, changeAppliesToTd, buildWeek, weeksFromEvents, findRecurringCancellations, normalizeGroupCode, decodeEntities, mondayOf, addDaysISO, nextWeekdayISO, openingDateISO, slotOf, familyOf, CONFIG, fallbackWeeks };`);
  return factory();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------ tests */
test("decodeEntities gère les entités numériques et nommées", (core) => {
  assert.equal(core.decodeEntities("Initiation aux bases de donn&#233;es"), "Initiation aux bases de données");
  assert.equal(core.decodeEntities("Physique &amp; Chimie"), "Physique & Chimie");
});

test("parseEvent lit un CM réel (type, matière, salle, groupes)", (core, data) => {
  const raw = data.weeks["2026-09-28"].events.find((event) => event.start === "2026-09-28T09:40:00");
  const parsed = core.parseEvent(raw);
  assert.equal(parsed.type, "CM");
  assert.equal(parsed.title, "Sociologie : démographie");
  assert.equal(parsed.room, "2203 - FERMAT");
  assert.equal(parsed.cancelled, false);
  assert.equal(parsed.date, "2026-09-28");
  assert.equal(parsed.time, "09:40 - 11:10");
  assert.equal(parsed.cat, "socio");
  assert.equal(parsed.groups.length, 1);
  assert.match(parsed.groups[0], /S3MIASHS/);
});

test("parseEvent reconnaît une annulation (#333333, catégorie « Annulation »)", (core, data) => {
  const raw = Object.values(data.weeks).flatMap((week) => week.events).find((event) => event.eventCategory === "Annulation" || event.backgroundColor === "#333333");
  const parsed = core.parseEvent(raw);
  assert.equal(parsed.cancelled, true);
  assert.ok(parsed.title.length > 0, "le titre de la matière annulée est conservé");
});

test("isMyCourse garde la promo et le TD 02, écarte les autres TD", (core, data) => {
  const events = Object.values(data.weeks).flatMap((week) => week.events);
  const td1 = events.find((event) => event.description.includes("[S3MIASHS TD 1]") && !event.description.includes("TD 2"));
  const td2 = events.find((event) => event.description.includes("[S3MIASHS TD 2]") && !event.description.includes("TD 1"));
  const promo = events.find((event) => event.description.includes("( S3MIASHS )"));
  assert.equal(core.isMyCourse(core.parseEvent(td1)), false, "un TD du groupe 1 ne doit pas s'afficher");
  assert.equal(core.isMyCourse(core.parseEvent(td2)), true, "le TD 02 doit s'afficher");
  assert.equal(core.isMyCourse(core.parseEvent(promo)), true, "les cours de promo doivent s'afficher");
});

test("buildWeek filtre et étiquette correctement la semaine du 28/09", (core, data) => {
  const raw = data.weeks["2026-09-28"].events;
  const reference = core.fallbackWeeks.find((week) => week.monday === "2026-09-28");
  const recurring = core.findRecurringCancellations(data.weeks);
  const view = core.buildWeek("2026-09-28", raw, reference, { live: true, recurringCancellations: recurring });
  const [monday, tuesday, wednesday, thursday, friday] = view.days;

  assert.deepEqual(monday.courses.map((course) => course.title), ["Sociologie : démographie", "Sociologie : démographie", "Microéconomie 2"]);
  assert.equal(monday.courses[2].tag, "Votre TD 02"); // étiquette héritée de la référence
  assert.equal(monday.courses[1].tag, "TD Promo réunie (TD 1 & 2)");
  assert.ok(!monday.courses.some((course) => course.time.startsWith("13:50")), "le TD du groupe 1 ne doit pas apparaître");

  assert.deepEqual(tuesday.courses.map((course) => course.time), ["08:00 - 09:30", "09:40 - 11:10", "11:20 - 12:50"]);
  assert.ok(!tuesday.courses.some((course) => course.isCancelled), "le créneau d'anglais annulé en permanence est masqué");
  assert.ok(tuesday.courses.some((course) => course.title === "Macroéconomie 2" && course.tag === "CM Promo"));

  assert.equal(thursday.courses.length, 3);
  assert.ok(thursday.courses.some((course) => course.type === "TD Cartable Numérique" && course.room.includes("RC22")));
  assert.equal(friday.courses.length, 1);
  assert.equal(wednesday.courses.length, 2);
  assert.ok(wednesday.courses.some((course) => course.title === "Analyse 2 & Algèbre linéaire 2" && course.room.includes("AMPHI G")), "le TD de maths du TD 02 est bien présent");
  assert.equal(view.days.flatMap((day) => day.courses).filter((course) => course.isCancelled).length, 1);
  assert.equal(view.days.flatMap((day) => day.courses).length, 12);
});

test("buildWeek signale une annulation qui touche un cours prévu", (core, data) => {
  const raw = data.weeks["2026-09-28"].events;
  const reference = core.fallbackWeeks.find((week) => week.monday === "2026-09-28");
  const view = core.buildWeek("2026-09-28", raw, reference, { live: true, recurringCancellations: core.findRecurringCancellations(data.weeks) });
  const card = view.days[3].courses.find((course) => course.isCancelled);
  assert.ok(card, "la carte annulée est affichée");
  assert.equal(card.title, "Initiation bases de données");
  assert.equal(card.date, "2026-10-01");
  assert.equal(card.type, "CM");
  assert.equal(card.tagType, "cancelled");
  assert.match(card.tag, /annul/i);
});

test("les vacances de la Toussaint restent vides (pas de faux fantômes)", (core, data) => {
  const empty = data.weeks["2026-10-26"];
  assert.ok(empty);
  assert.equal(empty.events.length, 0);
  const reference = core.fallbackWeeks.find((week) => week.monday === "2026-10-26") ?? null;
  const view = core.buildWeek("2026-10-26", empty.events, reference, { live: true });
  assert.ok(view.days.flatMap((day) => day.courses).every((course) => !course.ghost));
  assert.equal(view.days.flatMap((day) => day.courses).length, 0);
});

test("un cours absent du planning officiel n'est pas inventé", (core, data) => {
  const raw = data.weeks["2026-12-07"].events;
  const reference = core.fallbackWeeks.find((week) => week.monday === "2026-12-07");
  const view = core.buildWeek("2026-12-07", raw, reference, { live: true, recurringCancellations: core.findRecurringCancellations(data.weeks) });
  const courses = view.days.flatMap((day) => day.courses);
  assert.ok(courses.every((course) => !course.ghost), "le site officiel fait foi : pas de carte « à vérifier »");
  assert.ok(!courses.some((course) => course.title === "Anglais UE2" && course.date === "2026-12-09"), "l'anglais absent de CELCAT n'est pas réinventé");
});

test("sans données live, la semaine de secours est utilisée telle quelle", (core) => {
  const reference = core.fallbackWeeks[0];
  const view = core.buildWeek("2026-09-14", [], reference, { live: false });
  assert.equal(view.live, false);
  assert.equal(view.days[0].courses.length, 2);
  assert.ok(view.days[0].courses.every((course) => course.source === "reference" && !course.ghost));
});

test("le TD 1 n'affiche pas les créneaux ni les étiquettes du TD 2", (core, data) => {
  const previous = core.CONFIG.myTd;
  core.CONFIG.myTd = "S3MIASHS TD 1";
  try {
    const raw = data.weeks["2026-09-28"].events;
    const reference = core.fallbackWeeks.find((week) => week.monday === "2026-09-28");
    const recurring = core.findRecurringCancellations(data.weeks);
    const view = core.buildWeek("2026-09-28", raw, reference, { live: true, recurringCancellations: recurring });
    const courses = view.days.flatMap((day) => day.courses);
    const monday = view.days[0].courses;
    const wednesday = view.days[2].courses;
    const friday = view.days[4].courses;

    assert.ok(monday.some((course) => course.time.startsWith("13:50") && course.cat === "micro"), "le micro du TD 1 (13:50) doit s'afficher");
    assert.ok(!monday.some((course) => course.time.startsWith("15:30")), "le micro du TD 2 (15:30) ne doit pas s'afficher");
    assert.ok(wednesday.some((course) => course.cat === "info" && course.time.startsWith("09:40")), "le TD info du mercredi appartient au TD 1");
    assert.ok(!wednesday.some((course) => course.cat === "maths"), "le TD de maths du mercredi est celui du TD 2");
    assert.ok(friday.some((course) => course.cat === "maths" && course.time.startsWith("09:40")), "le TD de maths du TD 1 est le vendredi");
    assert.ok(courses.some((course) => course.title === "Sociologie : démographie"), "les cours de promo restent visibles");
    assert.ok(!courses.some((course) => /TD 02/.test(`${course.tag ?? ""} ${course.title}`)), "aucune étiquette TD 02");
    assert.ok(!courses.some((course) => course.ghost && /TD 02|15:30 - 17:00/.test(`${course.tag ?? ""} ${course.time}`)), "pas de fantôme issu du TD 2");

    const offline = core.buildWeek("2026-09-28", [], reference, { live: false });
    const offlineCourses = offline.days.flatMap((day) => day.courses);
    assert.ok(!offlineCourses.some((course) => /TD 02/.test(course.tag ?? "")), "le secours hors-ligne du TD 1 n'emprunte pas le TD 2");
    assert.ok(offlineCourses.some((course) => course.time.startsWith("13:50") && course.cat === "micro"));
  } finally {
    core.CONFIG.myTd = previous;
  }
});

test("CONFIG cible bien le groupe S3MIASHS et son TD", (core) => {
  assert.equal(core.CONFIG.group, "S3MIASHS");
  assert.equal(core.CONFIG.myTd, "S3MIASHS TD 2");
  assert.equal(core.normalizeGroupCode("S3MIASHS TD 02"), core.normalizeGroupCode("S3MIASHS TD 2"));
});

test("weeksFromEvents regroupe par lundi", (core, data) => {
  const weeks = core.weeksFromEvents(data.weeks["2026-10-05"].events);
  assert.deepEqual(Object.keys(weeks), ["2026-10-05"]);
  assert.equal(weeks["2026-10-05"].events.length, data.weeks["2026-10-05"].events.length);
});

test("mondayOf / addDaysISO sont justes (bords de mois et d'année)", (core) => {
  assert.equal(core.mondayOf("2026-10-01"), "2026-09-28");
  assert.equal(core.mondayOf("2026-10-04"), "2026-09-28");
  assert.equal(core.mondayOf("2026-10-05"), "2026-10-05");
  assert.equal(core.addDaysISO("2026-12-31", 1), "2027-01-01");
  assert.equal(core.addDaysISO("2026-03-01", -1), "2026-02-28");
  assert.equal(core.slotOf(9 * 60 + 40, 11 * 60 + 10), "09:40 - 11:10");
});

test("openingDateISO avance après la dernière heure et saute le week-end", (core) => {
  const at = (year, month, day, hour, minute) => new Date(year, month - 1, day, hour, minute);
  const endAt17 = 17 * 60;
  const endAt19 = 19 * 60;

  assert.equal(core.openingDateISO(at(2026, 10, 7, 16, 59), endAt17), "2026-10-07");
  assert.equal(core.openingDateISO(at(2026, 10, 7, 17, 0), endAt17), "2026-10-08");
  assert.equal(core.openingDateISO(at(2026, 10, 9, 16, 59), endAt17), "2026-10-09");
  assert.equal(core.openingDateISO(at(2026, 10, 9, 17, 0), endAt17), "2026-10-12", "vendredi soir, on passe directement au lundi");
  assert.equal(core.openingDateISO(at(2026, 10, 10, 9, 0), endAt17), "2026-10-12", "samedi, le lundi est sélectionné");
  assert.equal(core.openingDateISO(at(2026, 10, 11, 9, 0), endAt17), "2026-10-12", "dimanche, le lundi est sélectionné");
  assert.equal(core.openingDateISO(at(2026, 10, 22, 18, 59), endAt19), "2026-10-22", "un cours tardif maintient la journée sélectionnée");
  assert.equal(core.openingDateISO(at(2026, 10, 22, 19, 0), endAt19), "2026-10-23");
});

test("parseEvent isole les noms d'enseignants CELCAT (mode LDAP) sans fausser salle, groupe ni annulation", (core) => {
  const authedRaw = {
    id: "authed-1",
    start: "2026-11-02T09:40:00",
    end: "2026-11-02T11:10:00",
    description:
      "TD\r\n\r\n<br />\r\n\r\n2206 - FERMAT\r\n\r\n<br />\r\n\r\nLSEC311*-Microéconomie 2 [LSEC311*]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 TD 2 [S3MIASHS TD 2]\r\n\r\n<br />\r\n\r\nGERMAIN, Paul<br />Ouedraogo, Adama<br />Vilaca Da Rocha, Victor<br />FERM&#201;, Marc [MFERME]\r\n\r\n<br />\r\n\r\n\r\n",
    eventCategory: "TD",
    backgroundColor: "#FFFF00",
    modules: ["LSEC311*"],
  };
  const parsed = core.parseEvent(authedRaw);
  assert.equal(parsed.room, "2206 - FERMAT", "GERMAIN / LASALLE ne deviennent pas des salles");
  assert.equal(parsed.cancelled, false, "FERMÉ ne déclenche pas une fausse annulation");
  assert.deepEqual(parsed.groups, ["L2 MIASHS S3 TD 2 [S3MIASHS TD 2]"], "[MFERME] ne pollue pas les groupes étudiants");
  assert.equal(parsed.teacher, "", "aucun champ teacher : rien n'est affiché (la page n'invente rien)");

  // La synchro publie les noms dans le champ structuré `teacher` (prénom nom).
  const withTeacher = core.parseEvent({ ...authedRaw, teacher: "Paul GERMAIN / Marc FERMÉ" });
  assert.equal(withTeacher.teacher, "Paul GERMAIN / Marc FERMÉ", "le champ teacher est repris tel quel sur la carte");

  const cancelledWithNote = {
    ...authedRaw,
    description: authedRaw.description.replace(/\r\n$/, "Cours annulé, enseignant absent\r\n"),
  };
  assert.equal(core.parseEvent(cancelledWithNote).cancelled, true, "une note d'absence avec virgule reste détectée");
});

test("isMyCourse et changeAppliesToTd couvrent S3 + S4 avec le numéro de TD choisi", (core) => {
  const cfg = {
    group: "S3MIASHS",
    myTd: "S3MIASHS TD 2",
    semesters: [
      { id: "S3", group: "S3MIASHS", tdGroup: "S3MIASHS TD 2", start: "2026-09-14", end: "2026-12-19" },
      { id: "S4", group: "S4MIASHS", tdGroup: "S4MIASHS TD 2", start: "2027-01-04", end: "2027-05-08" },
    ],
  };
  const s4Promo = core.parseEvent({
    id: "s4-cm",
    start: "2027-01-05T09:40:00",
    end: "2027-01-05T11:10:00",
    description: "CM\r\n\r\n<br />\r\n\r\nAMPHI G - FERMAT\r\n\r\n<br />\r\n\r\nLSIN400-Algo S4 [LSIN400]\r\n\r\n<br />\r\n\r\nL2 MIASHS S4 [S4MIASHS]",
    eventCategory: "CM",
    backgroundColor: "#00FFFF",
    modules: ["LSIN400"],
  });
  const s4Td2 = core.parseEvent({
    id: "s4-td2",
    start: "2027-01-05T13:50:00",
    end: "2027-01-05T15:20:00",
    description: "TD\r\n\r\n<br />\r\n\r\n2206 - FERMAT\r\n\r\n<br />\r\n\r\nLSIN400-Algo S4 [LSIN400]\r\n\r\n<br />\r\n\r\nL2 MIASHS S4 TD 2 [S4MIASHS TD 2]",
    eventCategory: "TD",
    backgroundColor: "#FFFF00",
    modules: ["LSIN400"],
  });
  const s4Td1 = core.parseEvent({
    id: "s4-td1",
    start: "2027-01-05T13:50:00",
    end: "2027-01-05T15:20:00",
    description: "TD\r\n\r\n<br />\r\n\r\n2206 - FERMAT\r\n\r\n<br />\r\n\r\nLSIN400-Algo S4 [LSIN400]\r\n\r\n<br />\r\n\r\nL2 MIASHS S4 TD 1 [S4MIASHS TD 1]",
    eventCategory: "TD",
    backgroundColor: "#FFFF00",
    modules: ["LSIN400"],
  });
  assert.equal(core.isMyCourse(s4Promo, cfg), true, "les CM S4 sont visibles dès leur publication");
  assert.equal(core.isMyCourse(s4Td2, cfg), true, "le TD 2 du S4 suit le choix TD 2");
  assert.equal(core.isMyCourse(s4Td1, cfg), false, "le TD 1 du S4 reste filtré");
  assert.equal(core.changeAppliesToTd({ groups: ["S4MIASHS TD 2"] }, cfg), true);
  assert.equal(core.changeAppliesToTd({ groups: ["S4MIASHS TD 1"] }, cfg), false);
});

test("buildWeek ajoute le samedi seulement quand un cours officiel le concerne", (core) => {
  const saturday = {
    id: "cm-samedi",
    start: "2026-11-14T09:40:00",
    end: "2026-11-14T11:10:00",
    description: "CM\r\n\r\n<br />\r\n\r\nAMPHI G - FERMAT\r\n\r\n<br />\r\n\r\nLSMA302-Analyse et Algèbre linéaire 2 [LSMA302]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 [S3MIASHS]",
    eventCategory: "CM",
    backgroundColor: "#00FFFF",
    modules: ["LSMA302"],
  };
  const view = core.buildWeek("2026-11-09", [saturday], null, { live: true });
  assert.equal(view.days.length, 6, "la semaine publiée du samedi a six journées");
  assert.equal(view.days[5].name, "Samedi");
  assert.equal(view.days[5].courses.length, 1);
  assert.equal(view.days[5].courses[0].date, "2026-11-14");
  assert.equal(view.days[5].courses[0].title, "Analyse et Algèbre linéaire 2");

  const empty = core.buildWeek("2026-11-09", [], null, { live: true });
  assert.equal(empty.days.length, 5, "pas de colonne samedi vide inventée");
  const offline = core.buildWeek("2026-11-09", [saturday], core.fallbackWeeks[0], { live: false });
  assert.equal(offline.days.length, 5, "le secours hors-ligne ne réinvente pas le samedi");
});

test("buildWeek filtre le samedi par TD et signale une annulation ponctuelle", (core) => {
  const td1 = {
    id: "td1-samedi",
    start: "2026-11-14T13:50:00",
    end: "2026-11-14T15:20:00",
    description: "TD\r\n\r\n<br />\r\n\r\n2206 - FERMAT\r\n\r\n<br />\r\n\r\nLSEC311-Microéconomie 2 [LSEC311]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 TD 1 [S3MIASHS TD 1]",
    eventCategory: "TD",
    backgroundColor: "#FFFF00",
    modules: ["LSEC311"],
  };
  assert.equal(core.buildWeek("2026-11-09", [td1], null, { live: true }).days.length, 5, "le TD 2 ne voit pas le samedi du TD 1");
  const previous = core.CONFIG.myTd;
  core.CONFIG.myTd = "S3MIASHS TD 1";
  try {
    assert.equal(core.buildWeek("2026-11-09", [td1], null, { live: true }).days.length, 6, "le TD 1 voit son samedi");
  } finally {
    core.CONFIG.myTd = previous;
  }

  const cancelled = { ...td1, id: "annulation-samedi", eventCategory: "Annulation", backgroundColor: "#333333", description: td1.description.replace(/^TD/, "Annulation").replace(/TD 1/g, "TD 2") };
  const oneOff = core.buildWeek("2026-11-09", [cancelled], null, { live: true });
  assert.equal(oneOff.days.length, 6, "une annulation ponctuelle du samedi reste visible");
  assert.equal(oneOff.days[5].courses[0].isCancelled, true);

  const weeks = {};
  for (const monday of ["2026-11-09", "2026-11-16", "2026-11-23"]) {
    const saturday = core.addDaysISO(monday, 5);
    weeks[monday] = { monday, events: [{ ...cancelled, id: `rec-${monday}`, start: `${saturday}T13:50:00`, end: `${saturday}T15:20:00` }] };
  }
  const recurring = core.findRecurringCancellations(weeks);
  const suspended = core.buildWeek("2026-11-09", weeks["2026-11-09"].events, null, { live: true, recurringCancellations: recurring });
  assert.equal(suspended.days.length, 5, "un créneau du samedi suspendu en permanence n'ouvre pas de colonne vide");
});

test("weeksFromEvents rattache un cours du samedi au lundi de sa semaine", (core) => {
  const weeks = core.weeksFromEvents([{ id: "sam", start: "2026-11-14T09:40:00", end: "2026-11-14T11:10:00", description: "CM\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 [S3MIASHS]" }]);
  assert.deepEqual(Object.keys(weeks), ["2026-11-09"]);
  assert.equal(weeks["2026-11-09"].events.length, 1);
});

/* ------------------------------------------------------------------ runner */
const html = await readFile(path.join(ROOT, "index.html"), "utf8");
const data = JSON.parse(await readFile(path.join(ROOT, "data", "edt.json"), "utf8"));
const core = loadCore(html);

let failures = 0;
for (const { name, fn } of tests) {
  try {
    await fn(core, data);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${name}\n      ${error.message.split("\n").join("\n      ")}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} tests réussis`);
process.exit(failures ? 1 : 0);
