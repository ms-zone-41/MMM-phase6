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
const cheerio = require("cheerio");

function normalizeWhitespace(str) {
	return (str || "")
		.replace(/\u00a0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\s*\n\s*/g, "\n")
		.trim();
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

	const candidates = $("*:contains(\"Zuletzt\")").toArray();

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

// The website of phase6, which is the only one the node helper asks
const PHASE6 = "https://www.phase-6.de";
// The family overview, with the profiles of the parent and the children
const OVERVIEW = `${PHASE6}/classic/service/user/parent/`;
// Where phase6 sends a browser without a session, and a rejected login
const LOGIN_PAGE = "/classic/service/user/login.html";
// How long phase6 may take to answer a request, in milliseconds
const TIMEOUT = 30 * 1000;

// The options of the node helper and their defaults. It reads them from
// config.js only: any device that the ipWhitelist of MagicMirror² lets in can
// send socket notifications to it.
const DEFAULTS = {
	username: "",
	password: "",
	updateInterval: 10 * 60 * 1000,
	onlyChildren: true,
	showAccounts: [],
	excludeAccounts: [],
	hideSurname: true,
	surnameToHide: ""
};

module.exports = NodeHelper.create({
	// getServerModuleConfig() came with MagicMirror² 2.38.0
	requiresVersion: "2.38.0",

	start() {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		// The cookies of the session with phase6, by name
		this.cookies = new Map();
		// Nothing to send until the first update has finished
		this.state = null;
		this.update();
	},

	stop() {
		this.stopped = true;
		clearTimeout(this.timer);
	},

	// The module asks for the profiles when it starts. The payload is ignored.
	socketNotificationReceived(notification) {
		if (notification === "GET_PROFILES" && this.state) {
			this.sendSocketNotification("PROFILES", this.state);
		}
	},

	// Read the profiles from phase6, send them to the module, and update again
	// updateInterval after the update has finished. So there is one update at
	// a time, however many browsers show the mirror.
	async update() {
		try {
			const accounts = extractAccountsFromHtml(await this.fetchOverview(), this.config);
			this.state = { ok: true, data: { accounts, fetchedAt: new Date().toISOString() } };
		} catch (err) {
			this.state = { ok: false, error: err.message };
		}
		// When MagicMirror² stops during an update, report nothing and do not
		// update again
		if (this.stopped) {
			return;
		}
		this.sendSocketNotification("PROFILES", this.state);
		this.timer = setTimeout(() => this.update(), Number(this.config.updateInterval) || DEFAULTS.updateInterval);
	},

	// The HTML of the family overview. Without a session, phase6 redirects to
	// the login page instead, so log in with its form: phase6 then redirects
	// to the family overview, or back to the login page.
	async fetchOverview() {
		if (!this.config.username || !this.config.password) {
			throw new Error("No credentials configured. Set username and password in config.js.");
		}
		let page = await this.request(OVERVIEW);
		if (page.url.pathname === LOGIN_PAGE) {
			page = await this.login(page);
			if (page.url.pathname === LOGIN_PAGE) {
				throw new Error("phase6 rejected the username or the password");
			}
		}
		if (page.url.pathname !== new URL(OVERVIEW).pathname) {
			page = await this.request(OVERVIEW);
		}
		return page.html;
	},

	// Post the form of the login page, with its hidden fields
	login(page) {
		const $ = cheerio.load(page.html);
		const form = $("form").filter((_, el) => $(el).find("input[name=\"josso_password\"]").length > 0).first();
		if (!form.length) {
			throw new Error("The login page of phase6 has no login form");
		}
		const fields = new URLSearchParams();
		form.find("input[type=\"hidden\"]").each((_, el) => {
			fields.set($(el).attr("name"), $(el).attr("value") ?? "");
		});
		fields.set("josso_username", String(this.config.username).trim());
		fields.set("josso_password", String(this.config.password));
		return this.request(new URL(form.attr("action") ?? page.url, page.url), {
			method: "POST",
			body: fields,
			headers: { Origin: PHASE6, Referer: page.url.href }
		});
	},

	// Fetch a page of phase6 with the cookies of the session, and follow the
	// redirects: fetch() keeps no cookies, and phase6 sets those of the
	// session in redirects
	async request(url, { method = "GET", body, headers } = {}) {
		let next = new URL(url);
		for (let redirects = 0; redirects <= 10; redirects++) {
			if (next.origin !== PHASE6) {
				throw new Error(`phase6 redirected to ${next.origin}`);
			}
			let response;
			let html;
			try {
				response = await fetch(next, {
					method,
					body,
					redirect: "manual",
					headers: {
						...headers,
						"User-Agent": "MMM-phase6 (MagicMirror²)",
						"Accept-Language": "de",
						"Cookie": [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
					},
					signal: AbortSignal.timeout(TIMEOUT)
				});
				// The timeout or a lost connection can also end reading the page
				html = await response.text();
			} catch (error) {
				throw new Error(error.name === "TimeoutError" ? `phase6 did not answer within ${TIMEOUT / 1000} seconds` : `phase6 cannot be reached: ${error.cause?.code ?? error.message}`, { cause: error });
			}
			this.keepCookies(response);
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				// Like a browser, follow the redirect with GET
				next = new URL(location, next);
				method = "GET";
				body = undefined;
				headers = undefined;
				continue;
			}
			if (!response.ok) {
				throw new Error(`phase6 answered with HTTP ${response.status}`);
			}
			return { url: next, html };
		}
		throw new Error("phase6 redirected too often");
	},

	// Keep the cookies that a response sets, and forget those it deletes,
	// which have no value. All of them are for www.phase-6.de and the path /.
	keepCookies(response) {
		for (const cookie of response.headers.getSetCookie()) {
			const [, name, value] = (/^\s*([^=;\s]+)\s*=\s*([^;]*)/).exec(cookie) ?? [];
			if (value) {
				this.cookies.set(name, value);
			} else if (name) {
				this.cookies.delete(name);
			}
		}
	}
});
