/**
 * MagicMirror² Module: MMM-phase6
 * Shows key learning stats from phase6 "Kundenservice" account overview.
 *
 * NOTE: This is an unofficial community module. It logs in to your phase6 account
 * from your MagicMirror device and scrapes the overview page.
 *
 * @license MIT
 * @see https://github.com/ms-zone-41/MMM-phase6
 */
Module.register("MMM-phase6", {
  defaults: {
    baseUrl: "https://www.phase-6.de",
    loginPath: "/classic/service/user/login.html",
    overviewPath: "/classic/service/user/parent/",
    updateInterval: 10 * 60 * 1000, // 10 minutes
    requestTimeoutMs: 20_000,

    // Credentials:
    // IMPORTANT: Do NOT share your credentials in chats. Put them only into your local config.js
    // or provide them via environment variables PHASE6_USER / PHASE6_PASS.
    username: "",
    password: "",

    // Optional: If the site uses an extra cookie/SSO and login scraping fails,
    // you can provide one or more cookies here (copied from your browser).
    // Example: ["JSESSIONID=abc123", "some_cookie=xyz"]
    sessionCookies: [],

    // UI options
    title: "phase6",
    showHeader: true,
    showAccounts: [], // [] = show all; otherwise list of account names to show
    excludeAccounts: [], // list of account names to hide
    onlyChildren: true, // only show child profiles (recommended for /parent/ overview)

    // Name / privacy options
    // hideSurname: tries to remove the family name from the UI (useful for kids)
    // It uses an "auto" heuristic (common token across profiles). If it fails,
    // you can set surnameToHide explicitly.
    hideSurname: true,
    surnameToHide: "", // optional explicit surname to remove (case-insensitive)

    // License label (e.g. "PLUS aktiv")
    // The data is still scraped, but hidden in the UI by default.
    showLicense: false,
    showLastLearned: true,
    // If false, the year is removed from the "Zuletzt" date to keep the table compact.
    // Example: "26.01.2026 15:19" -> "26.01. 15:19"
    lastLearnedShowYear: false,
    showDueVocab: true,
    showStreak: true,
    // Show a "Stand: ..." line below the table (fetch timestamp).
    // Default is false to avoid extra noise.
    showFetchedAt: false,
    locale: "de-DE",
    // Per-account adjustments to the Due count, e.g. { "Emma": -1 }
    dueAdjustments: {}
  },

  getHeader: function () {
    // Use MagicMirror's native header rendering (with the standard underline).
    // Respect a user-provided module header (configured via the MagicMirror "header" field)
    // and fall back to this module's `config.title`.
    if (this.config.showHeader === false) return null;

    const userHeader = (this.data && typeof this.data.header === "string") ? this.data.header.trim() : "";
    if (userHeader) return userHeader;

    return this.config.title || "phase6";
  },

  start: function () {
    this.dataPayload = null;
    this.error = null;
    this.loaded = false;

    this.sendSocketNotification("PHASE6_CONFIG", this.config);
  },

  getStyles: function () {
    return ["phase6.css"];
  },

  getDom: function () {
    const wrapper = document.createElement("div");
    wrapper.className = "mmm-phase6";

    if (!this.loaded) {
      wrapper.innerHTML = "<span class='dimmed light small'>Loading phase6 data &hellip;</span>";
      return wrapper;
    }

    if (this.error) {
      const errTitle = document.createElement("span");
      errTitle.className = "bright small";
      errTitle.textContent = "phase6: Error";
      const errBr = document.createElement("br");
      const errMsg = document.createElement("span");
      errMsg.className = "dimmed light small";
      errMsg.textContent = this.error;
      wrapper.appendChild(errTitle);
      wrapper.appendChild(errBr);
      wrapper.appendChild(errMsg);
      return wrapper;
    }

    const payload = this.dataPayload || {};
    const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];

    if (!accounts.length) {
      const empty = document.createElement("div");
      empty.className = "dimmed light small";
      empty.textContent = "No data found.";
      wrapper.appendChild(empty);
      return wrapper;
    }

    const table = document.createElement("table");
    table.className = "small";

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    const headers = [
      { label: "Profile", className: "mmm-phase6-col-name" },
      { label: "Last", className: "mmm-phase6-col-last" },
      { label: "Due", className: "mmm-phase6-col-due" },
      { label: "Streak", className: "mmm-phase6-col-streak" }
    ];
    headers.forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h.label;
      th.className = h.className;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const filter = (this.config.showAccounts || []).map((s) => (s || "").toLowerCase()).filter(Boolean);
    const exclude = (this.config.excludeAccounts || []).map((s) => (s || "").toLowerCase()).filter(Boolean);

    // Build a normalized lookup for dueAdjustments (case- and whitespace-insensitive).
    const adjMap = this.config.dueAdjustments || {};
    const adjLookup = new Map();
    for (const [k, v] of Object.entries(adjMap)) {
      adjLookup.set(String(k).trim().toLowerCase(), v);
    }
    const findAdj = (name) => {
      if (!name) return undefined;
      return adjLookup.get(String(name).trim().toLowerCase());
    };

    accounts.forEach((acc) => {
      const fullName = acc.name || "";
      const displayName = acc.displayName || acc.name || "—";

      const candidates = [fullName, displayName].map((s) => String(s || "").toLowerCase()).filter(Boolean);

      if (exclude.length && candidates.some((c) => exclude.includes(c))) return;
      if (filter.length && !candidates.some((c) => filter.includes(c))) return;

      const tr = document.createElement("tr");

      // Compute adjusted due count
      let dueVal = acc.dueVocab;
      if (dueVal != null && adjLookup.size > 0) {
        const adj = findAdj(displayName) ?? findAdj(fullName) ?? 0;
        dueVal = Math.max(0, Number(dueVal) + adj);
      }

      const tdName = document.createElement("td");
      const hasDue = dueVal != null && Number(dueVal) > 0;
      tdName.className = hasDue ? "mmm-phase6-name mmm-phase6-name-bold" : "mmm-phase6-name";

      const nameDiv = document.createElement("div");
      nameDiv.className = "mmm-phase6-name-main";
      nameDiv.textContent = displayName;
      tdName.appendChild(nameDiv);

      if (this.config.showLicense && acc.license) {
        const lic = document.createElement("div");
        lic.className = "mmm-phase6-license dimmed light xsmall";
        lic.textContent = String(acc.license);
        tdName.appendChild(lic);
      }

      tr.appendChild(tdName);

      const tdLast = document.createElement("td");
      tdLast.className = "mmm-phase6-last";
      tdLast.textContent = this.config.showLastLearned ? this.formatLastLearned(acc.lastLearned) : "—";
      tr.appendChild(tdLast);

      const tdDue = document.createElement("td");
      tdDue.className = "mmm-phase6-due";
      tdDue.textContent = this.config.showDueVocab ? (dueVal != null ? String(dueVal) : "—") : "—";
      tr.appendChild(tdDue);

      const tdStreak = document.createElement("td");
      tdStreak.className = "mmm-phase6-streak";
      tdStreak.textContent = this.config.showStreak ? (acc.streakDays != null ? String(acc.streakDays) : "—") : "—";
      tr.appendChild(tdStreak);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);

    if (this.config.showFetchedAt && payload.fetchedAt) {
      const ft = document.createElement("div");
      ft.className = "mmm-phase6-fetched dimmed light xsmall";
      try {
        const d = new Date(payload.fetchedAt);
        ft.textContent = "Updated: " + d.toLocaleString(this.config.locale || "de-DE");
      } catch (e) {
        ft.textContent = "Updated: " + payload.fetchedAt;
      }
      wrapper.appendChild(ft);
    }

    return wrapper;
  },

  formatLastLearned: function (value) {
    if (!value) return "—";

    const s = String(value).trim();
    if (!s) return "—";

    // If the user wants the raw value (including year), just return it.
    if (this.config.lastLearnedShowYear === true) return s;

    // Common phase6 format: "DD.MM.YYYY HH:MM" (or without time)
    const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}:\d{2}))?\s*$/);
    if (m) {
      const dd = String(m[1]).padStart(2, "0");
      const mm = String(m[2]).padStart(2, "0");
      const time = m[4] ? String(m[4]).trim() : "";
      return time ? `${dd}.${mm}. ${time}` : `${dd}.${mm}.`;
    }

    // Fallback: try to interpret as date-like string and format without year.
    // (This is best-effort; if parsing fails, we keep the original string.)
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      try {
        const formatted = d.toLocaleString(this.config.locale || "de-DE", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit"
        });
        // Some locales insert a comma between date and time.
        return formatted.replace(",", "");
      } catch (e) {
        // ignore and fall through
      }
    }

    // Last resort: remove a ".YYYY" segment if present anywhere in the string.
    return s.replace(/(\d{1,2}\.\d{1,2})\.\d{2,4}/, "$1.");
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "PHASE6_DATA") {
      this.loaded = true;

      if (!payload || payload.ok !== true) {
        this.error = (payload && payload.error) ? payload.error : "Unknown error.";
        this.dataPayload = null;
      } else {
        this.error = null;
        this.dataPayload = payload.data || null;
      }

      this.updateDom();
    }
  }
});
