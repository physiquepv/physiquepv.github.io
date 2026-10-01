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

let payload = (monday) => [fakeEvent(`${monday}T09:40:00`, `${monday}T11:10:00`)];
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

const { main } = await import(path.join(ROOT, "scripts", "sync-edt.mjs"));

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

console.log("\n✅ 4/4 vérifications réussies");
