/* MagicMirror²
 * Node Helper: MMM-phase6
 *
 * Logs in to phase6 and reads the family overview.
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");
const Log = require("logger");

// The named entities that the pages of phase6 may have
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß" };

// Text with its entities decoded
function decode(text) {
	return text.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (entity, decimal, hex, name) => {
		if (name) {
			return ENTITIES[name] ?? entity;
		}
		return String.fromCodePoint(Number.parseInt(decimal ?? hex, decimal ? 10 : 16));
	});
}

// The text of some HTML: without comments and tags, decoded, with single
// spaces
function textOf(html) {
	return decode(html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// The value of an attribute in a tag, decoded
function attributeOf(tag, name) {
	const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
	return match ? decode(match[1]) : null;
}

// The profiles of the family overview, in its order. Each profile has a
// panel, a div with the classes button, row and panel, and child for a child:
//
//   <div class="button row panel child  premium ">
//     … <b data-mf-replace-inner="*REMOVED NAME*">Muster Emma
//         <span class="user-premium-label">PLUS aktiv</span></b>
//     <small …>emma.muster@example.com</small>
//     <small>…Zuletzt gelernt: <span>10.10.2026 15:25</span></small>
//     <small>…Fällige Vokabeln: <span>29</span></small>
//     <small>…Tage in Folge gelernt: <span>28</span></small>
//
// A profile that has never learned shows "Bislang noch nicht gelernt <span>
// </span>" instead of the date. Panels without a number of due vocabulary,
// e.g. offers, are not profiles.
function parseProfiles(html) {
	const panels = [...html.matchAll(/<div\s+class="([^"]*)"/g)].filter(([, classes]) => ["button", "row", "panel"].every((name) => classes.split(/\s+/).includes(name)));
	return panels.flatMap((panel, index) => {
		const part = html.slice(panel.index, panels[index + 1]?.index);
		// The text in the span after a label
		const value = (label) => {
			const match = new RegExp(`${label}:\\s*<span>([^<]*)</span>`).exec(part);
			return match ? textOf(match[1]) : null;
		};
		// A number, also with dots between thousands, e.g. 1.234
		const number = (text) => (/^\d{1,3}(\.\d{3})*$|^\d+$/.test(text ?? "") ? Number(text.replaceAll(".", "")) : null);
		const due = number(value("Vokabeln"));
		const streak = number(value("in Folge gelernt"));
		if (due === null || streak === null) {
			return [];
		}
		return [{
			// The text of the <b> up to its first tag, without the subscription
			name: textOf(/<b\b[^>]*>([^<]*)/.exec(part)?.[1] ?? ""),
			child: panel[1].split(/\s+/).includes("child"),
			license: textOf(/class="user-premium-label[^"]*"[^>]*>([^<]*)</.exec(part)?.[1] ?? ""),
			lastLearned: value("Zuletzt gelernt") || null,
			due,
			streak
		}];
	});
}

// The login form of the login page: where to post it, and its hidden fields,
// e.g. josso_cmd and josso_back_to
function parseLoginForm(html) {
	const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find(([, , inside]) => inside.includes("name=\"josso_password\""));
	if (!form) {
		return null;
	}
	const hidden = [...form[2].matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag).filter((tag) => attributeOf(tag, "type") === "hidden");
	return {
		action: attributeOf(form[1], "action"),
		fields: hidden.map((tag) => [attributeOf(tag, "name"), attributeOf(tag, "value") ?? ""])
	};
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

// The accounts to show, with the names to show
function selectAccounts(profiles, config) {
	const includeNames = Array.isArray(config.showAccounts)
		? config.showAccounts.map((s) => String(s || "").toLowerCase()).filter(Boolean)
		: [];

	const excludeNames = Array.isArray(config.excludeAccounts)
		? config.excludeAccounts.map((s) => String(s || "").toLowerCase()).filter(Boolean)
		: [];

	const explicitSurname = String(config.surnameToHide || "").trim();
	const childNames = profiles.filter((p) => p.child).map((p) => p.name);
	const parentName = (profiles.find((p) => !p.child) || {}).name || "";

	// Decide which token(s) to remove from display names.
	const surnameToken = explicitSurname
		? explicitSurname
		: (config.hideSurname === true ? inferSurnameToken(childNames, parentName) : "");

	const accounts = [];
	for (const p of profiles) {
		if (config.onlyChildren === true && !p.child) continue;

		const displayName = (config.hideSurname === true && surnameToken)
			? stripTokenFromName(p.name, surnameToken)
			: p.name;

		// Allow filtering by either full name or display name.
		const candidates = [p.name, displayName].map((n) => n.toLowerCase());
		if (includeNames.length && !candidates.some((c) => includeNames.includes(c))) continue;
		if (candidates.some((c) => excludeNames.includes(c))) continue;

		accounts.push({
			name: p.name,
			displayName,
			license: p.license || null,
			lastLearned: p.lastLearned,
			dueVocab: p.due,
			streakDays: p.streak
		});
	}
	return accounts;
}

// The website of phase6, which is the only one the node helper asks
const PHASE6 = "https://www.phase-6.de";
// The family overview, "Meine Familie › Übersicht", with the profiles of the
// parent and the children
const OVERVIEW = `${PHASE6}/classic/service/user/parent/`;
// Where phase6 sends a browser without a session, and a rejected login
const LOGIN_PAGE = "/classic/service/user/login.html";
// How long phase6 may take to answer a request, in milliseconds
const TIMEOUT = 30 * 1000;
// The shortest time between two updates, and the time until the next try
// while phase6 is not reachable, in milliseconds
const MINUTE = 60 * 1000;

// The options of the node helper and their defaults. It reads them from
// config.js only: any device that the ipWhitelist of MagicMirror² lets in can
// send socket notifications to it.
const DEFAULTS = {
	username: "",
	password: "",
	updateInterval: 10 * MINUTE,
	onlyChildren: true,
	showAccounts: [],
	excludeAccounts: [],
	hideSurname: true,
	surnameToHide: ""
};

// What the log adds about each problem: what to do
const HINTS = {
	NO_CREDENTIALS: "Add it, then restart MagicMirror². See the README.",
	LOGIN_FAILED: "Check the username and the password by logging in at https://www.phase-6.de, correct them, then restart MagicMirror². Until then, the module does not try again, so that phase6 does not lock the account.",
	NOT_REACHABLE: "The module tries again in a minute.",
	MODULE_ERROR_RATE_LIMITED: "The module tries again at the next update.",
	NO_FAMILY: "Use the login of the parent, which shows the children under Meine Familie on phase6. If you do, phase6 may have changed its website: update the module, or report it at https://github.com/ms-zone-41/MMM-phase6/issues."
};

// A problem that the module shows, by its code, with the variables of its
// message, and what the log says about it. The code is that of a message of
// the module, or of MagicMirror², e.g. MODULE_ERROR_RATE_LIMITED.
function problem(code, variables, log) {
	return Object.assign(new Error(log), { code, variables });
}

module.exports = NodeHelper.create({
	// getServerModuleConfig() came with MagicMirror² 2.38.0
	requiresVersion: "2.38.0",

	start() {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		// The cookies of the session with phase6, by name
		this.cookies = new Map();
		// Nothing to send until the first update has finished
		this.state = null;
		this.accounts = null;
		this.fetchedAt = null;
		// An updateInterval in seconds or in minutes would load phase6 again and
		// again
		const interval = Number(this.config.updateInterval) || DEFAULTS.updateInterval;
		this.interval = Math.min(Math.max(interval, MINUTE), 2 ** 31 - 1);
		if (this.interval !== interval) {
			Log.warn(`updateInterval is ${interval} milliseconds: the module updates every ${Math.round(this.interval / 1000)} seconds instead.`);
		}
		const missing = this.findMissingCredentials();
		if (missing) {
			this.report(missing);
			return;
		}
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

	// A username or a password that is missing, or that is still a variable of
	// config/config.env, e.g. ${SECRET_PHASE6_PASSWORD}: MagicMirror² leaves
	// a variable as it is when config.env does not set it
	findMissingCredentials() {
		for (const option of ["username", "password"]) {
			const value = String(this.config[option] ?? "");
			const variable = (/\$\{(\w+)\}/).exec(value)?.[1];
			if (variable) {
				return problem("NO_CREDENTIALS", { name: variable, file: "config/config.env" }, `config.js uses \${${variable}} as the ${option}, but config/config.env does not set ${variable}`);
			}
			if (value.trim() === "") {
				return problem("NO_CREDENTIALS", { name: option, file: "config/config.js" }, `The ${option} is missing in config/config.js`);
			}
		}
		return null;
	},

	// Read the profiles from phase6, send them to the module, and update again
	// updateInterval after the update has finished. So there is one update at
	// a time, however many browsers show the mirror.
	async update() {
		let error = null;
		try {
			this.accounts = selectAccounts(await this.fetchProfiles(), this.config);
			this.fetchedAt = new Date().toISOString();
		} catch (thrown) {
			error = thrown;
		}
		// When MagicMirror² stops during an update, report nothing and do not
		// update again
		if (this.stopped) {
			return;
		}
		this.report(error);
		// After a rejected login, wait for a restart with the right password
		if (error?.code !== "LOGIN_FAILED") {
			this.timer = setTimeout(() => this.update(), error?.code === "NOT_REACHABLE" ? MINUTE : this.interval);
		}
	},

	// Send the profiles of the last update that worked to the module, with the
	// problem of this update, if any. Log a problem when it starts or changes,
	// not after every update.
	report(error) {
		// Errors of Node.js have codes too, e.g. ERR_INVALID_URL
		const hint = HINTS[error?.code];
		const shown = error && (hint ? { code: error.code, ...error.variables } : { code: "MODULE_ERROR_UNSPECIFIED" });
		if (error && JSON.stringify(shown) !== JSON.stringify(this.state?.error)) {
			if (hint) {
				Log.error(`${error.message}. ${hint}`);
			} else {
				Log.error("The update failed:", error);
			}
		} else if (!error && this.state?.error) {
			Log.info("phase6 works again");
		}
		this.state = { accounts: this.accounts, fetchedAt: this.fetchedAt, error: shown };
		this.sendSocketNotification("PROFILES", this.state);
	},

	// The profiles of the family overview. Without a session, phase6 redirects
	// to the login page instead, so log in with its form: phase6 then redirects
	// to the family overview, or back to the login page.
	async fetchProfiles() {
		let page = await this.request(OVERVIEW);
		if (page.url.pathname === LOGIN_PAGE) {
			page = await this.login(page);
			if (page.url.pathname !== LOGIN_PAGE && page.url.pathname !== new URL(OVERVIEW).pathname) {
				page = await this.request(OVERVIEW);
			}
			// Back on the login page, also on the way to the family overview
			if (page.url.pathname === LOGIN_PAGE) {
				const errorCode = page.url.searchParams.get("ErrorCode");
				throw problem("LOGIN_FAILED", {}, `phase6 rejected the login${errorCode ? ` (${errorCode})` : ""}`);
			}
			Log.info("Logged in to phase6");
		}
		if (page.url.pathname !== new URL(OVERVIEW).pathname) {
			throw problem("NO_FAMILY", {}, `phase6 shows ${page.url.pathname} instead of the family overview`);
		}
		const profiles = parseProfiles(page.html);
		if (profiles.length === 0) {
			throw problem("NO_FAMILY", {}, "The family overview of phase6 shows no profiles");
		}
		return profiles;
	},

	// Post the form of the login page, with its hidden fields
	login(page) {
		const form = parseLoginForm(page.html);
		if (!form) {
			throw problem("NO_FAMILY", {}, "The login page of phase6 has no login form");
		}
		const fields = new URLSearchParams(form.fields);
		fields.set("josso_username", String(this.config.username).trim());
		fields.set("josso_password", String(this.config.password));
		return this.request(new URL(form.action || page.url, page.url), {
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
				throw problem("NO_FAMILY", {}, `phase6 redirected to ${next.origin}`);
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
				// fetch() fails with "fetch failed" and the reason as its cause
				const detail = error.name === "TimeoutError" ? "timeout" : error.cause?.code ?? error.cause?.message ?? error.message;
				throw problem("NOT_REACHABLE", { detail }, `phase6 is not reachable: ${detail}`);
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
				const detail = `HTTP ${response.status}`;
				// phase6 is down, asks for fewer requests, or does not have the page
				if (response.status >= 500) {
					throw problem("NOT_REACHABLE", { detail }, `phase6 is not reachable: ${detail}`);
				}
				throw problem(response.status === 429 ? "MODULE_ERROR_RATE_LIMITED" : "NO_FAMILY", {}, `phase6 answered ${next.pathname} with ${detail}`);
			}
			return { url: next, html };
		}
		throw problem("NO_FAMILY", {}, "phase6 redirected too often");
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
