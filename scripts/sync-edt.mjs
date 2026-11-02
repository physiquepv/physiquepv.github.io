#!/usr/bin/env node
/**
 * Synchronise l'emploi du temps officiel UVSQ (CELCAT) vers data/edt.json.
 *
 * Le site est hébergé sur GitHub Pages : il ne peut pas appeler edt.uvsq.fr
 * directement (CORS + authentification LDAP). Cette tâche tourne donc côté
 * GitHub Actions, ouvre une session CELCAT si l'instance exige une connexion
 * (/LdapLogin), récupère le planning brut et l'écrit dans data/edt.json, que
 * la page lit ensuite en same-origin.
 *
 * Variables d'environnement d'authentification (secrets GitHub Actions) :
 *   CELCAT_USERNAME   identifiant ENT UVSQ (ex. numéro étudiant, sans @etu.uvsq.fr)
 *   CELCAT_PASSWORD   mot de passe ENT UVSQ
 *
 * Usage :
 *   node scripts/sync-edt.mjs              # rafraîchit la fenêtre courante
 *   node scripts/sync-edt.mjs --full       # recharge tout le semestre
 *   node scripts/sync-edt.mjs --summary    # résumé markdown des changements publiés
 *   node scripts/sync-edt.mjs --summary-subject  # sujet court pour le message de commit
 *   EDT_DUMP=1 node scripts/sync-edt.mjs   # affiche le JSON complet (debug)
 *
 * Codes de sortie :
 *   0  succès (planning mis à jour ou inchangé, ou pause anti-blocage planifiée)
 *   1  erreur réseau / serveur CELCAT / garde-fou de flux vide
 *   2  edt.uvsq.fr exige une connexion (/LdapLogin) mais les secrets sont absents
 *   3  identifiants UVSQ refusés ou captcha déclenché sur edt.uvsq.fr
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { diffWeeks, mergeChangeLog, loadCoreFromRepo, summaryMarkdown, summarySubject, changeLine } from "./edt-changes.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = process.env.EDT_CONFIG ? path.resolve(process.env.EDT_CONFIG) : path.join(ROOT, "edt.config.json");
const OUT_PATH = process.env.EDT_OUT ? path.resolve(process.env.EDT_OUT) : path.join(ROOT, "data", "edt.json");
const TZ = "Europe/Paris";
const AUTH_COOLDOWN_MS = 6 * 3600 * 1000; // 6 h de pause en cron après un refus LDAP / captcha

const isFullMode = () => process.argv.includes("--full") || process.env.EDT_FULL === "1";
const isDumpMode = () => process.env.EDT_DUMP === "1";

/* ---------------------------------------------------------------- erreurs */

export class CelcatAuthError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "CelcatAuthError";
    this.kind = kind; // "auth_required" | "bad_credentials" | "captcha"
    this.exitCode = kind === "auth_required" ? 2 : 3;
  }
}

class SessionExpiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

const AUTH_REQUIRED_MESSAGE =
  "edt.uvsq.fr redirige désormais vers /LdapLogin (accès anonyme fermé par l'UVSQ). " +
  "Ajoutez les secrets CELCAT_USERNAME (identifiant ENT / numéro étudiant, sans @etu.uvsq.fr) " +
  "et CELCAT_PASSWORD dans GitHub (Settings → Secrets and variables → Actions), " +
  "puis relancez le workflow « Sync emploi du temps UVSQ ».";

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

/* ------------------------------------------------------ cookies & session */

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const AJAX_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "User-Agent": USER_AGENT,
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

const HTML_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "User-Agent": USER_AGENT,
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Trousseau de cookies HTTP en mémoire (capture chaque saut de redirection). */
export function createCookieJar() {
  const cookies = new Map();
  return {
    capture(res) {
      if (!res?.headers) return;
      const rawList =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [res.headers.get?.("set-cookie")].filter(Boolean);
      for (const raw of rawList) {
        if (!raw) continue;
        const parts = String(raw).split(";");
        const first = parts[0] ?? "";
        const eq = first.indexOf("=");
        if (eq <= 0) continue;
        const name = first.slice(0, eq).trim();
        const value = first.slice(eq + 1).trim();
        if (!name) continue;

        let expired = value === "" || value.toLowerCase() === "deleted";
        for (const attr of parts.slice(1)) {
          const maxAge = attr.match(/^\s*max-age\s*=\s*(-?\d+)/i);
          if (maxAge && Number(maxAge[1]) <= 0) expired = true;
          const expires = attr.match(/^\s*expires\s*=\s*(.+)$/i);
          if (expires) {
            const ts = Date.parse(expires[1].trim());
            if (Number.isFinite(ts) && ts < Date.now() - 60000) expired = true;
          }
        }
        if (expired) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
    header() {
      return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    },
    get size() {
      return cookies.size;
    },
    clear() {
      cookies.clear();
    },
  };
}

function readCredentials(env = process.env) {
  const username = String(env.CELCAT_USERNAME ?? env.EDT_USERNAME ?? env.UVSQ_USERNAME ?? "").trim();
  const password = String(env.CELCAT_PASSWORD ?? env.EDT_PASSWORD ?? env.UVSQ_PASSWORD ?? "").replace(/[\r\n]+$/g, "");
  if (!username || !password) return null;
  return { username, password };
}

/**
 * Requête HTTP avec suivi manuel des redirections pour ne jamais perdre les
 * en-têtes Set-Cookie posés sur un 302 intermédiaire (undici les masque en
 * mode redirect: "follow").
 */
async function requestWithJar(url, options = {}) {
  const {
    jar = null,
    method = "GET",
    headers = {},
    body = undefined,
    timeoutMs = 20000,
    maxRedirects = 5,
  } = options;

  let currentUrl = url;
  let currentMethod = method;
  let currentBody = body;
  const baseHeaders = { ...headers };

  for (let hop = 0; ; hop++) {
    const reqHeaders = { ...baseHeaders };
    if (jar) {
      const cookie = jar.header();
      if (cookie) reqHeaders.Cookie = cookie;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(currentUrl, {
        method: currentMethod,
        headers: reqHeaders,
        body: currentBody,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (jar) jar.capture(res);

    const status = res?.status ?? 200;
    const location = res?.headers?.get?.("location") ?? null;
    const isRedirect = [301, 302, 303, 307, 308].includes(status);
    if (!isRedirect || !location || hop >= maxRedirects) {
      return { res, status, finalUrl: currentUrl, location };
    }

    const nextUrl = new URL(location, currentUrl).toString();
    if ((status === 301 || status === 302 || status === 303) && currentMethod === "POST") {
      currentMethod = "GET";
      currentBody = undefined;
      delete baseHeaders["Content-Type"];
    }
    currentUrl = nextUrl;
  }
}

/** Extrait le jeton anti-forgery ASP.NET quel que soit l'ordre des attributs HTML. */
export function extractVerificationToken(html) {
  if (typeof html !== "string") return null;
  const inputs = html.match(/<input\b[^>]*__RequestVerificationToken[^>]*>/gi) ?? [];
  for (const tag of inputs) {
    const valueMatch = tag.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (valueMatch) return valueMatch[1] ?? valueMatch[2] ?? null;
  }
  const fallback = html.match(/__RequestVerificationToken[^>]*?\bvalue\s*=\s*["']([^"']+)["']/i);
  return fallback ? fallback[1] : null;
}

function extractFormAction(html, fallbackUrl) {
  if (typeof html !== "string") return fallbackUrl;
  const forms = html.match(/<form\b[^>]*>/gi) ?? [];
  for (const formTag of forms) {
    const actionMatch = formTag.match(/\baction\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    if (actionMatch) {
      const raw = (actionMatch[1] ?? actionMatch[2] ?? "").replaceAll("&amp;", "&").trim();
      if (raw) return new URL(raw, fallbackUrl).toString();
    }
  }
  return fallbackUrl;
}

function hasCaptcha(html) {
  if (typeof html !== "string") return false;
  if (/data-sitekey|g-recaptcha|recaptcha_challenge|ctCaptcha|h-captcha/i.test(html)) return true;
  return /field-validation-error[^>]*data-valmsg-for=["']BadCaptcha["'][^>]*>\s*[^<\s]/i.test(html);
}

function isLoginUrl(url) {
  return /\/(?:LdapLogin|Login|Saml|Shibboleth|cas\/login)\b/i.test(String(url ?? ""));
}

function isLoginPage(url, html) {
  if (isLoginUrl(url)) return true;
  if (typeof html !== "string") return false;
  return (
    /\/LdapLogin\/Logon/i.test(html) ||
    (/name=["']Password["']/i.test(html) && /__RequestVerificationToken/i.test(html))
  );
}

function extractLoginError(html) {
  if (typeof html !== "string") return "";
  const summary = html.match(/validation-summary-errors[^>]*>([\s\S]{0,500}?)<\/div>/i);
  const field = html.match(/field-validation-error[^>]*>([\s\S]{0,300}?)<\/span>/i);
  const raw = summary?.[1] ?? field?.[1] ?? "";
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&[#a-z0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyLoginFailure(html, username) {
  if (hasCaptcha(html)) {
    throw new CelcatAuthError(
      "captcha",
      "UVSQ a déclenché un captcha sur edt.uvsq.fr (trop d'échecs de connexion récents). " +
        "Connectez-vous une fois manuellement sur https://edt.uvsq.fr dans un navigateur, puis relancez le workflow.",
    );
  }
  const detail = extractLoginError(html);
  const emailHint = String(username ?? "").includes("@")
    ? " — astuce : CELCAT attend votre identifiant ENT / numéro étudiant (sans @etu.uvsq.fr), pas votre adresse mail"
    : "";
  throw new CelcatAuthError(
    "bad_credentials",
    `Identifiants UVSQ refusés par edt.uvsq.fr/LdapLogin${detail ? ` (${detail})` : ""}${emailHint}. ` +
      "Vérifiez les secrets CELCAT_USERNAME et CELCAT_PASSWORD dans GitHub.",
  );
}

/**
 * Authentifie une session CELCAT via /LdapLogin → POST /LdapLogin/Logon.
 * Une seule tentative par exécution : un mauvais mot de passe n'est jamais
 * rejoué pour ne pas verrouiller le compte ENT UVSQ ni déclencher de captcha.
 */
export async function loginCelcat(baseUrl, creds, timeoutMs = 20000) {
  const jar = createCookieJar();
  const root = String(baseUrl).replace(/\/+$/, "");
  const origin = new URL(root).origin;

  let page = await requestWithJar(`${root}/LdapLogin`, {
    jar,
    headers: HTML_HEADERS,
    timeoutMs,
    maxRedirects: 6,
  });
  if (page.status === 404) {
    page = await requestWithJar(`${root}/Login`, {
      jar,
      headers: HTML_HEADERS,
      timeoutMs,
      maxRedirects: 6,
    });
  }

  const loginHtml = await page.res.text();
  const token = extractVerificationToken(loginHtml);
  if (!token) {
    if (hasCaptcha(loginHtml)) {
      throw new CelcatAuthError(
        "captcha",
        "Captcha exigé par edt.uvsq.fr dès l'ouverture de /LdapLogin. Connectez-vous une fois via un navigateur puis réessayez.",
      );
    }
    if (!isLoginPage(page.finalUrl, loginHtml) && page.status >= 200 && page.status < 400) {
      // L'accès anonyme est ouvert : aucune connexion requise.
      return { jar, authenticated: false };
    }
    throw new Error(`Formulaire /LdapLogin illisible sur ${root} (HTTP ${page.status}, jeton anti-forgery introuvable).`);
  }

  const actionUrl = extractFormAction(loginHtml, `${root}/LdapLogin/Logon`);
  const body = new URLSearchParams({
    Name: creds.username,
    Password: creds.password,
    RememberMe: "true",
    __RequestVerificationToken: token,
  });

  const post = await requestWithJar(actionUrl, {
    jar,
    method: "POST",
    headers: {
      ...HTML_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: origin,
      Referer: page.finalUrl,
    },
    body: body.toString(),
    timeoutMs,
    maxRedirects: 0, // Le 302 porte le cookie d'authentification CELCAT
  });

  if ([301, 302, 303, 307, 308].includes(post.status) && post.location) {
    const nextUrl = new URL(post.location, actionUrl).toString();
    if (isLoginUrl(nextUrl)) {
      const redirected = await requestWithJar(nextUrl, { jar, headers: HTML_HEADERS, timeoutMs, maxRedirects: 4 });
      classifyLoginFailure(await redirected.res.text(), creds.username);
    }
    const landed = await requestWithJar(nextUrl, {
      jar,
      headers: HTML_HEADERS,
      timeoutMs,
      maxRedirects: 5,
    });
    const landedHtml = await landed.res.text();
    if (isLoginPage(landed.finalUrl, landedHtml)) {
      classifyLoginFailure(landedHtml, creds.username);
    }
    return { jar, authenticated: true };
  }

  const postHtml = await post.res.text();
  return classifyLoginFailure(postHtml, creds.username);
}

/**
 * Fallback : extrait un tableau `events = [...]` éventuellement injecté dans
 * le HTML de `/cal` par certaines configurations CELCAT.
 */
export function extractEmbeddedEvents(html) {
  if (typeof html !== "string") return [];
  const match = html.match(/(?:var\s+|const\s+|let\s+|["']?events["']?\s*[:=]\s*)\[/i);
  if (!match) return [];
  const start = html.indexOf("[", match.index);
  if (start < 0) return [];

  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(html.slice(start, i + 1));
          return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
        } catch {
          return [];
        }
      }
    }
  }
  return [];
}

/* -------------------------------------------------- état de session actif */

const strategy = { endpoint: null, calView: null };
const session = {
  jar: createCookieJar(),
  creds: null,
  authenticated: false,
  reauthed: false,
  anonRedirectProbed: false,
  warmedGroups: new Map(), // group -> referer URL
};

export function resetSession() {
  strategy.endpoint = null;
  strategy.calView = null;
  session.jar = createCookieJar();
  session.creds = null;
  session.authenticated = false;
  session.reauthed = false;
  session.anonRedirectProbed = false;
  session.warmedGroups.clear();
}

async function ensureGroupWarmed(group, monday, cfg) {
  if (!session.authenticated || session.warmedGroups.has(group)) return;
  const root = String(cfg.baseUrl).replace(/\/+$/, "");
  const calUrl = `${root}/cal?vt=agendaWeek&dt=${monday}&et=group&fid0=${encodeURIComponent(group)}`;
  const cal = await requestWithJar(calUrl, {
    jar: session.jar,
    headers: HTML_HEADERS,
    timeoutMs: Math.min(cfg.timeoutMs, 15000),
    maxRedirects: 5,
  });
  const html = await cal.res.text();
  if (isLoginPage(cal.finalUrl, html)) {
    throw new SessionExpiredError(`Accès à ${calUrl} redirigé vers /LdapLogin.`);
  }
  session.warmedGroups.set(group, cal.finalUrl);
}

/** Vérifie si l'accès anonyme à `/cal` redirige vers `/LdapLogin`. */
async function probeAnonymousLoginRedirect(cfg, group) {
  if (session.anonRedirectProbed) return false;
  session.anonRedirectProbed = true;
  try {
    const root = String(cfg.baseUrl).replace(/\/+$/, "");
    const check = await requestWithJar(
      `${root}/cal?vt=agendaDay&dt=${todayParis()}&et=group&fid0=${encodeURIComponent(group)}`,
      { jar: createCookieJar(), headers: HTML_HEADERS, timeoutMs: Math.min(cfg.timeoutMs, 8000), maxRedirects: 5 },
    );
    if ([301, 302, 303, 307, 308].includes(check.status) && isLoginUrl(check.location)) {
      return true;
    }
    if (check.status === 401 || check.status === 403) return true;
    const html = await check.res.text();
    return isLoginPage(check.finalUrl, html);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------- HTTP */

async function postFormOnce(url, fields, cfg, timeoutMs = cfg.timeoutMs, options = {}) {
  const group = options.group ?? cfg.group;
  const body = new URLSearchParams(fields).toString();
  const root = String(cfg.baseUrl).replace(/\/+$/, "");
  const origin = new URL(root).origin;
  const referer =
    session.warmedGroups.get(group) ??
    `${root}/cal?vt=agendaWeek&et=group&fid0=${encodeURIComponent(group)}`;

  try {
    const { res, status, location } = await requestWithJar(url, {
      jar: session.jar,
      method: "POST",
      headers: {
        ...AJAX_HEADERS,
        Origin: origin,
        Referer: referer,
      },
      body,
      timeoutMs,
      maxRedirects: 0,
    });

    if ([301, 302, 303, 307, 308].includes(status)) {
      if (isLoginUrl(location)) {
        if (!session.creds) throw new CelcatAuthError("auth_required", AUTH_REQUIRED_MESSAGE);
        throw new SessionExpiredError("Session CELCAT expirée en cours de synchronisation (302 vers /LdapLogin).");
      }
      throw new Error(`HTTP ${status} redirection inattendue vers ${location ?? "?"}`);
    }

    const text = await res.text();
    if (status === 401 || status === 403) {
      if (!session.creds) throw new CelcatAuthError("auth_required", AUTH_REQUIRED_MESSAGE);
      throw new CelcatAuthError("bad_credentials", `Accès refusé par CELCAT (HTTP ${status}).`);
    }
    if (!res.ok) throw new Error(`HTTP ${status} ${res.statusText ?? ""} — ${text.slice(0, 100)}`.trim());

    if (!text.trim()) {
      if (!session.authenticated && !session.creds) {
        if (await probeAnonymousLoginRedirect(cfg, group)) {
          throw new CelcatAuthError("auth_required", AUTH_REQUIRED_MESSAGE);
        }
        throw new Error(
          `réponse vide de CELCAT pour « ${group} » (accès anonyme possiblement fermé — configurez CELCAT_USERNAME / CELCAT_PASSWORD)`,
        );
      }
      if (options.optionalGroup) return [];
      throw new Error(`réponse vide de CELCAT pour le groupe « ${group} » (groupe inconnu ou non publié)`);
    }

    if (isLoginPage("", text)) {
      if (!session.creds) throw new CelcatAuthError("auth_required", AUTH_REQUIRED_MESSAGE);
      throw new SessionExpiredError("CELCAT a renvoyé le formulaire /LdapLogin à la place du JSON.");
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`réponse non JSON (${text.replace(/\s+/g, " ").slice(0, 100)}…)`);
    }
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.events)) return data.events;
    if (Array.isArray(data?.data)) return data.data;
    throw new Error(`payload inattendu : ${typeof data}`);
  } catch (error) {
    if (error instanceof CelcatAuthError || error instanceof SessionExpiredError) throw error;
    const cause = error?.cause?.code ?? error?.cause?.message;
    throw new Error(cause ? `${error.message} (${cause})` : error.message);
  }
}

async function runWithSessionRecovery(fn, cfg) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SessionExpiredError && session.creds && !session.reauthed) {
      session.reauthed = true;
      session.warmedGroups.clear();
      const refreshed = await loginCelcat(cfg.baseUrl, session.creds, cfg.timeoutMs);
      session.jar = refreshed.jar;
      session.authenticated = refreshed.authenticated;
      return await fn();
    }
    throw error;
  }
}

async function postForm(url, fields, cfg, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    try {
      return await runWithSessionRecovery(() => postFormOnce(url, fields, cfg, cfg.timeoutMs, options), cfg);
    } catch (error) {
      if (error instanceof CelcatAuthError) throw error;
      lastError = error;
      if (attempt < cfg.retries) await sleep(1000 * attempt);
    }
  }
  throw new Error(`${url} : ${lastError?.message ?? "échec"}`);
}

function formFields(monday, calView, cfg, group = cfg.group) {
  return [
    ["start", monday],
    ["end", addDays(monday, 6)],
    ["resType", cfg.resourceType],
    ["calView", calView],
    ["colourScheme", cfg.colourScheme],
    ["federationIds[]", group],
  ];
}

/**
 * Fallback HTML : si l'endpoint JSON échoue sur une session authentifiée mais
 * que la page `/cal` embarque directement `events = [...]`, on les récupère.
 */
async function fetchHtmlFallbackEvents(monday, cfg, group = cfg.group) {
  if (!session.authenticated) return null;
  try {
    const root = String(cfg.baseUrl).replace(/\/+$/, "");
    const calUrl = `${root}/cal?vt=agendaWeek&dt=${monday}&et=group&fid0=${encodeURIComponent(group)}`;
    const cal = await requestWithJar(calUrl, {
      jar: session.jar,
      headers: HTML_HEADERS,
      timeoutMs: Math.min(cfg.timeoutMs, 15000),
      maxRedirects: 5,
    });
    const html = await cal.res.text();
    if (isLoginPage(cal.finalUrl, html)) return null;
    const embedded = extractEmbeddedEvents(html);
    return embedded.length ? embedded : null;
  } catch {
    return null;
  }
}

/**
 * Cherche le couple (endpoint, calView) accepté par l'instance CELCAT.
 * Une seule tentative par combinaison, avec un délai court : en cas de panne on
 * veut un diagnostic rapide plutôt qu'un job qui tourne 10 minutes.
 */
async function probeStrategy(monday, cfg, group = cfg.group) {
  const failures = [];
  let fallback = null;
  for (const endpoint of cfg.endpoints) {
    let endpointRespondedJson = false;
    for (const calView of cfg.calViews) {
      const url = cfg.baseUrl + endpoint;
      try {
        await runWithSessionRecovery(() => ensureGroupWarmed(group, monday, cfg), cfg);
        const events = await runWithSessionRecovery(
          () => postFormOnce(url, formFields(monday, calView, cfg, group), cfg, Math.min(cfg.timeoutMs, 12000), { group }),
          cfg,
        );
        endpointRespondedJson = true;
        if (events.length > 0) {
          strategy.endpoint = endpoint;
          strategy.calView = calView;
          return { endpoint, calView, events };
        }
        fallback ??= { endpoint, calView, events };
        // Une semaine hors cours (août, vacances) renvoie légitimement `[]` :
        // inutile d'interroger d'autres vues ou des chemins 404 si l'endpoint répond déjà en JSON.
        break;
      } catch (error) {
        if (error instanceof CelcatAuthError) throw error;
        failures.push(`${endpoint} (${calView}) → ${error.message}`);
      }
    }
    if (endpointRespondedJson && fallback) break;
  }
  if (fallback) {
    strategy.endpoint = fallback.endpoint;
    strategy.calView = fallback.calView;
    return fallback;
  }
  const embedded = await fetchHtmlFallbackEvents(monday, cfg, group);
  if (embedded) {
    return { endpoint: "/cal", calView: "html", events: embedded };
  }
  throw new Error(`aucun endpoint CELCAT utilisable. ${failures.join(" | ")}`);
}

async function fetchWeekEvents(monday, cfg, options = {}) {
  const group = options.group ?? cfg.group;
  if (!strategy.endpoint) {
    const probed = await probeStrategy(monday, cfg, group);
    return { events: probed.events, endpoint: probed.endpoint, calView: probed.calView };
  }
  await runWithSessionRecovery(() => ensureGroupWarmed(group, monday, cfg), cfg);
  const events = await postForm(
    cfg.baseUrl + strategy.endpoint,
    formFields(monday, strategy.calView, cfg, group),
    cfg,
    { group, optionalGroup: Boolean(options.optionalGroup) },
  );
  return { events, endpoint: strategy.endpoint, calView: strategy.calView };
}

/* ------------------------------------------- protection anti-blocage cron */

/**
 * En exécution planifiée (`schedule`), si la dernière exécution sur `main` a
 * échoué il y a moins de 6 h à cause d'identifiants refusés ou d'un captcha,
 * on n'envoie aucune nouvelle tentative LDAP à l'UVSQ pour ne pas bloquer le
 * compte ENT. Un lancement manuel (`workflow_dispatch`) ou un `push` passe
 * toujours immédiatement.
 */
async function shouldSkipScheduledAuth(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== "schedule" || !env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
    return null;
  }
  const apiHeaders = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "physiquepv-edt-sync",
  };
  try {
    const runsRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/edt-sync.yml/runs?branch=main&status=completed&per_page=3`,
      { headers: apiHeaders, signal: AbortSignal.timeout(8000) },
    );
    if (!runsRes.ok) return null;
    const runsJson = await runsRes.json();
    const lastFailure = (runsJson?.workflow_runs ?? []).find((r) => r.conclusion === "failure");
    if (!lastFailure) return null;
    // Si un run plus récent a réussi, aucun verrou à maintenir.
    const latest = runsJson?.workflow_runs?.[0];
    if (latest && latest.id !== lastFailure.id && latest.conclusion === "success") return null;

    const finishedAt = Date.parse(lastFailure.updated_at || lastFailure.created_at || "");
    if (!Number.isFinite(finishedAt) || Date.now() - finishedAt >= AUTH_COOLDOWN_MS) return null;

    const jobsRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${lastFailure.id}/jobs`,
      { headers: apiHeaders, signal: AbortSignal.timeout(8000) },
    );
    if (!jobsRes.ok) return null;
    const jobsJson = await jobsRes.json();
    const jobId = jobsJson?.jobs?.[0]?.id;
    if (!jobId) return null;

    const annRes = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/check-runs/${jobId}/annotations`,
      { headers: apiHeaders, signal: AbortSignal.timeout(8000) },
    );
    if (!annRes.ok) return null;
    const annotations = await annRes.json();
    const authFailure = Array.isArray(annotations)
      ? annotations.find((a) => /Authentification UVSQ refusée|Captcha UVSQ/i.test(String(a?.title ?? "")))
      : null;
    if (!authFailure) return null;

    const minutesAgo = Math.max(1, Math.round((Date.now() - finishedAt) / 60000));
    return `Dernier refus LDAP / captcha il y a ${minutesAgo} min (pause de sécurité de 6 h en mode planifié pour protéger le compte ENT UVSQ). Corrigez les secrets CELCAT_USERNAME / CELCAT_PASSWORD puis cliquez sur « Run workflow » pour relancer immédiatement.`;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- lecture */

/** Tous les semestres déclarés (`semesters`) ou l'ancien champ unique `semester`. */
function semestersOf(config) {
  const list = Array.isArray(config?.semesters) && config.semesters.length ? config.semesters : [config?.semester ?? {}];
  return list
    .filter((semester) => semester?.start && semester?.end)
    .map((semester) => ({
      id: semester.id ?? semester.label ?? semester.group ?? "semestre",
      label: semester.label ?? config.label,
      group: semester.group ?? config.group,
      tdGroup: semester.tdGroup ?? config.tdGroup,
      start: semester.start,
      end: semester.end,
    }));
}

/** Semestre applicable à une date (le dernier dont le début est passé). */
function semesterAt(semesters, date = todayParis()) {
  const started = semesters.filter((semester) => semester.start <= date);
  return started.length ? started[started.length - 1] : semesters[0];
}

/**
 * Groupes CELCAT à interroger pour un lundi donné : le groupe du semestre
 * courant, plus celui d'un autre semestre déclaré si la semaine le chevauche
 * (ex. `S4MIASHS` dès la semaine du 4 janvier, même quand on est encore en S3).
 */
export function groupsForWeek(monday, semester, semesters = []) {
  const out = semester?.group ? [semester.group] : [];
  const sunday = addDays(monday, 6);
  for (const item of semesters) {
    if (!item?.group || out.includes(item.group)) continue;
    if (item.start && item.end && monday <= item.end && sunday >= item.start) {
      out.push(item.group);
    }
  }
  return out;
}

/**
 * Semaines à interroger pour un semestre : tout le semestre (`--full`), sinon
 * une fenêtre glissante autour d'aujourd'hui. La fenêtre n'est plus écrêtée à
 * la fin du semestre : elle continue d'avancer en janvier et au-delà, pour ne
 * jamais s'arrêter à une date arbitraire.
 *
 * En mode glissant, les dernières semaines de la fenêtre du semestre
 * (`weeksTail`, 4 par défaut) sont aussi rafraîchies à chaque passage : c'est
 * là que l'université publie les rattrapages et les premiers cours de janvier,
 * bien avant la fin décembre — sinon le site s'arrêterait à décembre alors
 * que le planning officiel les montre déjà.
 */
function weekKeys(cfg, semester = cfg.semester) {
  const full = isFullMode();
  const today = todayParis();
  const { start, end } = semester;
  const first = mondayOf(addDays(start, -cfg.marginDaysBefore));
  const last = mondayOf(addDays(end, cfg.marginDaysAfter));

  let from = first;
  let to = last;
  if (!full) {
    from = mondayOf(addDays(today, -7 * (cfg.weeksBackIncremental - 1)));
    to = mondayOf(addDays(today, 7 * cfg.weeksAheadIncremental));
    // On ne sort pas de la fenêtre du semestre à gauche, mais on accepte
    // d'aller voir un peu après sa fin (rattrapages, semestre suivant).
    if (parseDay(from) < parseDay(first)) from = first;
    if (parseDay(to) > parseDay(last)) {
      const beyond = mondayOf(addDays(end, 7 * 6));
      to = parseDay(to) > parseDay(beyond) ? beyond : to;
    }
  }

  const keys = [];
  for (let cursor = from; parseDay(cursor) <= parseDay(to); cursor = addDays(cursor, 7)) keys.push(cursor);
  if (!full) {
    const tail = Math.max(0, Number(cfg.weeksTail ?? 4));
    const window = [];
    for (let cursor = first; parseDay(cursor) <= parseDay(last); cursor = addDays(cursor, 7)) window.push(cursor);
    for (const monday of window.slice(-tail)) if (!keys.includes(monday)) keys.push(monday);
    keys.sort();
  }
  return keys;
}

/* ------------------------------------------- nettoyage RGPD (enseignants) */

const MINI_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â", auml: "ä",
  ccedil: "ç", icirc: "î", iuml: "ï", ocirc: "ô", ouml: "ö", ugrave: "ù", ucirc: "û", uuml: "ü",
  Eacute: "É", Egrave: "È", Ecirc: "Ê", Agrave: "À", Ccedil: "Ç", oelig: "œ", OElig: "Œ",
};

function decodeMiniEntities(value) {
  return String(value ?? "").replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ent) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : Number(ent.slice(1));
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return MINI_ENTITIES[ent] ?? MINI_ENTITIES[ent.toLowerCase()] ?? match;
  });
}

const STAFF_LINE_RE =
  /^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’ -]{0,45},\s*[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’ .-]{0,45}(?:\s*\[[^\]]+\])?$/;
const NON_STAFF_WORD_RE =
  /\b(?:annul\w*|absen\w*|cours|salle|amphi\w*|examen\w*|contr[oô]le|report\w*|gr[eè]ve|distanciel|visio|moodle|fermat|descartes|buffon|joliot|curie|semestre|miashs|licence|master|groupe|option|banalis\w*)\b/i;

function isStaffFragment(fragment) {
  const clean = decodeMiniEntities(fragment).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return Boolean(clean) && !/\d/.test(clean) && STAFF_LINE_RE.test(clean) && !NON_STAFF_WORD_RE.test(clean);
}

/**
 * Retire uniquement les lignes nominatives d'enseignants (« NOM, Prénom ») que
 * CELCAT ajoute en session authentifiée : le dépôt GitHub est public (RGPD), et
 * la page n'affiche pas le nom des enseignants. Les motifs (« Enseignant absent »),
 * salles, matières et groupes restent strictement intacts.
 */
export function stripStaffLines(description) {
  if (typeof description !== "string" || !description.includes(",")) return description;
  const parts = description.split(/(\r?\n\r?\n<br\s*\/?>\r?\n\r?\n)/i);
  let modified = false;
  const cleaned = parts.map((part, idx) => {
    if (idx % 2 === 1) return part; // séparateur de rubrique
    const subParts = part.split(/<br\s*\/?>/i);
    if (!subParts.some((frag) => isStaffFragment(frag))) return part;
    modified = true;
    const kept = subParts.filter((frag) => !isStaffFragment(frag));
    const leading = part.match(/^\s*/)?.[0] ?? "";
    const trailing = part.match(/\s*$/)?.[0] ?? "";
    const inner = kept.map((s) => s.trim()).filter(Boolean).join("<br />");
    return inner ? `${leading}${inner}${trailing}` : trailing || "";
  });
  return modified ? cleaned.join("") : description;
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
  for (const key of keep) {
    if (event[key] !== undefined && event[key] !== null && event[key] !== "") {
      out[key] = key === "description" ? stripStaffLines(String(event[key])) : event[key];
    }
  }
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

/** Résumé markdown des changements publiés dans data/edt.json. */
async function readPublished(root = ROOT, outPath = OUT_PATH) {
  const [core, dataFile] = await Promise.all([
    loadCoreFromRepo(root),
    readFile(outPath, "utf8").then((text) => JSON.parse(text)).catch(() => null),
  ]);
  return { core, data: dataFile, changes: dataFile?.changes ?? [] };
}

async function main() {
  const full = isFullMode();
  const dump = isDumpMode();
  const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  // Le semestre courant dépend de la date : S3 jusqu'en décembre, S4 à partir
  // de janvier. Plus de calendrier qui s'arrête à une date codée en dur.
  const semesters = semestersOf(config);
  const semester = semesterAt(semesters);
  const cfg = {
    ...config.fetch,
    group: semester.group,
    tdGroup: semester.tdGroup,
    semester: { start: semester.start, end: semester.end },
    semesters,
    retries: Number(process.env.EDT_RETRIES ?? config.fetch.retries ?? 3),
    timeoutMs: Number(process.env.EDT_TIMEOUT_MS ?? config.fetch.timeoutMs ?? 25000),
  };
  const keys = weekKeys(cfg, cfg.semester);
  const creds = readCredentials();

  console.log(
    `[edt] node ${process.version} — groupe ${cfg.group} (${semester.label ?? semester.id}) — ` +
      `${full ? "semestre complet" : "fenêtre glissante"} — ${keys.length} semaines — ` +
      `auth ${creds ? "LDAP configurée" : "anonyme (aucun secret CELCAT_USERNAME)"}`,
  );
  console.log(`[edt] fenêtre : ${keys[0]} → ${keys.at(-1)} (aujourd'hui : ${todayParis()})`);
  console.log(`[edt] semestres suivis : ${semesters.map((item) => `${item.group} ${item.start}→${item.end}`).join(" | ")}`);
  console.log(`[edt] cible : ${cfg.baseUrl}${cfg.endpoints[0]}`);

  resetSession();
  session.creds = creds;

  if (creds) {
    const cooldownReason = await shouldSkipScheduledAuth();
    if (cooldownReason) {
      console.warn(`[edt] ${cooldownReason}`);
      console.log(`::warning title=Pause anti-blocage UVSQ::${cooldownReason.replaceAll("%", "%25")}`);
      return;
    }
    const auth = await loginCelcat(cfg.baseUrl, creds, cfg.timeoutMs);
    session.jar = auth.jar;
    session.authenticated = auth.authenticated;
    console.log(`[edt] session CELCAT : ${auth.authenticated ? "authentifiée via /LdapLogin" : "accès public direct"}`);
  }

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
      const weekGroups = groupsForWeek(monday, semester, semesters);
      const primaryResult = await fetchWeekEvents(monday, cfg, { group: weekGroups[0], optionalGroup: false });
      const mergedById = new Map();
      for (const raw of primaryResult.events) {
        const slim = slimEvent(raw);
        mergedById.set(slim.id ?? JSON.stringify(slim), slim);
      }

      // Semaines de charnière (ex. début janvier vu depuis décembre) : on
      // interroge aussi le semestre suivant sans faire échouer la synchro s'il
      // n'est pas encore publié dans CELCAT.
      for (const extraGroup of weekGroups.slice(1)) {
        try {
          const extra = await fetchWeekEvents(monday, cfg, { group: extraGroup, optionalGroup: true });
          for (const raw of extra.events) {
            const slim = slimEvent(raw);
            mergedById.set(slim.id ?? JSON.stringify(slim), slim);
          }
        } catch (extraError) {
          if (extraError instanceof CelcatAuthError) throw extraError;
          if (!process.env.EDT_QUIET) {
            console.log(`[edt] ${monday} (${extraGroup} optionnel) ignoré : ${extraError.message}`);
          }
        }
      }

      const slim = [...mergedById.values()].sort((a, b) => String(a.start).localeCompare(String(b.start)));
      weeks[monday] = {
        monday,
        fetchedAt: now,
        endpoint: primaryResult.endpoint,
        calView: primaryResult.calView,
        events: slim,
      };
      fetched++;
      totalEvents += slim.length;
      if (!process.env.EDT_QUIET) {
        console.log(`[edt] ${monday} : ${slim.length} créneau(x) via ${primaryResult.endpoint} (${primaryResult.calView})`);
        if (slim.length) {
          console.log(`[edt] exemple ${monday} → ${JSON.stringify(slim[0])}`);
        }
      }
    } catch (error) {
      if (error instanceof CelcatAuthError) throw error;
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
      `aucun créneau récupéré : vérifie le code du groupe dans edt.config.json (actuellement « ${cfg.group} ») ` +
        "et la fenêtre demandée.",
    );
  }

  // Journal des changements : comparaison de la nouvelle version du planning
  // avec celle déjà publiée. Seules les semaines rafraîchies peuvent avoir
  // bougé, on ne compare donc que celles-là.
  //
  // Cette partie est volontairement isolée : publier le planning reste la
  // priorité, un souci de journal ne doit pas empêcher la synchro de tourner.
  const contentHash = hashEvents(weeks);
  let core = null;
  let detected = [];
  let changes = previous?.changes ?? [];
  try {
    core = await loadCoreFromRepo(ROOT);
    detected = diffWeeks(previous?.weeks ?? {}, weeks, {
      core,
      detectedAt: now,
      onlyKeys: new Set(keys),
    });
    changes = mergeChangeLog(previous?.changes ?? [], detected);
  } catch (error) {
    const message = String(error?.message ?? error).replace(/\s+/g, " ").slice(0, 300);
    console.error(`[edt] journal des changements indisponible : ${message}`);
    console.error(`::warning title=Journal des changements indisponible::${message.replaceAll("%", "%25")}`);
  }

  const output = {
    version: 1,
    generatedAt: now,
    group: cfg.group,
    tdGroup: cfg.tdGroup,
    label: semester.label ?? config.label,
    timezone: TZ,
    semester: { start: semester.start, end: semester.end },
    semesters: semesters.map((item) => ({ ...item })),
    source: `${cfg.baseUrl}/cal?vt=agendaWeek&et=group&fid0=${encodeURIComponent(cfg.group)}`,
    fetchedWeeks: keys,
    contentHash,
    changes,
    weeks,
  };

  const serialized = JSON.stringify(output, null, 2) + "\n";
  const changed = !previous || previous.contentHash !== contentHash;

  if (!changed) {
    console.log(`[edt] aucun changement (hash ${contentHash}) — ${Object.keys(weeks).length} semaines connues, fichier inchangé.`);
  } else {
    await mkdir(path.dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, serialized, "utf8");
    console.log(
      `[edt] data/edt.json écrit : ${Object.keys(weeks).length} semaines, ` +
        `${Object.values(weeks).reduce((n, w) => n + (w.events?.length ?? 0), 0)} créneaux, hash ${contentHash}`,
    );
  }

  // On informe, clairement : une ligne par changement, dans le journal du
  // workflow, et un tableau markdown dans le résumé de l'exécution.
  if (!process.env.EDT_QUIET) {
    if (detected.length) {
      console.log(`[edt] ${detected.length} changement(s) détecté(s) à signaler aux étudiants :`);
      for (const change of detected) console.log(`[edt]   • ${changeLine(core, change)}`);
    } else {
      console.log("[edt] aucun changement à signaler.");
    }
  }

  if (detected.length && process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    const markdown = summaryMarkdown(core, detected, { generatedAt: now, title: "Changements détectés dans le planning" });
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}\n`, "utf8").catch(() => {});
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

/* ---------------------------------------------------------- résumés (CLI) */

/**
 * Changements de la dernière synchronisation : ceux dont la première détection
 * correspond à la version publiée (les plus anciens gardent leur date d'origine
 * et ne sont donc pas recomptés à chaque passage).
 */
export function lastDetectedChanges(data) {
  const detectedAt = data?.generatedAt ?? null;
  return (data?.changes ?? []).filter((change) => change.detectedAt === detectedAt);
}

/** `--summary` : tableau markdown des changements de la dernière synchronisation. */
async function printSummary() {
  const { core, data } = await readPublished();
  if (!data) {
    console.log("_data/edt.json est absent : aucun changement publié._");
    return;
  }
  process.stdout.write(summaryMarkdown(core, lastDetectedChanges(data), { generatedAt: data.generatedAt }));
}

/** `--summary-subject` : sujet court pour le message de commit. */
async function printSummarySubject() {
  const { core, data } = await readPublished();
  const subject = summarySubject(core, lastDetectedChanges(data));
  if (subject) console.log(subject);
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const summaryMode = process.argv.includes("--summary");
  const subjectMode = process.argv.includes("--summary-subject");
  const task = summaryMode ? printSummary() : subjectMode ? printSummarySubject() : main();
  task.catch((error) => {
    const isAuth = error instanceof CelcatAuthError;
    const message = String(isAuth ? error.message : (error?.stack ?? error))
      .replace(/\s+/g, " ")
      .slice(0, 1200);
    let title = summaryMode || subjectMode ? "Résumé du planning en échec" : "Synchro CELCAT en échec";
    if (isAuth) {
      if (error.kind === "auth_required") title = "Secrets UVSQ requis (CELCAT_USERNAME / CELCAT_PASSWORD)";
      else if (error.kind === "captcha") title = "Captcha UVSQ déclenché sur edt.uvsq.fr";
      else title = "Authentification UVSQ refusée";
    }
    console.error(`[edt] erreur fatale : ${message}`);
    // En exécution planifiée sans secrets configurés, le workflow transforme le
    // code 2 en simple avertissement pour ne pas désactiver le cron GitHub.
    const level = isAuth && error.kind === "auth_required" && process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
      ? "warning"
      : "error";
    console.error(`::${level} title=${title}::${message.replaceAll("%", "%25")}`);
    process.exit(isAuth ? error.exitCode : 1);
  });
}

export {
  main,
  todayParis,
  addDays,
  mondayOf,
  weekKeys,
  semestersOf,
  semesterAt,
  slimEvent,
  hashEvents,
  postForm,
  probeStrategy,
  fetchWeekEvents,
  printSummary,
  printSummarySubject,
};
