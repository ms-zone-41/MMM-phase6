/* MagicMirror²
 * Node Helper: MMM-phase6
 *
 * Logs in to phase6 and reads the family overview.
 *
 * MIT Licensed.
 */

const NodeHelper = require("node_helper");

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
			const accounts = selectAccounts(parseProfiles(await this.fetchOverview()), this.config);
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
		const form = parseLoginForm(page.html);
		if (!form) {
			throw new Error("The login page of phase6 has no login form");
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
