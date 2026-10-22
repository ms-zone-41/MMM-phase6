/* MagicMirror²
 * Node Helper: MMM-phase6
 *
 * Logs in to phase6 and reads the family overview, and the due vocabulary
 * from the web app of phase6.
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
//     … onclick="location.assign('/lernen/?redirectUrl=/reports/1000002/list')"
//
// The module takes the name, the streak and the ID of each profile, which
// its links have, e.g. the one to its reports. The family overview shows the
// due vocabulary and when a profile last learned up to an hour late: the
// module reads them from the web app of phase6 instead, see fetchCounts().
// Panels without a number of due vocabulary, e.g. offers, are not profiles.
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
		const streak = number(value("in Folge gelernt"));
		const id = (/(?:ContactID=|\/reports\/|subMenu)(\d+)/).exec(part)?.[1];
		if (number(value("Vokabeln")) === null || streak === null || !id) {
			return [];
		}
		return [{
			// The text of the <b> up to its first tag, without the subscription
			name: textOf(/<b\b[^>]*>([^<]*)/.exec(part)?.[1] ?? ""),
			id,
			child: panel[1].split(/\s+/).includes("child"),
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

// The words of a name, in lower case
function wordsOf(name) {
	return String(name).toLowerCase().split(/\s+/).filter(Boolean);
}

// Whether a name on phase6, e.g. "Muster Emma", has all the words of a name
// in the config, e.g. "Emma"
function matches(name, wanted) {
	const words = wordsOf(name);
	const wantedWords = wordsOf(wanted);
	return wantedWords.length > 0 && wantedWords.every((word) => words.includes(word));
}

// The first name: phase6 shows the surname first, e.g. "Muster Emma"
function firstName(name) {
	return name.split(" ").slice(1).join(" ") || name;
}

// The profiles that the module shows, with their names in the module and the
// number to add to their due vocabulary, and the names in the options that
// match no profile. The profiles are those of the option profiles, in its
// order and with its names, or else the children by their first name, or
// all profiles if there are no children.
function selectProfiles(profiles, options) {
	// Also a single name, e.g. profiles: "Emma"
	const wanted = [options.profiles].flat().filter(Boolean);
	const children = profiles.filter((profile) => profile.child);
	const rows = wanted.length > 0
		? wanted.map((name) => [String(name), profiles.find((profile) => matches(profile.name, name))])
		: (children.length > 0 ? children : profiles).map((profile) => [firstName(profile.name), profile]);
	const adjustments = typeof options.dueAdjustments === "object" ? Object.entries(options.dueAdjustments ?? {}) : [];
	return {
		shown: rows.filter(([, profile]) => profile).map(([name, profile]) => ({
			name,
			profile,
			adjustment: Number(adjustments.find(([key]) => matches(profile.name, key))?.[1]) || 0
		})),
		unknown: [...rows.filter(([, profile]) => !profile).map(([name]) => name), ...adjustments.map(([key]) => key).filter((key) => !profiles.some((profile) => matches(profile.name, key)))]
	};
}

// A time in the local time of the mirror, e.g. "2026-10-22T19:55"
function localTime(time) {
	const date = new Date(time);
	const pad = (number) => String(number).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The due vocabulary of a profile in its subjects, as the web app of phase6
// sends them, and when it last learned, or null if a subject has no number
// of due vocabulary. The subjects are its vocabulary collections, each with
// the numbers of its words, e.g. PRACTICE, see DUE_COUNTS. A subject that has
// expired, e.g. after a trial, has no due vocabulary.
function countsOf(subjects, count) {
	const counts = subjects.filter((subject) => !subject.isExpired).map((subject) => subject.groupedCardCount?.cardCounts?.[count]?.cardCount);
	if (!counts.every(Number.isInteger)) {
		return null;
	}
	const times = subjects.map((subject) => Date.parse(subject.subjectMetadata?.lastPracticedDate)).filter((time) => !Number.isNaN(time));
	return {
		due: counts.reduce((sum, count) => sum + count, 0),
		lastLearned: times.length > 0 ? localTime(Math.max(...times)) : null
	};
}

// The website of phase6, the only one that gets the cookies of the session
const PHASE6 = "https://www.phase-6.de";
// The family overview, "Meine Familie › Übersicht", with the profiles of the
// parent and the children
const OVERVIEW = `${PHASE6}/classic/service/user/parent/`;
// Where phase6 sends a browser without a session, and a rejected login
const LOGIN_PAGE = "/classic/service/user/login.html";
// The web app of phase6, to which the family overview links for the reports
// of a child. It has the due vocabulary as it is, while the family overview
// may still show the numbers of an hour ago.
const WEB_APP = "https://lernen.phase-6.de/server.integration/";
// The numbers of the web app for the values of the option due: all words
// that are due, or those that phase6 asks for today, at most the daily limit
// of each vocabulary collection, as the phase6 app shows them under Heute
const DUE_COUNTS = { all: "PRACTICE", today: "SHOULD_PRACTICE_TODAY" };
// How the module introduces itself to phase6
const USER_AGENT = "MMM-phase6 (MagicMirror²)";
// How long phase6 may take to answer a request, in milliseconds
const TIMEOUT = 30 * 1000;
// The shortest time between two updates, and the time until the next try
// while phase6 is not reachable, in milliseconds
const MINUTE = 60 * 1000;
// The times until the next try after phase6 has rejected a login that
// worked before, one for each rejection in a row, in milliseconds. Then the
// module waits for a restart. So it posts a login that phase6 rejects, e.g.
// after the password has changed on phase6, at most three times in a row:
// when phase6 locks an account is unknown. A login that phase6 does not
// answer, e.g. after a timeout, counts as not reachable, as before.
const RETRIES = [30 * MINUTE, 4 * 60 * MINUTE];

// The options of the node helper and their defaults. It reads them from
// config.js only: any device that the ipWhitelist of MagicMirror² lets in can
// send socket notifications to it.
const DEFAULTS = {
	username: "",
	password: "",
	updateInterval: 10 * MINUTE,
	profiles: [],
	due: "all",
	dueAdjustments: {}
};

// What the log adds about each problem: what to do
const HINTS = {
	NO_CREDENTIALS: "Add it, then restart MagicMirror². See the README.",
	LOGIN_FAILED: "Log in at https://www.phase-6.de with the same login. If it works, phase6 had a problem; if it keeps failing, correct the username or the password. Then restart MagicMirror². Until then, the module does not try again, so that phase6 does not lock the account.",
	LOGIN_RETRY: "phase6 may also reject a correct login while it has a problem. If the password has changed on phase6, correct it, then restart MagicMirror².",
	NOT_REACHABLE: "The module tries again in a minute.",
	MODULE_ERROR_RATE_LIMITED: "The module tries again at the next update.",
	NO_FAMILY: "Use the login of the parent, which shows the children under Meine Familie on phase6. If you do, phase6 may have changed its website: update the module, or report it at https://github.com/ms-zone-41/MMM-phase6/issues.",
	UNKNOWN_PROFILE: "Correct profiles or dueAdjustments in config/config.js, then restart MagicMirror².",
	MODULE_ERROR_UNSPECIFIED: "phase6 may have changed its web app: update the module, or report it at https://github.com/ms-zone-41/MMM-phase6/issues."
};

// A problem that the module shows, by its code, with the variables of its
// message, and what the log says about it. The code is that of a message of
// the module, or of MagicMirror², e.g. MODULE_ERROR_RATE_LIMITED.
function problem(code, variables, log) {
	return Object.assign(new Error(log), { code, variables });
}

// The problem of an answer of phase6 that is not OK: phase6 is down, asks for
// fewer requests, or does not have the page
function failure(response, path) {
	const detail = `HTTP ${response.status}`;
	if (response.status >= 500) {
		return problem("NOT_REACHABLE", { detail }, `phase6 is not reachable: ${detail}`);
	}
	return problem(response.status === 429 ? "MODULE_ERROR_RATE_LIMITED" : "NO_FAMILY", {}, `phase6 answered ${path} with ${detail}`);
}

module.exports = NodeHelper.create({
	// getServerModuleConfig() came with MagicMirror² 2.38.0
	requiresVersion: "2.38.0",

	start() {
		this.config = { ...DEFAULTS, ...this.getServerModuleConfig() };
		// The cookies of the session with phase6, by name
		this.cookies = new Map();
		// The token of the web app for the session, see webAppToken(), and an
		// ID of this client, which the web app in a browser sends too
		this.token = null;
		this.clientId = crypto.randomUUID();
		// Nothing to send until the first update has finished
		this.state = null;
		this.profiles = null;
		// The times until the tries that remain after a rejected login: none
		// before a login has worked, see update()
		this.retries = [];
		// An updateInterval in seconds or in minutes would load phase6 again and
		// again
		const interval = Number(this.config.updateInterval) || DEFAULTS.updateInterval;
		this.interval = Math.min(Math.max(interval, MINUTE), 2 ** 31 - 1);
		if (this.interval !== interval) {
			Log.warn(`updateInterval is ${interval} milliseconds: the module updates every ${Math.round(this.interval / 1000)} seconds instead.`);
		}
		if (!Object.hasOwn(DUE_COUNTS, this.config.due)) {
			Log.warn(`due is ${JSON.stringify(this.config.due)}, not "all" or "today": the module shows all due words instead.`);
			this.config.due = DEFAULTS.due;
		}
		// Send the state to a browser as soon as it connects, also again after
		// it was offline, without asking phase6: socket.io keeps no
		// notification for a browser that is offline when it is sent, e.g.
		// while its Wi-Fi is gone or its device sleeps
		this.io.of(this.name).on("connection", (socket) => {
			if (this.state) {
				socket.emit("PROFILES", this.state);
			}
		});
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
			const profiles = await this.fetchProfiles();
			// phase6 has accepted the login since the start: the cookies start
			// empty, and only a login of this run gives a session. So if phase6
			// rejects it later, phase6 more likely has a problem than the
			// password has changed.
			this.retries = [...RETRIES];
			const { shown, unknown } = selectProfiles(profiles, this.config);
			const rows = [];
			for (const { name, profile, adjustment } of shown) {
				const { due, lastLearned } = await this.fetchCounts(profile, name);
				rows.push({ name, lastLearned, due: Math.max(0, due + adjustment), streak: profile.streak });
			}
			this.profiles = rows;
			if (unknown.length > 0) {
				const names = profiles.map((profile) => firstName(profile.name)).join(", ");
				error = problem("UNKNOWN_PROFILE", { name: unknown.join(", "), names }, `phase6 has no profile ${unknown.join(", ")}, only ${names}`);
			}
		} catch (thrown) {
			error = thrown;
		}
		// When MagicMirror² stops during an update, report nothing and do not
		// update again
		if (this.stopped) {
			return;
		}
		let delay = error?.code === "NOT_REACHABLE" ? MINUTE : this.interval;
		if (error?.code === "LOGIN_FAILED") {
			// phase6 may also reject a correct login while it has a problem, with
			// the same ErrorCode. So after a login that worked, try again a few
			// times, later each time. After a rejected first login, which is
			// more likely wrong in the configuration, and after the last try,
			// wait for a restart with the right password.
			delay = this.retries.shift();
			if (delay) {
				const time = Date.now() + delay;
				// In the local time of the log, e.g. 02:21
				const clock = new Date(time).toTimeString().slice(0, 5);
				error = problem("LOGIN_RETRY", { time }, `${error.message}, which worked before. The module tries again at ${clock}`);
			}
		}
		this.report(error);
		if (delay) {
			this.timer = setTimeout(() => this.update(), delay);
		}
	},

	// Send the profiles of the last update that worked to the module, with the
	// problem of this update, if any. Log a problem when it starts or changes,
	// not after every update.
	report(error) {
		// Errors of Node.js have codes too, e.g. ERR_INVALID_URL
		const hint = HINTS[error?.code];
		const reported = error && (hint ? { code: error.code, ...error.variables } : { code: "MODULE_ERROR_UNSPECIFIED" });
		if (error && JSON.stringify(reported) !== JSON.stringify(this.state?.error)) {
			if (hint) {
				Log.error(`${error.message}. ${hint}`);
			} else {
				Log.error("The update failed:", error);
			}
		} else if (!error && this.state?.error) {
			Log.info("phase6 works again");
		}
		this.state = { profiles: this.profiles, error: reported };
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
				// The next login starts without the cookies of this one, like
				// after a restart
				this.cookies.clear();
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
		// phase6 sends a rejected login back to the login page, with the
		// ErrorCode in its URL. That redirect is the answer, so do not load the
		// page, which may not come while phase6 is slow.
		return this.request(new URL(form.action || page.url, page.url), {
			method: "POST",
			body: fields,
			headers: { Origin: PHASE6, Referer: page.url.href },
			until: LOGIN_PAGE
		});
	},

	// The due vocabulary of a profile and when it last learned, from the web
	// app of phase6: like its reports, it reads the subjects of a child, or
	// those of the login itself. A token that the web app does not take, e.g.
	// after some time, is exchanged once for a new one.
	async fetchCounts(profile, name) {
		let token = await this.webAppToken();
		const path = profile.id === token.userId ? "userSubjectsData" : `userSubjectsFromGroupData/${profile.id}/true/foreign`;
		let reply;
		try {
			reply = await this.askWebApp(path, token.headers);
		} catch (error) {
			if (!error.refused) {
				throw error;
			}
			token = await this.webAppToken(true);
			reply = await this.askWebApp(path, token.headers);
		}
		// The web app leaves out the subjects of a profile that has none
		const subjects = reply.subjects ?? [];
		const counts = Array.isArray(subjects) && countsOf(subjects.map(([, subject]) => subject), DUE_COUNTS[this.config.due]);
		if (!counts) {
			throw problem("MODULE_ERROR_UNSPECIFIED", {}, `The web app of phase6 sent no due vocabulary of ${name}`);
		}
		return counts;
	},

	// The token of the web app for the session of the login, with the ID of
	// the login and the headers that the web app asks for. The web app gives
	// the token for the session cookie, like when the family overview opens
	// the reports. A new session, after a login, gets a new token, and so does
	// renew.
	async webAppToken(renew = false) {
		const session = this.cookies.get("JOSSO_SESSIONID");
		if (renew || this.token?.session !== session) {
			const reply = await this.askWebApp("jossoInfo", { "X-JAUTHTOKEN": session });
			this.token = {
				session,
				userId: String(reply.userDnsId),
				headers: { "X-JAUTHTOKEN": reply.p6pSessionToken, "X-CLIENTID": this.clientId, "X-LBTOKEN": String(reply.email ?? "").toLowerCase() }
			};
		}
		return this.token;
	},

	// The replyContent of the web app for a path. The web app answers with
	// JSON, whose httpCode is 200 if it worked. Without cookies: the web app
	// takes its token instead.
	async askWebApp(path, headers) {
		const { response, text } = await this.load(new URL(path, WEB_APP), { headers: { ...headers, "User-Agent": USER_AGENT, "Accept": "application/json" } });
		if (response.status >= 500 || response.status === 429) {
			throw failure(response, path);
		}
		let reply = null;
		try {
			reply = JSON.parse(text);
		} catch {
			// Not JSON, e.g. a page of an error
		}
		if (!response.ok || reply?.httpCode !== 200) {
			const detail = reply ? `httpCode ${reply.httpCode}` : `HTTP ${response.status}`;
			// e.g. a token that the web app does not take
			throw Object.assign(problem("MODULE_ERROR_UNSPECIFIED", {}, `The web app of phase6 answered ${path} with ${detail}`), { refused: true });
		}
		return reply.replyContent;
	},

	// Fetch a URL of phase6 and read its answer, without following redirects
	async load(url, options) {
		try {
			const response = await fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
			// The timeout or a lost connection can also end reading the answer
			return { response, text: await response.text() };
		} catch (error) {
			// fetch() fails with "fetch failed" and the reason as its cause
			const detail = error.name === "TimeoutError" ? "timeout" : error.cause?.code ?? error.cause?.message ?? error.message;
			throw problem("NOT_REACHABLE", { detail }, `phase6 is not reachable: ${detail}`);
		}
	},

	// Fetch a page of phase6 with the cookies of the session, and follow the
	// redirects: fetch() keeps no cookies, and phase6 sets those of the
	// session in redirects. A redirect to the path until ends the request,
	// without loading that page.
	async request(url, { method = "GET", body, headers, until } = {}) {
		let next = new URL(url);
		for (let redirects = 0; redirects <= 10; redirects++) {
			if (next.origin !== PHASE6) {
				throw problem("NO_FAMILY", {}, `phase6 redirected to ${next.origin}`);
			}
			const { response, text: html } = await this.load(next, {
				method,
				body,
				headers: {
					...headers,
					"User-Agent": USER_AGENT,
					"Accept-Language": "de",
					"Cookie": [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
				}
			});
			this.keepCookies(response);
			const location = response.headers.get("location");
			if (response.status >= 300 && response.status < 400 && location) {
				// Like a browser, follow the redirect with GET
				next = new URL(location, next);
				if (next.origin === PHASE6 && next.pathname === until) {
					return { url: next, html: "" };
				}
				method = "GET";
				body = undefined;
				headers = undefined;
				continue;
			}
			if (!response.ok) {
				throw failure(response, next.pathname);
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
