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

const {
  main,
  lastDetectedChanges,
  CelcatAuthError,
  stripStaffLines,
  extractVerificationToken,
} = await import(path.join(ROOT, "scripts", "sync-edt.mjs"));

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

/* ------------------------------------------- authentification LDAP UVSQ */
console.log("\n— authentification LDAP CELCAT (/LdapLogin) —");

// 1. Cas réel d'octobre 2026 : sans secret, GetCalendarData renvoie un corps vide
//    et /cal redirige vers /LdapLogin → diagnostic immédiat (exitCode = 2).
calls = 0;
globalThis.fetch = async (url) => {
  calls++;
  const u = String(url);
  if (u.includes("/cal?")) {
    return {
      ok: false,
      status: 302,
      statusText: "Found",
      headers: { get: (k) => (k.toLowerCase() === "location" ? "/Login" : null) },
      text: async () => "",
    };
  }
  if (u.includes("/Login")) {
    return {
      ok: false,
      status: 302,
      statusText: "Found",
      headers: { get: (k) => (k.toLowerCase() === "location" ? "/LdapLogin" : null) },
      text: async () => "",
    };
  }
  return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => "" };
};
await assert.rejects(
  main(),
  (err) => err instanceof CelcatAuthError && err.kind === "auth_required" && err.exitCode === 2 && /CELCAT_USERNAME/.test(err.message),
  "la fermeture de l'accès anonyme doit être détectée explicitement",
);
assert.ok(calls <= 5, `détection immédiate sans marteler CELCAT (${calls} appels)`);
assert.equal(await readFile(outFile, "utf8"), snapshot, "data/edt.json reste intact");
console.log(`  ✓ accès anonyme fermé (/LdapLogin multi-redirections) détecté immédiatement (${calls} appels, code 2)`);

// 2. Session LDAP complète : anti-forgery + cookies par saut + nettoyage RGPD
//    des noms d'enseignants + fusion S3MIASHS / S4MIASHS en janvier + reconnexion
//    automatique si la session expire en cours de route.
assert.equal(
  extractVerificationToken('<input type="hidden" value="tok-value-first" name="__RequestVerificationToken" />'),
  "tok-value-first",
  "jeton extrait même si value précède name",
);
const descWithStaff =
  "CM\r\n\r\n<br />\r\n\r\n2203 - FERMAT\r\n\r\n<br />\r\n\r\nLSIN311-Initiation aux bases de données [LSIN311]\r\n\r\n<br />\r\n\r\nL2 MIASHS S3 ( S3MIASHS ) [S3MIASHS]\r\n\r\n<br />\r\n\r\nDUPONT, Jean<br />SAINT-GERMAIN, Marie<br />FERM&#201;, Marc [MFERME]\r\n\r\n<br />\r\n\r\nCours annulé, enseignant absent\r\n";
const cleanedDesc = stripStaffLines(descWithStaff);
assert.ok(!/DUPONT|SAINT-GERMAIN|MFERME|FERM&#201;|FERMÉ/.test(cleanedDesc), "les noms d'enseignants ne sont jamais écrits dans le dépôt public");
assert.ok(/Cours annulé, enseignant absent/.test(cleanedDesc), "les remarques avec virgule sont intégralement conservées");

let loginPosts = 0;
let expireOnce = true;
process.env.CELCAT_USERNAME = "  22501234  ";
process.env.CELCAT_PASSWORD = "secret-uvsq-pass\r\n";

function makeHeaders(map = {}, setCookies = []) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    get: (name) => lower[String(name).toLowerCase()] ?? null,
    getSetCookie: () => setCookies,
  };
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const cookie = init?.headers?.Cookie ?? "";

  if (u.endsWith("/LdapLogin")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: makeHeaders({}, [".AspNetCore.Antiforgery.abc=anti-123; path=/; samesite=strict; httponly"]),
      text: async () =>
        '<html><form action="/LdapLogin/Logon" method="post"><input type="hidden" value="csrf-tok-99" name="__RequestVerificationToken" /><input name="Password" type="password" /></form></html>',
    };
  }

  if (u.endsWith("/LdapLogin/Logon") && init.method === "POST") {
    loginPosts++;
    const params = new URLSearchParams(init.body);
    assert.ok(cookie.includes(".AspNetCore.Antiforgery.abc=anti-123"), "le cookie anti-forgery accompagne le POST");
    assert.equal(params.get("__RequestVerificationToken"), "csrf-tok-99");
    if (params.get("Name") === "22501234" && params.get("Password") === "secret-uvsq-pass") {
      return {
        ok: false,
        status: 302,
        statusText: "Found",
        headers: makeHeaders({ location: "/Home/Index" }, [`.AspNetCore.Cookies=sess-${loginPosts}; path=/; httponly`]),
        text: async () => "",
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: makeHeaders(),
      text: async () =>
        '<div class="validation-summary-errors"><ul><li>Identifiant ou mot de passe incorrect</li></ul></div><form action="/LdapLogin/Logon"><input name="Password" /><input name="__RequestVerificationToken" value="tok2" /></form>',
    };
  }

  if (u.endsWith("/Home/Index")) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: makeHeaders({ location: "/cal?vt=month" }),
      text: async () => "<html><body>Calendrier CELCAT</body></html>",
    };
  }

  if (u.includes("/cal?")) {
    if (!cookie.includes(".AspNetCore.Cookies=sess-")) {
      return { ok: false, status: 302, statusText: "Found", headers: makeHeaders({ location: "/LdapLogin" }), text: async () => "" };
    }
    return { ok: true, status: 200, statusText: "OK", headers: makeHeaders(), text: async () => "<html><body>OK</body></html>" };
  }

  if (u.endsWith("/Home/GetCalendarData")) {
    if (!cookie.includes(".AspNetCore.Cookies=sess-")) {
      return { ok: true, status: 200, statusText: "OK", headers: makeHeaders(), text: async () => "" };
    }
    // Simule une expiration de session en plein milieu du run : doit se reconnecter 1 fois
    const form = new URLSearchParams(init.body);
    const monday = form.get("start");
    const group = form.get("federationIds[]");
    if (monday === "2026-11-02" && expireOnce) {
      expireOnce = false;
      return { ok: false, status: 302, statusText: "Found", headers: makeHeaders({ location: "/LdapLogin" }), text: async () => "" };
    }
    if (group === "S4MIASHS") {
      if (monday === "2027-01-04") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: makeHeaders(),
          text: async () =>
            JSON.stringify([
              {
                id: "s4-2027-01-04",
                start: "2027-01-04T09:40:00",
                end: "2027-01-04T11:10:00",
                description: "CM\r\n\r\n<br />\r\n\r\nAMPHI G - FERMAT\r\n\r\n<br />\r\n\r\nLSIN400-Bases de données S4 [LSIN400]\r\n\r\n<br />\r\n\r\nL2 MIASHS S4 [S4MIASHS]\r\n\r\n<br />\r\n\r\nDUPONT, Jean\r\n\r\n<br />\r\n\r\n\r\n",
                eventCategory: "CM",
                backgroundColor: "#00FFFF",
                modules: ["LSIN400"],
              },
            ]),
        };
      }
      // S4 pas encore publié sur 2027-01-11 : corps vide toléré pour le groupe optionnel
      return { ok: true, status: 200, statusText: "OK", headers: makeHeaders(), text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: makeHeaders(),
      text: async () =>
        JSON.stringify([
          fakeEvent(`${monday}T09:40:00`, `${monday}T11:10:00`, { description: descWithStaff }),
        ]),
    };
  }

  throw new Error(`URL inattendue dans le test : ${u}`);
};

await main();
const authedOut = await readOut();
assert.equal(loginPosts, 2, "1 connexion initiale + 1 reconnexion sur expiration de session");
assert.ok(
  authedOut.weeks["2027-01-04"].events.some((e) => e.id === "s4-2027-01-04"),
  "les premiers cours de S4MIASHS de janvier sont fusionnés dès qu'ils existent",
);
assert.ok(
  !JSON.stringify(authedOut).includes("DUPONT"),
  "aucun nom d'enseignant n'est présent dans data/edt.json",
);
console.log("  ✓ connexion LDAP, reprise sur session expirée, nettoyage RGPD et fusion S3+S4 réussis");

// 3. Mauvais mot de passe : 1 seule tentative (jamais de retry qui bloquerait le compte ENT)
loginPosts = 0;
process.env.CELCAT_USERNAME = "prenom.nom@etu.uvsq.fr";
process.env.CELCAT_PASSWORD = "mauvais-mot-de-passe";
await assert.rejects(
  main(),
  (err) =>
    err instanceof CelcatAuthError &&
    err.kind === "bad_credentials" &&
    err.exitCode === 3 &&
    /@etu\.uvsq\.fr/.test(err.message),
  "les identifiants refusés lèvent bad_credentials avec conseil sur le format du login",
);
assert.equal(loginPosts, 1, "un mot de passe refusé n'est jamais renvoyé une seconde fois");
console.log("  ✓ mauvais mot de passe : 1 seul essai envoyé (anti-verrouillage ENT)");

// 4. Pause de sécurité de 6 h en exécution planifiée (schedule) après un refus LDAP
let celcatTouched = false;
process.env.GITHUB_EVENT_NAME = "schedule";
process.env.GITHUB_REPOSITORY = "physiquepv/physiquepv.github.io";
process.env.GITHUB_TOKEN = "ghs_fake_token";
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("api.github.com") && u.includes("/runs?")) {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        workflow_runs: [{ id: 999, conclusion: "failure", updated_at: new Date(Date.now() - 15 * 60 * 1000).toISOString() }],
      }),
    };
  }
  if (u.includes("api.github.com") && u.includes("/jobs")) {
    return { ok: true, status: 200, json: async () => ({ jobs: [{ id: 777 }] }) };
  }
  if (u.includes("api.github.com") && u.includes("/annotations")) {
    return { ok: true, status: 200, json: async () => [{ title: "Authentification UVSQ refusée", message: "..." }] };
  }
  celcatTouched = true;
  throw new Error("CELCAT ne devait pas être appelé pendant la pause de sécurité");
};
await main();
assert.equal(celcatTouched, false, "aucun appel LDAP envoyé pendant le cooldown planifié");
delete process.env.GITHUB_EVENT_NAME;
delete process.env.GITHUB_REPOSITORY;
delete process.env.GITHUB_TOKEN;
delete process.env.CELCAT_USERNAME;
delete process.env.CELCAT_PASSWORD;
console.log("  ✓ pause anti-blocage de 6 h en mode schedule vérifiée (0 appel CELCAT)");

console.log("\n✅ 10/10 vérifications réussies");
