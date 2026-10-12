#!/usr/bin/env node
/**
 * Détection des changements du planning officiel (CELCAT → data/edt.json).
 *
 * Le site doit prévenir clairement quand quelque chose bouge : professeur
 * absent / séance annulée, nouveau cours, séance retirée, salle ou horaire
 * modifiés. Cette comparaison est faite ici, côté synchro : le résultat est
 * publié dans `data/edt.json` (champ `changes`) et la page n'a plus qu'à
 * l'afficher.
 *
 * Deux principes :
 * - **une seule source de vérité pour le parsing** : on réutilise le noyau de
 *   index.html (section CORE-START … CORE-END), donc un événement est décrit
 *   exactement de la même façon que dans la page (même titre, même salle, même
 *   détection d'annulation) ;
 * - **pas de faux positifs** : une semaine jamais vue auparavant n'est pas un
 *   « changement » (sinon le premier chargement d'une semaine annoncerait tout
 *   le planning comme nouveau), et un créneau annulé chaque semaine (créneau
 *   suspendu, déjà masqué par la page) n'est pas une information.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/* ------------------------------------------------------------------ noyau */

/** Fonctions du noyau d'index.html dont ce module a besoin. */
export const CORE_API = [
  "parseEvent",
  "normalizeGroupCode",
  "findRecurringCancellations",
  "recurringKey",
  "changeSummaryLabel",
  "changeLabel",
  "changeSentence",
  "changeStatusLabel",
  "changeWhenLabel",
];

/**
 * Extrait le noyau testable embarqué dans index.html (CORE-START … CORE-END) et
 * l'évalue. Même mécanisme que tests/edt.test.mjs : le script de synchro
 * décrit donc chaque cours exactement comme la page l'affiche.
 */
export function loadPageCore(html, names = CORE_API) {
  const start = html.indexOf("CORE-START");
  const end = html.indexOf("CORE-END");
  if (start < 0 || end <= start) throw new Error("marqueurs CORE-START / CORE-END introuvables dans index.html");
  const code = html.slice(html.indexOf("*/", start) + 2, html.lastIndexOf("/*", end));
  const factory = new Function(`${code}; return { ${names.join(", ")} };`);
  return factory();
}

/** Charge index.html puis son noyau. */
export async function loadCoreFromRepo(root) {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  return loadPageCore(html);
}

/* ------------------------------------------------------------- utilitaires */

const DAY_MS = 86400000;

function parseDay(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function toISO(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Code entre crochets d'une ligne de ressource CELCAT (« … [S3MIASHS TD 2] »). */
function resourceCodeOf(line) {
  const match = String(line ?? "").match(/\[([^\]]+)\]\s*$/);
  return (match ? match[1] : String(line ?? "")).trim();
}

function simplified(parsed) {
  return {
    id: parsed.id,
    date: parsed.date,
    startMin: parsed.startMin,
    endMin: parsed.endMin,
    time: parsed.time,
    title: parsed.title,
    type: parsed.type,
    room: parsed.room,
    cat: parsed.cat,
    cancelled: Boolean(parsed.cancelled),
    note: parsed.note ?? "",
    groups: parsed.groups ?? [],
  };
}

/* ------------------------------------------------------------- comparaison */

const toEntry = (core, raw) => {
  const parsed = core.parseEvent(raw);
  return parsed ? { raw, parsed } : null;
};

/**
 * Apparie les séances de la semaine précédente et de la nouvelle version.
 * 1. même identifiant CELCAT (cas normal) ;
 * 2. même jour + même matière + même créneau (CELCAT recrée l'événement, par
 *    exemple quand il publie une « Annulation » à la place du cours) ;
 * 3. même jour + même matière, créneau le plus proche (séance déplacée).
 */
function matchEvents(previous, next) {
  const pairs = [];
  const claimed = new Set();
  const byId = new Map(previous.map((entry) => [entry.parsed.id, entry]));

  const rest = [];
  for (const entry of next) {
    const twin = byId.get(entry.parsed.id);
    if (twin && !claimed.has(twin)) {
      claimed.add(twin);
      pairs.push([twin, entry]);
    } else {
      rest.push(entry);
    }
  }

  const free = previous.filter((entry) => !claimed.has(entry));
  const sameSpan = (a, b) =>
    a.parsed.date === b.parsed.date &&
    normalizeTitle(a.parsed.title) === normalizeTitle(b.parsed.title) &&
    a.parsed.startMin === b.parsed.startMin;
  const sameCourse = (a, b) =>
    a.parsed.date === b.parsed.date && normalizeTitle(a.parsed.title) === normalizeTitle(b.parsed.title);

  const unmatched = [];
  for (const entry of rest) {
    const twin = free.find((candidate) => !claimed.has(candidate) && sameSpan(candidate, entry));
    if (twin) {
      claimed.add(twin);
      pairs.push([twin, entry]);
    } else {
      unmatched.push(entry);
    }
  }

  const onlyNext = [];
  for (const entry of unmatched) {
    const candidates = free
      .filter((candidate) => !claimed.has(candidate) && sameCourse(candidate, entry))
      .sort((a, b) => Math.abs(a.parsed.startMin - entry.parsed.startMin) - Math.abs(b.parsed.startMin - entry.parsed.startMin));
    // Au-delà de 2 h d'écart, c'est une autre séance : ni déplacée, ni la même.
    const twin = candidates.find((candidate) => Math.abs(candidate.parsed.startMin - entry.parsed.startMin) <= 120);
    if (twin) {
      claimed.add(twin);
      pairs.push([twin, entry]);
    } else {
      onlyNext.push(entry);
    }
  }

  const onlyPrev = free.filter((entry) => !claimed.has(entry));
  return { pairs, onlyPrev, onlyNext };
}

/** Construit une entrée du journal des changements à partir d'une séance. */
function makeChange(core, kind, parsed, detectedAt, extra = {}) {
  const info = simplified(parsed);
  // Une annulation publiée par CELCAT remplace le type du cours (« Annulation ») :
  // on affiche le type réel de la séance (CM, TD…), plus parlant pour l'étudiant.
  const type = /^annul/i.test(info.type) && extra?.previous?.type ? extra.previous.type : info.type;
  return {
    kind,
    date: info.date,
    startMin: info.startMin,
    endMin: info.endMin,
    time: info.time,
    title: info.title,
    type,
    room: info.room,
    cat: info.cat,
    groups: info.groups.map((line) => core.normalizeGroupCode(resourceCodeOf(line))),
    eventId: info.id,
    reason: reasonOf(parsed),
    detectedAt,
    ...extra,
  };
}

/**
 * Motif publié par l'université, quand le flux CELCAT en contient un
 * (« Enseignant absent », « Grève », …). Une simple étiquette « Annulation »
 * n'est pas un motif : elle serait affichée deux fois sur la carte.
 */
function reasonOf(parsed) {
  const BARE = /^(annul[ée]e?|annulation|supprim[ée]e?|report[ée]e?|absence|absent)$/i;
  const REASON = /absent|indispon|maladie|gr[eè]ve|emp[eê]ch|annul|supprim|report|distanciel|visio/i;
  const parts = String(parsed?.note ?? "").split("·").map((part) => part.trim()).filter(Boolean);
  const candidate = parts.find((part) => !BARE.test(part));
  return candidate && REASON.test(candidate) ? candidate : "";
}

function previousState(parsed) {
  const info = simplified(parsed);
  return { time: info.time, room: info.room, type: info.type, cancelled: info.cancelled };
}

/** Compare deux séances appariées : annulation, rétablissement, déplacement, salle, type. */
function diffPair(core, before, after, detectedAt, recurring) {
  const wasCancelled = before.parsed.cancelled;
  const isCancelled = after.parsed.cancelled;
  const beforeState = previousState(before.parsed);

  if (isCancelled && !wasCancelled) {
    // Créneau suspendu (annulé toutes les semaines) : pas une information.
    if (recurring?.size && typeof core.recurringKey === "function" && recurring.has(core.recurringKey(after.parsed))) return [];
    return [makeChange(core, "cancelled", after.parsed, detectedAt, { previous: beforeState })];
  }
  if (wasCancelled && !isCancelled) {
    return [makeChange(core, "restored", after.parsed, detectedAt, { previous: beforeState })];
  }
  if (isCancelled) return []; // déjà annulé avant : rien de neuf

  const changes = [];
  if (before.parsed.startMin !== after.parsed.startMin || before.parsed.endMin !== after.parsed.endMin) {
    changes.push(makeChange(core, "moved", after.parsed, detectedAt, { previous: beforeState }));
  }
  if ((before.parsed.room || "") !== (after.parsed.room || "")) {
    changes.push(makeChange(core, "room", after.parsed, detectedAt, { previous: beforeState }));
  }
  if ((before.parsed.type || "") !== (after.parsed.type || "")) {
    changes.push(makeChange(core, "updated", after.parsed, detectedAt, { previous: beforeState }));
  }
  return changes;
}

/**
 * Compare deux versions du planning (`weeks` de data/edt.json) et retourne la
 * liste des changements détectés.
 */
export function diffWeeks(previousWeeks, nextWeeks, options = {}) {
  const { core, detectedAt = new Date().toISOString(), onlyKeys = null } = options;
  if (!core) throw new Error("diffWeeks : noyau (core) manquant");
  const recurring = options.recurringCancellations ?? core.findRecurringCancellations(nextWeeks ?? {});
  const changes = [];

  for (const [monday, week] of Object.entries(nextWeeks ?? {})) {
    if (onlyKeys && !onlyKeys.has(monday)) continue;
    const before = previousWeeks?.[monday];
    // Semaine jamais vue : on n'annonce pas tout le planning comme nouveau.
    if (!before) continue;
    const previousEntries = (before.events ?? []).map((raw) => toEntry(core, raw)).filter(Boolean);
    const nextEntries = (week.events ?? []).map((raw) => toEntry(core, raw)).filter(Boolean);
    const { pairs, onlyPrev, onlyNext } = matchEvents(previousEntries, nextEntries);

    for (const [previousEntry, nextEntry] of pairs) {
      changes.push(...diffPair(core, previousEntry, nextEntry, detectedAt, recurring));
    }
    for (const entry of onlyNext) {
      if (entry.parsed.cancelled) continue; // annonce d'annulation seule : sans état d'avant, ce n'est pas exploitable
      changes.push(makeChange(core, "added", entry.parsed, detectedAt, { previous: null }));
    }
    for (const entry of onlyPrev) {
      changes.push(makeChange(core, "removed", entry.parsed, detectedAt, { previous: previousState(entry.parsed) }));
    }
  }

  return changes;
}

/* ------------------------------------------------------- journal versionné */

const clean = (value) => String(value ?? "").trim();

/** Clé stable d'un changement : un même événement ne doit apparaître qu'une fois. */
export function changeKey(change) {
  const start = Number.isFinite(change?.startMin) ? change.startMin : String(change?.time ?? "").slice(0, 5);
  return `${clean(change?.kind)}|${clean(change?.date)}|${start}|${normalizeTitle(change?.title)}`;
}

/**
 * Fusionne le journal publié et les changements du jour : une seule entrée par
 * changement (clé stable), purge des entrées trop anciennes, tri chronologique.
 *
 * `detectedAt` est la **dernière** fois où la transition a été vue : un cours
 * annulé, rétabli puis de nouveau annulé redevient ainsi une information à
 * signaler (et la page rouvre le bandeau).
 */
export function mergeChangeLog(previousChanges, newChanges, { keepDays = 30, limit = 80, now = new Date() } = {}) {
  const merged = new Map();
  for (const change of [...(previousChanges ?? []), ...(newChanges ?? [])]) {
    if (!change || !change.kind || !change.date) continue;
    const key = changeKey(change);
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, ...change } : { ...change });
  }
  const cutoff = toISO(parseDay(`${new Date(now).toISOString().slice(0, 10)}`) - keepDays * DAY_MS);
  return [...merged.values()]
    .filter((change) => change.date >= cutoff)
    .sort((a, b) => `${a.date}|${String(a.startMin).padStart(5, "0")}`.localeCompare(`${b.date}|${String(b.startMin).padStart(5, "0")}`))
    .slice(-limit);
}

/* -------------------------------------------------------------- résumés CLI */

/** Ligne lisible d'un changement, partagée par les journaux Actions et la page. */
export function changeLine(core, change) {
  const { icon, label } = core.changeLabel(change);
  const detail = core.changeStatusLabel(change);
  return `${icon} ${label} — ${core.changeSentence(change)}${detail ? ` · ${detail}` : ""}`;
}

/**
 * Résumé markdown des changements publiés (résumé de workflow, corps du commit).
 */
export function summaryMarkdown(core, changes, { generatedAt = null, title = "Changements détectés dans le planning" } = {}) {
  if (!changes?.length) {
    return `### ${title}\n\nAucun changement : le planning officiel est identique à la version publiée.\n`;
  }
  const lines = [`### ${title} (${changes.length})`, ""];
  if (generatedAt) lines.push(`_Dernière vérification : ${generatedAt}_`, "");
  lines.push("| Quand | Quoi | Cours | Détail |", "| --- | --- | --- | --- |");
  for (const change of changes) {
    const { icon, label } = core.changeLabel(change);
    const detail = [change.room ? `📍 ${change.room}` : "", core.changeStatusLabel(change)].filter(Boolean).join(" · ");
    lines.push(`| ${core.changeWhenLabel(change)} | ${icon} ${label} | **${change.title}** (${change.type}) | ${detail} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Sujet court pour le message de commit : « 2 annulations, 1 nouveau cours ». */
export function summarySubject(core, changes) {
  if (!changes?.length) return "";
  return core.changeSummaryLabel(changes);
}
