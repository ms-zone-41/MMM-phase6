/**
 * Node Helper for MMM-phase6
 *
 * Logs into https://www.phase-6.de/classic/service/user/ and scrapes stats.
 *
 * This is intentionally written defensively because phase6 may change markup.
 * If it breaks, capture your browser Network request(s) and adjust selectors/regex.
 *
 * @license MIT
 */
const NodeHelper = require("node_helper");
const Log = require("logger");
const tough = require("tough-cookie");
const cheerio = require("cheerio");

// fetch-cookie wraps the native fetch (Node 18+) with a cookie jar
let fetchCookie;
try {
  const fc = require("fetch-cookie");
  fetchCookie = fc.default || fc;
} catch (e) {
  Log.warn("MMM-phase6: 'fetch-cookie' not found. Session cookies will not persist across requests. Run 'npm install' inside the module directory.");
  fetchCookie = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(str) {
  return (str || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function safeUrl(baseUrl, pathOrUrl) {
  try {
    return new URL(pathOrUrl, baseUrl).toString();
  } catch (e) {
    return String(pathOrUrl || "");
  }
}

function pickFirstNonEmpty(arr) {
  for (const v of arr) {
    const s = (v || "").trim();
    if (s) return s;
  }
  return "";
}

function escapeRegExp(str) {
  return String(str || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenizeName(name) {
  return String(name || "")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function stripTokenFromName(name, tokenOrPhrase) {
  const tokensToRemove = tokenizeName(tokenOrPhrase);
  if (!tokensToRemove.length) return String(name || "").trim();

  const removeSet = new Set(tokensToRemove.map((t) => t.toLowerCase()));
  const parts = tokenizeName(name);
  const cleaned = parts.filter((p) => !removeSet.has(p.toLowerCase()));
  return cleaned.length ? cleaned.join(" ") : String(name || "").trim();
}

function inferSurnameToken(childNames, parentName) {
  const children = Array.isArray(childNames) ? childNames.filter(Boolean) : [];
  const parent = String(parentName || "").trim();

  // 1) If there are at least two children, take intersection of tokens.
  if (children.length >= 2) {
    const tokenSets = children.map((n) => new Set(tokenizeName(n).map((t) => t.toLowerCase())));
    const first = Array.from(tokenSets[0]);
    const common = first.filter((t) => tokenSets.every((s) => s.has(t)));
    if (common.length) {
      // Prefer the longest token (often the surname)
      common.sort((a, b) => b.length - a.length);
      return common[0];
    }
  }

  // 2) Fallback: choose the parent token that occurs most in children.
  if (parent && children.length) {
    const parentTokens = tokenizeName(parent).map((t) => t.toLowerCase());
    const childTokenSets = children.map((n) => new Set(tokenizeName(n).map((t) => t.toLowerCase())));

    let best = "";
    let bestCount = 0;
    for (const pt of parentTokens) {
      let count = 0;
      for (const s of childTokenSets) if (s.has(pt)) count++;

      if (count > bestCount || (count === bestCount && pt.length > best.length)) {
        best = pt;
        bestCount = count;
      }
    }

    // Only accept if it actually matches at least one child.
    if (best && bestCount >= 1) return best;
  }

  return "";
}

function extractAccountsFromHtml(html, config = {}) {
  const $ = cheerio.load(html);

  const includeNames = Array.isArray(config.showAccounts)
    ? config.showAccounts.map((s) => String(s || "").toLowerCase()).filter(Boolean)
    : [];

  const excludeNames = Array.isArray(config.excludeAccounts)
    ? config.excludeAccounts.map((s) => String(s || "").toLowerCase()).filter(Boolean)
    : [];

  function normalizeCandidates(nameOrList) {
    const list = Array.isArray(nameOrList) ? nameOrList : [nameOrList];
    return list
      .map((s) => String(s || "").toLowerCase().trim())
      .filter(Boolean);
  }

  function isExcluded(nameOrList) {
    const candidates = normalizeCandidates(nameOrList);
    if (!candidates.length) return false;
    return candidates.some((c) => excludeNames.includes(c));
  }

  function isIncluded(nameOrList) {
    if (!includeNames.length) return true;
    const candidates = normalizeCandidates(nameOrList);
    return candidates.some((c) => includeNames.includes(c));
  }

  function metricSpanText($panel, labelRe) {
    const $small = $panel
      .find("small")
      .filter((_, el) => labelRe.test($(el).text()))
      .first();

    if (!$small.length) return null;

    // Prefer the inner <span> (phase6 uses it for values)
    const spanText = normalizeWhitespace($small.find("span").first().text());
    if (spanText) return spanText;

    // Fallback: strip the label from the full small text
    const full = normalizeWhitespace($small.text());
    const cleaned = full.replace(labelRe, "").replace(/^\s*:\s*/, "").trim();
    return cleaned || null;
  }

  function extractNameAndLicense($panel) {
    // Name is typically in the first <b> inside .list-statistics
    let $b = $panel.find(".list-statistics b").first();
    if (!$b.length) $b = $panel.find("b").first();

    if (!$b.length) return { fullName: "", license: "" };

    // License label is usually nested inside <span class="user-premium-label">...
    let license = normalizeWhitespace($b.find(".user-premium-label").first().text());
    if (!license) license = normalizeWhitespace($panel.find(".user-premium-label").first().text());

    // Clone and remove nested premium/label spans so the remaining text is only the name
    const $clone = $b.clone();
    $clone.find(".user-premium-label").remove();

    let fullName = normalizeWhitespace($clone.text());

    // As an extra safety net: strip the license text if it is still present for any reason
    if (license) {
      const re = new RegExp(`\\b${escapeRegExp(license)}\\b`, "i");
      fullName = normalizeWhitespace(fullName.replace(re, " "));
    }

    // Sometimes the name ends up split across lines (because the label was inline). Keep the first line.
    const lines = fullName.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length) fullName = lines[0];

    return { fullName, license };
  }

  // --- Attempt 0: phase6 family overview (/classic/service/user/parent/)
  // On that page, each profile is rendered as a panel like:
  //   <div class="button row panel child premium"> ...
  // Parent has typically NO "child" class.
  const panels = $("div.button.row.panel");
  const accounts = [];

  if (panels.length) {
    // First, collect all real profile panels (including parent) so we can infer
    // a common family name token (optional, for privacy/UI).
    const rawPanels = [];

    panels.each((_, el) => {
      const $p = $(el);
      const isChild = $p.hasClass("child");

      const { fullName, license } = extractNameAndLicense($p);

      // Metrics
      const lastLearnedRaw = metricSpanText($p, /Zuletzt\s+(?:gelernt|geübt)\s*:/i);
      const dueRaw = metricSpanText($p, /Fällige\s+(?:Vokabeln|Kärtchen)\s*:/i);
      const streakRaw = metricSpanText($p, /Tage\s+in\s+Folge\s+(?:gelernt|geübt)\s*:/i);

      // Special case: "Bislang noch nicht gelernt" (no date)
      const fullText = normalizeWhitespace($p.text());
      const neverLearned = /Bislang\s+noch\s+nicht\s+(?:gelernt|geübt)/i.test(fullText);

      const lastLearned = neverLearned ? null : (lastLearnedRaw || null);
      const dueVocab = (dueRaw != null && /^\d+$/.test(dueRaw)) ? Number(dueRaw) : null;
      const streakDays = (streakRaw != null && /^\d+$/.test(streakRaw)) ? Number(streakRaw) : null;

      // Only keep panels that actually contain (at least) one of the relevant metrics.
      // (Some panels can be upsell blocks etc.)
      if (dueVocab == null && streakDays == null && lastLearned == null) return;

      rawPanels.push({
        isChild,
        fullName: fullName || "Profil",
        license: license || "",
        lastLearned,
        dueVocab,
        streakDays
      });
    });

    if (rawPanels.length) {
      const explicitSurname = String(config.surnameToHide || "").trim();

      const childNames = rawPanels
        .filter((p) => p.isChild)
        .map((p) => p.fullName)
        .filter(Boolean);

      const parentName = (rawPanels.find((p) => !p.isChild) || {}).fullName || "";

      // Decide which token(s) to remove from display names.
      const surnameToken = explicitSurname
        ? explicitSurname
        : (config.hideSurname === true ? inferSurnameToken(childNames, parentName) : "");

      rawPanels.forEach((p) => {
        if (config.onlyChildren === true && !p.isChild) return;

        const safeName = p.fullName || "Profil";
        const displayName = (config.hideSurname === true && surnameToken)
          ? stripTokenFromName(safeName, surnameToken)
          : safeName;

        // Allow filtering by either full name or display name.
        const nameCandidates = [safeName, displayName];
        if (!isIncluded(nameCandidates) || isExcluded(nameCandidates)) return;

        accounts.push({
          name: safeName,
          displayName: displayName || safeName,
          license: p.license || null,
          lastLearned: p.lastLearned,
          dueVocab: p.dueVocab,
          streakDays: p.streakDays
        });
      });

      if (accounts.length) return accounts;
    }
  }

  // --- Attempt 1: generic scan for blocks that contain all three values
  const bodyText = normalizeWhitespace($("body").text());

  const reLast = /(Zuletzt\s+(?:gelernt|geübt)\s*:?\s*)(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2})/i;
  const reDue = /(Fällige\s+(?:Vokabeln|Kärtchen)\s*:?\s*)(\d+)/i;
  const reStreak = /(Tage\s+in\s+Folge\s+(?:gelernt|geübt)\s*:?\s*)(\d+)/i;

  const blocks = [];
  const seen = new Set();

  const candidates = $('*:contains("Zuletzt")').toArray();

  for (const el of candidates) {
    const container = $(el).closest("section,article,div,li,tr,td").first();
    if (!container || !container.length) continue;

    const txt = normalizeWhitespace(container.text());
    if (!reLast.test(txt) || !reDue.test(txt) || !reStreak.test(txt)) continue;

    const key = container.html();
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push(container);
  }

  for (const container of blocks) {
    const txt = normalizeWhitespace(container.text());

    const last = (txt.match(reLast) || [])[2] || null;
    const due = (txt.match(reDue) || [])[2] || null;
    const streak = (txt.match(reStreak) || [])[2] || null;

    const nameCandidates = [];
    container.find("h1,h2,h3,h4,strong,b").each((_, el) => {
      // In some variants the premium label is nested in the heading/b tag.
      // Keep only the first meaningful line.
      const t = normalizeWhitespace($(el).text());
      const firstLine = (t.split("\n").map((l) => l.trim()).filter(Boolean)[0] || "");
      if (firstLine && firstLine.length <= 60) nameCandidates.push(firstLine);
    });

    let name = pickFirstNonEmpty(nameCandidates);

    if (!name) {
      const before = txt.split(/Zuletzt\s+(?:gelernt|geübt)/i)[0] || "";
      const lines = before.split("\n").map((s) => s.trim()).filter(Boolean);
      name = lines.length ? lines[lines.length - 1] : "";
      if (name.length > 60) name = "";
    }

    const safeName = name || "Profil";
    if (!isIncluded(safeName) || isExcluded(safeName)) continue;

    accounts.push({
      name: safeName,
      lastLearned: last,
      dueVocab: due != null ? Number(due) : null,
      streakDays: streak != null ? Number(streak) : null
    });
  }

  // --- Attempt 2: global regex fallback
  if (!accounts.length) {
    const global = new RegExp(
      /Zuletzt\s+(?:gelernt|geübt)\s*:?\s*(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}).*?Fällige\s+(?:Vokabeln|Kärtchen)\s*:?\s*(\d+).*?Tage\s+in\s+Folge\s+(?:gelernt|geübt)\s*:?\s*(\d+)/gis
    );
    let m;
    let i = 1;
    while ((m = global.exec(bodyText)) !== null) {
      const safeName = `Profil ${i++}`;
      if (!isIncluded(safeName) || isExcluded(safeName)) continue;

      accounts.push({
        name: safeName,
        lastLearned: m[1],
        dueVocab: Number(m[2]),
        streakDays: Number(m[3])
      });
      if (global.lastIndex === m.index) global.lastIndex++;
    }
  }

  return accounts;
}


module.exports = NodeHelper.create({
  start: function () {
    this.config = null;

    this.jar = new tough.CookieJar();
    if (fetchCookie) {
      this.fetch = fetchCookie(fetch, this.jar);
    } else {
      this.fetch = fetch;
    }

    this.timer = null;
    this.isFetching = false;
    this.loggedInVerified = false;
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "PHASE6_CONFIG") {
      this.config = payload || {};
      this.loggedInVerified = false;
      this.scheduleFetch(0);
    }
  },

  scheduleFetch: function (delayMs) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fetchAndSend(), delayMs);
  },

  async fetchWithTimeout(url, options = {}) {
    const timeoutMs = Number(this.config.requestTimeoutMs || 20000);
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = Object.assign(
        {
          "User-Agent": "MMM-phase6 (MagicMirror)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "de-DE,de;q=0.9,en;q=0.6"
        },
        options.headers || {}
      );

      const res = await this.fetch(url, Object.assign({}, options, { headers, signal: controller.signal }));
      return res;
    } finally {
      clearTimeout(t);
    }
  },

  async ensureCookiesFromConfig() {
    const cookies = Array.isArray(this.config.sessionCookies) ? this.config.sessionCookies : [];
    if (!cookies.length) return;

    const baseUrl = this.config.baseUrl || "https://www.phase-6.de";
    for (const c of cookies) {
      if (!c || typeof c !== "string") continue;
      // tough-cookie can parse "key=value" when given a currentUrl
      try {
        await this.jar.setCookie(c, baseUrl);
      } catch (e) {
        // ignore malformed cookies
      }
    }
  },

  async isLoggedIn() {
    const baseUrl = this.config.baseUrl || "https://www.phase-6.de";
    const overviewUrl = safeUrl(baseUrl, this.config.overviewPath || "/classic/service/user/parent/");

    const res = await this.fetchWithTimeout(overviewUrl, { method: "GET", redirect: "follow" });
    const finalUrl = (res && res.url) ? res.url : overviewUrl;
    const html = await res.text();
    const $ = cheerio.load(html);

    // Strong signal: redirected to login page
    if (/\/classic\/service\/user\/login\.html/i.test(finalUrl)) return false;

    // Strong signal: login form present
    if ($('input[type="password"]').length > 0) return false;

    // Heuristic: typical login page strings
    const text = normalizeWhitespace($("body").text());
    if (/Passwort\s+vergessen/i.test(text) && /Registrieren/i.test(text) && /\bLogin\b/i.test(text)) return false;

    return true;
  },

  async login() {
    const baseUrl = this.config.baseUrl || "https://www.phase-6.de";
    const loginUrl = safeUrl(baseUrl, this.config.loginPath || "/classic/service/user/login.html");

    const username = (this.config.username || process.env.PHASE6_USER || "").trim();
    const password = (this.config.password || process.env.PHASE6_PASS || "").trim();

    if ((!username || !password) && !(Array.isArray(this.config.sessionCookies) && this.config.sessionCookies.length)) {
      throw new Error(
        "No credentials configured. Set username/password in config.js "
        + "or provide PHASE6_USER/PHASE6_PASS environment variables."
      );
    }

    // If user supplied cookies, try them first.
    await this.ensureCookiesFromConfig();
    if (await this.isLoggedIn()) {
      this.loggedInVerified = true;
      return;
    }

    // Fetch login page to discover the form (action, hidden inputs, field names).
    const res = await this.fetchWithTimeout(loginUrl, { method: "GET", redirect: "follow" });
    const html = await res.text();
    const $ = cheerio.load(html);

    // Pick the form that contains a password field.
    let form = null;
    $("form").each((_, el) => {
      if (form) return;
      const hasPw = $(el).find('input[type="password"]').length > 0;
      if (hasPw) form = $(el);
    });

    if (!form) {
      throw new Error(
        "Login form not found (the page may load it via JavaScript). "
        + "Try using sessionCookies instead."
      );
    }

    const method = (form.attr("method") || "POST").toUpperCase();
    const actionAttr = form.attr("action") || loginUrl;
    const actionUrl = safeUrl(baseUrl, actionAttr);

    // Detect field names
    const pwInput = form.find('input[type="password"]').first();
    const pwName = pwInput.attr("name") || "password";

    let userInput = form.find('input[type="email"]').first();
    if (!userInput.length) {
      userInput = form.find('input[name*="mail" i], input[name*="email" i]').first();
    }
    if (!userInput.length) {
      userInput = form.find('input[type="text"]').first();
    }
    const userNameField = userInput.attr("name") || "email";

    // Gather hidden fields (CSRF, etc.)
    const params = new URLSearchParams();
    form.find('input[type="hidden"]').each((_, el) => {
      const n = $(el).attr("name");
      const v = $(el).attr("value") || "";
      if (n) params.set(n, v);
    });

    params.set(userNameField, username);
    params.set(pwName, password);

    // Some forms use <button name="..."> or require submit value.
    const submit = form.find('button[type="submit"], input[type="submit"]').first();
    if (submit && submit.length) {
      const sn = submit.attr("name");
      const sv = submit.attr("value");
      if (sn && sv != null) params.set(sn, sv);
    }

    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": baseUrl,
      "Referer": loginUrl
    };

    await this.fetchWithTimeout(actionUrl, {
      method,
      headers,
      body: params.toString(),
      redirect: "follow"
    });

    // Give the server a moment (some apps set cookies after redirect chains).
    await sleep(250);

    const ok = await this.isLoggedIn();
    if (!ok) {
      throw new Error(
        "Login failed (or additional verification/SSO required). "
        + "Check username/password or try sessionCookies."
      );
    }
    this.loggedInVerified = true;
  },

  async fetchAndSend() {
    if (!this.config || this.isFetching) return;
    this.isFetching = true;

    const updateInterval = Number(this.config.updateInterval || 10 * 60 * 1000);

    try {
      await this.login();

      const baseUrl = this.config.baseUrl || "https://www.phase-6.de";
      const overviewUrl = safeUrl(baseUrl, this.config.overviewPath || "/classic/service/user/parent/");

      const res = await this.fetchWithTimeout(overviewUrl, { method: "GET", redirect: "follow" });
      const html = await res.text();

      const accounts = extractAccountsFromHtml(html, this.config);

      const data = {
        accounts,
        fetchedAt: new Date().toISOString()
      };

      this.sendSocketNotification("PHASE6_DATA", { ok: true, data });
    } catch (err) {
      this.sendSocketNotification("PHASE6_DATA", { ok: false, error: (err && err.message) ? err.message : String(err) });
    } finally {
      this.isFetching = false;
      this.scheduleFetch(updateInterval);
    }
  }
});
