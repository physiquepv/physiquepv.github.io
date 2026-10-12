#!/usr/bin/env node
/**
 * Test du script de synchronisation (scripts/sync-edt.mjs) avec un faux CELCAT.
 *
 *   node tests/sync.test.mjs
 *
 * Vérifie : regroupement des semaines, fusion avec le fichier existant, écriture
 * uniquement quand le planning change, et abandon (non destructif) quand CELCAT
 * ne renvoie rien.
 */
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workdir = await mkdtemp(path.join(tmpdir(), "edt-sync-"));
const outFile = path.join(workdir, "edt.json");

process.env.EDT_OUT = outFile;
process.env.EDT_QUIET = "1";
process.env.EDT_FULL = "1"; // recharge tout le semestre : le test couvre la fusion
process.env.EDT_RETRIES = "1"; // pas de temporisation dans les tests

const config = JSON.parse(await readFile(path.join(ROOT, "edt.config.json"), "utf8"));

/* --------------------------------------------------------- faux CELCAT */
function fakeEvent(start, end, extra = {}) {
  return {
    id: `fake-${start}-${extra.room ?? ""}`,
    start,
    end,
    allDay: false,
    description: `CM\r\n\r\n<br />\r\n\r\n${extra.room ?? "2203 - FERMAT"}\r\n\r\n<br />\r\n\r\nLSIN311-Initiation aux bases de données [LSIN311]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 ( S3MIASHS ) [S3MIASHS]\r\n\r\n<br />\r\n\r\n\r\n`,
    eventCategory: "CM",
    backgroundColor: "#00FFFF",
    textColor: "#000000",
    modules: ["LSIN311"],
    ...extra,
  };
}

const baseEvent = (monday) => fakeEvent(`${monday}T09:40:00`, `${monday}T11:10:00`);
let payload = (monday) => [baseEvent(monday)];

/** Même séance, mais publiée « Annulation » (professeur absent). */
function cancellationEvent(monday) {
  const event = baseEvent(monday);
  return {
    ...event,
    description: event.description.replace(/^CM/, "Annulation"),
    eventCategory: "Annulation",
    backgroundColor: "#333333",
  };
}
let calls = 0;
let online = true;

globalThis.fetch = async (url, init = {}) => {
  calls++;
  if (!online) throw new Error("réseau indisponible");
  const body = init.body ? new URLSearchParams(init.body) : new URLSearchParams(String(url).split("?")[1] ?? "");
  const monday = body.get("start");
  const events = payload(monday) ?? [];
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify(events),
  };
};

const { main, lastDetectedChanges } = await import(path.join(ROOT, "scripts", "sync-edt.mjs"));

const readOut = async () => JSON.parse(await readFile(outFile, "utf8"));

console.log("— synchronisation —");

calls = 0;
await main();
const first = await readOut();
const weekCount = Object.keys(first.weeks).length;
assert.equal(first.group, config.group);
assert.ok(weekCount >= 13, `toutes les semaines du semestre doivent être récupérées (${weekCount})`);
assert.equal(first.contentHash.length > 0, true);
console.log(`  ✓ premier passage : ${weekCount} semaines écrites (${calls} appels CELCAT)`);

calls = 0;
await main();
const second = await readOut();
assert.deepEqual(second.weeks, first.weeks);
console.log(`  ✓ deuxième passage identique : contenu inchangé (${calls} appels)`);

// une nouvelle semaine apparaît (cours ajouté) : fusion sans perte
const before = (await readOut()).weeks;
payload = (monday) => [fakeEvent(`${monday}T09:40:00`, `${monday}T11:10:00`), fakeEvent(`${monday}T14:00:00`, `${monday}T16:00:00`, { room: "AMPHI G - FERMAT" })];
await main();
const third = await readOut();
assert.equal(Object.keys(third.weeks).length, weekCount, "aucune semaine ne doit disparaître");
assert.ok(third.weeks["2026-09-28"].events.length === 2, "le nouveau cours est bien présent");
assert.equal(third.weeks["2026-09-28"].events.length, before["2026-09-28"].events.length + 1);
console.log("  ✓ fusion : les semaines déjà connues sont conservées");

// Une annulation publiée sur une seule semaine : elle doit être signalée
const beforeCancel = await readOut();
payload = (monday) => (monday === "2026-10-05" ? [cancellationEvent(monday)] : [baseEvent(monday)]);
await main();
const cancelled = await readOut();
assert.ok(Array.isArray(cancelled.changes), "le fichier publié contient un journal de changements");
const cancelChange = cancelled.changes.filter((change) => change.kind === "cancelled");
assert.equal(cancelChange.length, 1, `une annulation doit être signalée (${cancelChange.length})`);
assert.equal(cancelChange[0].date, "2026-10-05");
assert.equal(cancelChange[0].title, "Initiation aux bases de données");
assert.equal(cancelChange[0].type, "CM", "le type réel de la séance est conservé");
assert.notEqual(cancelled.contentHash, beforeCancel.contentHash);
console.log(`  ✓ annulation signalée : ${cancelChange[0].title} (${cancelChange[0].date})`);

// Un nouveau cours : il est signalé lui aussi, et sans doublon au passage suivant
const beforeAdd = (await readOut()).changes.filter((change) => change.kind === "added").length;
payload = (monday) => [baseEvent(monday), fakeEvent(`${monday}T16:00:00`, `${monday}T17:30:00`, { room: "AMPHI G - FERMAT" })];
await main();
const withAdd = await readOut();
const added = withAdd.changes.filter((change) => change.kind === "added");
assert.ok(added.length > beforeAdd, "un nouveau cours doit apparaître dans le journal");
const snapshotChanges = JSON.stringify(withAdd.changes);
await main();
assert.equal(JSON.stringify((await readOut()).changes), snapshotChanges, "un second passage n'ajoute pas de doublon");
// Le résumé de workflow (et le message de commit) ne cite que ce dernier passage :
const detectedThisRun = lastDetectedChanges(withAdd);
assert.ok(detectedThisRun.some((change) => change.kind === "added" && change.time === "16:00 - 17:30"), "le résumé cite les nouveaux cours du dernier passage");
assert.ok(!detectedThisRun.some((change) => change.detectedAt !== withAdd.generatedAt), "les changements plus anciens ne sont pas recomptés");
console.log(`  ✓ nouveaux cours signalés (${added.length}) et journal sans doublon (${withAdd.changes.length} entrées, ${detectedThisRun.length} du dernier passage)`);

// CELCAT renvoie du vide : on ne doit pas écraser les données valides
const snapshot = await readFile(outFile, "utf8");
payload = () => [];
await assert.rejects(main(), /prudence|aucun créneau/i, "un flux vide ne doit pas écraser le planning");
assert.equal(await readFile(outFile, "utf8"), snapshot, "le fichier doit rester intact");
console.log("  ✓ garde-fou : un flux CELCAT vide n'écrase pas data/edt.json");

// panne réseau complète : même comportement
online = false;
const beforeStat = await stat(outFile);
await assert.rejects(main(), /aucun appel réussi/i);
assert.equal((await stat(outFile)).mtimeMs, beforeStat.mtimeMs, "le fichier ne doit pas être touché");
console.log("  ✓ garde-fou : une panne réseau laisse le fichier intact");

console.log("\n✅ 6/6 vérifications réussies");
