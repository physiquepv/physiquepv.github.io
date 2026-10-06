#!/usr/bin/env node
/**
 * Synchronise l'emploi du temps officiel UVSQ (CELCAT) vers data/edt.json.
 *
 * Le site est hébergé sur GitHub Pages : il ne peut pas appeler edt.uvsq.fr
 * directement (CORS). Cette tâche tourne donc côté GitHub Actions, récupère le
 * planning brut de CELCAT et l'écrit dans data/edt.json, que la page lit
 * ensuite en same-origin.
 *
 * Usage :
 *   node scripts/sync-edt.mjs            # rafraîchit la fenêtre courante
 *   node scripts/sync-edt.mjs --full     # recharge tout le semestre
 *   EDT_DUMP=1 node scripts/sync-edt.mjs # affiche le JSON complet (debug)
 *
 * Le fichier n'est réécrit que si le contenu du planning a réellement changé :
 * cela évite de polluer l'historique Git avec un commit toutes les 10 minutes.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = process.env.EDT_CONFIG ? path.resolve(process.env.EDT_CONFIG) : path.join(ROOT, "edt.config.json");
const OUT_PATH = process.env.EDT_OUT ? path.resolve(process.env.EDT_OUT) : path.join(ROOT, "data", "edt.json");
const TZ = "Europe/Paris";

const full = process.argv.includes("--full") || process.env.EDT_FULL === "1";
const dump = process.env.EDT_DUMP === "1";

/* ------------------------------------------------------------------ dates */
// Toutes les dates sont manipulées en chaînes « YYYY-MM-DD » (jour calendaire
// de Paris) pour ne jamais dériver à cause du fuseau du runner.

function todayParis() {
  return new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, dateStyle: "short" })
    .format(new Date())
    .replaceAll("/", "-");
}

function parseDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function toISO(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function addDays(iso, days) {
  return toISO(parseDay(iso) + days * 86400000);
}

function mondayOf(iso) {
  const ms = parseDay(iso);
  const dow = new Date(ms).getUTCDay(); // 0 = dimanche
  return toISO(ms - ((dow + 6) % 7) * 86400000);
}

/* ------------------------------------------------------------------- HTTP */

const HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 physiquepv-edt-sync/1.0",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postFormOnce(url, fields, cfg, timeoutMs = cfg.timeoutMs) {
  const body = new URLSearchParams(fields).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: HEADERS,
      body,
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${text.slice(0, 100)}`);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`réponse non JSON (${text.slice(0, 100)}…)`);
    }
    if (!Array.isArray(data)) throw new Error(`payload inattendu : ${typeof data}`);
    return data;
  } catch (error) {
    const cause = error?.cause?.code ?? error?.cause?.message;
    throw new Error(cause ? `${error.message} (${cause})` : error.message);
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url, fields, cfg) {
  let lastError;
  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    try {
      return await postFormOnce(url, fields, cfg);
    } catch (error) {
      lastError = error;
      if (attempt < cfg.retries) await sleep(1000 * attempt);
    }
  }
  throw new Error(`${url} : ${lastError?.message ?? "échec"}`);
}

function formFields(monday, calView, cfg) {
  return [
    ["start", monday],
    ["end", addDays(monday, 6)],
    ["resType", cfg.resourceType],
    ["calView", calView],
    ["colourScheme", cfg.colourScheme],
    ["federationIds[]", cfg.group],
  ];
}

/**
 * Cherche le couple (endpoint, calView) accepté par l'instance CELCAT.
 * Une seule tentative par combinaison, avec un délai court : en cas de panne on
 * veut un diagnostic rapide plutôt qu'un job qui tourne 10 minutes.
 */
async function probeStrategy(monday, cfg) {
  const failures = [];
  let fallback = null;
  for (const endpoint of cfg.endpoints) {
    for (const calView of cfg.calViews) {
      const url = cfg.baseUrl + endpoint;
      try {
        const events = await postFormOnce(url, formFields(monday, calView, cfg), cfg, Math.min(cfg.timeoutMs, 12000));
        if (events.length > 0) {
          strategy.endpoint = endpoint;
          strategy.calView = calView;
          return { endpoint, calView, events };
        }
        fallback ??= { endpoint, calView, events };
      } catch (error) {
        failures.push(`${endpoint} (${calView}) → ${error.message}`);
      }
    }
  }
  if (fallback) {
    strategy.endpoint = fallback.endpoint;
    strategy.calView = fallback.calView;
    return fallback;
  }
  throw new Error(`aucun endpoint CELCAT utilisable. ${failures.join(" | ")}`);
}

/** Mémorise le couple (endpoint, calView) qui fonctionne pour les appels suivants. */
const strategy = { endpoint: null, calView: null };

async function fetchWeekEvents(monday, cfg) {
  if (!strategy.endpoint) {
    const probed = await probeStrategy(monday, cfg);
    return { events: probed.events, endpoint: probed.endpoint, calView: probed.calView };
  }
  const events = await postForm(
    cfg.baseUrl + strategy.endpoint,
    formFields(monday, strategy.calView, cfg),
    cfg,
  );
  return { events, endpoint: strategy.endpoint, calView: strategy.calView };
}

/* ----------------------------------------------------------------- lecture */

function weekKeys(cfg) {
  const today = todayParis();
  const { start, end } = cfg.semester;
  const first = mondayOf(addDays(start, -cfg.marginDaysBefore));
  const last = mondayOf(addDays(end, cfg.marginDaysAfter));

  let from = first;
  let to = last;
  if (!full) {
    from = mondayOf(addDays(today, -7 * (cfg.weeksBackIncremental - 1)));
    to = mondayOf(addDays(today, 7 * cfg.weeksAheadIncremental));
    if (parseDay(from) < parseDay(first)) from = first;
    if (parseDay(to) > parseDay(last)) to = last;
  }

  const keys = [];
  for (let cursor = from; parseDay(cursor) <= parseDay(to); cursor = addDays(cursor, 7)) keys.push(cursor);
  return keys;
}

/** Champs lus par la page. Le reste (sites, faculté, couleurs de texte…) alourdit le dépôt sans changer l'affichage. */
function slimEvent(event) {
  const keep = [
    "id",
    "start",
    "end",
    "description",
    "eventCategory",
    "backgroundColor",
    "modules",
  ];
  const out = {};
  for (const key of keep) if (event[key] !== undefined && event[key] !== null && event[key] !== "") out[key] = event[key];
  return out;
}

function hashEvents(weeks) {
  const payload = Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([monday, week]) => `${monday}|${JSON.stringify(week.events)}`)
    .join("\n");
  let hash = 5381;
  for (let i = 0; i < payload.length; i++) hash = ((hash << 5) + hash + payload.charCodeAt(i)) >>> 0;
  return `${hash.toString(16)}-${payload.length}`;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  const cfg = {
    ...config.fetch,
    group: config.group,
    semester: config.semester,
    retries: Number(process.env.EDT_RETRIES ?? config.fetch.retries ?? 3),
    timeoutMs: Number(process.env.EDT_TIMEOUT_MS ?? config.fetch.timeoutMs ?? 25000),
  };
  const keys = weekKeys(cfg);

  console.log(`[edt] node ${process.version} — groupe ${cfg.group} — ${full ? "semestre complet" : "fenêtre glissante"} — ${keys.length} semaines`);
  console.log(`[edt] fenêtre : ${keys[0]} → ${keys.at(-1)} (aujourd'hui : ${todayParis()})`);
  console.log(`[edt] cible : ${cfg.baseUrl}${cfg.endpoints[0]}`);

  // Repart du fichier existant : les semaines non rafraîchies sont conservées.
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT_PATH, "utf8"));
  } catch {
    previous = null;
  }
  const weeks = previous?.weeks ? { ...previous.weeks } : {};

  const now = new Date().toISOString();
  const errors = [];
  let fetched = 0;
  let totalEvents = 0;

  for (const monday of keys) {
    try {
      const { events, endpoint, calView } = await fetchWeekEvents(monday, cfg);
      const slim = events.map(slimEvent).sort((a, b) => String(a.start).localeCompare(String(b.start)));
      weeks[monday] = { monday, fetchedAt: now, endpoint, calView, events: slim };
      fetched++;
      totalEvents += slim.length;
      console.log(`[edt] ${monday} : ${slim.length} créneau(x) via ${endpoint} (${calView})`);
      if (slim.length && !process.env.EDT_QUIET) {
        console.log(`[edt] exemple ${monday} → ${JSON.stringify(slim[0])}`);
      }
    } catch (error) {
      errors.push(`${monday} : ${error.message}`);
      console.error(`[edt] échec ${monday} : ${error.message}`);
    }
  }

  if (fetched === 0) {
    throw new Error(`aucun appel réussi, fichier inchangé — ${errors.join(" | ")}`);
  }

  // Sécurité : si tout est vide alors qu'on avait des cours, on suspecte un
  // incident côté CELCAT et on ne remplace pas les données valides.
  if (totalEvents === 0) {
    if (previous && Object.values(previous.weeks ?? {}).some((w) => w.events?.length)) {
      throw new Error(
        "toutes les semaines interrogées sont vides alors que le fichier précédent contenait des cours : " +
          "abandon par prudence (panne CELCAT ou groupe introuvable).",
      );
    }
    throw new Error(
      `aucun créneau récupéré : vérifie le code du groupe dans edt.config.json (actuellement « ${config.group} ») ` +
        "et la fenêtre demandée.",
    );
  }

  const output = {
    version: 1,
    generatedAt: now,
    group: config.group,
    label: config.label,
    timezone: TZ,
    semester: config.semester,
    source: `${cfg.baseUrl}/cal?vt=agendaWeek&et=group&fid0=${encodeURIComponent(config.group)}`,
    fetchedWeeks: keys,
    contentHash: hashEvents(weeks),
    weeks,
  };

  const serialized = JSON.stringify(output, null, 2) + "\n";
  const previousSerialized = previous ? JSON.stringify({ ...previous, generatedAt: null, fetchedWeeks: null }, null, 2) + "\n" : "";

  if (previous && previous.contentHash === output.contentHash) {
    console.log(`[edt] aucun changement (hash ${output.contentHash}) — ${Object.keys(weeks).length} semaines connues, fichier inchangé.`);
  } else {
    await mkdir(path.dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, serialized, "utf8");
    console.log(
      `[edt] data/edt.json écrit : ${Object.keys(weeks).length} semaines, ` +
        `${Object.values(weeks).reduce((n, w) => n + (w.events?.length ?? 0), 0)} créneaux, hash ${output.contentHash}`,
    );
    void previousSerialized;
  }

  if (dump) {
    console.log("::group::data/edt.json");
    console.log(serialized);
    console.log("::endgroup::");
  }

  if (errors.length) {
    console.log(`::warning::${errors.length} semaine(s) non rafraîchie(s) : ${errors.join(" | ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = String(error?.stack ?? error).replace(/\s+/g, " ").slice(0, 1200);
    console.error(`[edt] erreur fatale : ${message}`);
    console.error(`::error title=Synchro CELCAT en échec::${message.replaceAll("%", "%25")}`);
    process.exit(1);
  });
}

export { main, todayParis, addDays, mondayOf, weekKeys, slimEvent, hashEvents, postForm, probeStrategy, fetchWeekEvents };
