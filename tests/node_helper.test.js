// Tests for the node helper, which reads the profiles from phase6. Run them in
// the module directory with `npm install` and `node --run test`.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { fakePhase6, OVERVIEW, LOGIN_PAGE } = require("./fake-phase6.js");

// The options of the module in config.js
const CONFIG = { username: "parent@example.com", password: "secret" };

// Load the node helper with stand-ins for MagicMirror², for fetch() and for
// the timers, and start it with the given options of config.js
function createHelper({ config = CONFIG, site = fakePhase6() } = {}) {
	const timers = new Set();
	const notifications = [];
	const logs = [];
	const log = (level) => (...args) => logs.push(`${level}: ${args.join(" ")}`);
	const context = {
		require: (name) => ({
			node_helper: { create: (definition) => definition },
			logger: { debug() {}, log() {}, info: log("info"), warn: log("warn"), error: log("error") }
		})[name],
		module: {},
		// The stand-in answers instead of phase6
		fetch: (...args) => site.fetch(...args),
		URL,
		URLSearchParams,
		AbortSignal,
		setTimeout: (callback, delay) => {
			const timer = { callback, delay };
			timers.add(timer);
			return timer;
		},
		clearTimeout: (timer) => timers.delete(timer)
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../node_helper.js"), "utf8"), context);
	const helper = Object.assign(Object.create(context.module.exports), {
		name: "MMM-phase6",
		getServerModuleConfig: () => config,
		// Like socket.io, send the payload as JSON
		sendSocketNotification: (notification, payload) => notifications.push({ notification, payload: JSON.parse(JSON.stringify(payload)) })
	});
	helper.start();
	return { helper, site, timers, notifications, logs, context };
}

// Wait until the update has finished: the stand-in answers at once, so a few
// turns of the event loop are enough
async function settle() {
	for (let turn = 0; turn < 50; turn++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

// Let the timer start the next update, and wait until it has finished
async function updateAgain(timers) {
	const [timer] = timers;
	timers.delete(timer);
	timer.callback();
	await settle();
}

// What the node helper sent last
function last(notifications) {
	return notifications.at(-1).payload;
}

// The names of the profiles that the node helper sent last, from an update
// that worked
function names(notifications) {
	assert.equal(last(notifications).error, null);
	return last(notifications).profiles.map((profile) => profile.name);
}

// What the node helper sends with the given options
async function sent(config, overview = OVERVIEW) {
	const { notifications } = createHelper({ config: { ...CONFIG, ...config }, site: fakePhase6({ overview }) });
	await settle();
	return last(notifications);
}

// The profiles that the node helper reads from a family overview
function parse(overview) {
	const { context } = createHelper({ config: {} });
	return JSON.parse(JSON.stringify(context.parseProfiles(overview)));
}

// What the node helper reports when phase6 answers with failure()
async function problemOf(failure) {
	const site = fakePhase6();
	site.fail(failure);
	const { notifications } = createHelper({ site });
	await settle();
	return last(notifications).error;
}

test("logs in with the options of config.js and sends the profiles of the children", async () => {
	const { site, notifications } = createHelper();
	await settle();
	assert.deepEqual(notifications.map(({ notification }) => notification), ["PROFILES"]);
	assert.deepEqual(names(notifications), ["Emma", "Noah"]);
	const [login] = site.requests.filter(({ method }) => method === "POST");
	assert.equal(login.form.josso_username, "parent@example.com");
	assert.equal(login.form.josso_password, "secret");
});

test("asks only www.phase-6.de", async () => {
	const { site } = createHelper();
	await settle();
	assert.ok(site.requests.length > 0);
	assert.deepEqual(new Set(site.requests.map(({ host }) => host)), new Set(["www.phase-6.de"]));
});

test("logs in with the form of the login page and follows the redirects", async () => {
	const { site, logs } = createHelper();
	await settle();
	assert.deepEqual(site.requests.map(({ method, path }) => `${method} ${path}`), [
		"GET /classic/service/user/parent/",
		"GET /classic/service/user/",
		"GET /classic/service/user/login.html",
		"POST /session/login-web",
		"GET /classic/service/user/login-redirect-on-success.jsp",
		"GET /classic/service/user/",
		"GET /classic/service/user/parent/?tmp=42"
	]);
	const [login] = site.requests.filter(({ method }) => method === "POST");
	assert.deepEqual(Object.keys(login.form), ["josso_cmd", "josso_back_to", "josso_on_error", "josso_username", "josso_password"]);
	assert.equal(login.form.josso_back_to, "https://www.phase-6.de/classic/service/user/login-redirect-on-success.jsp");
	assert.ok(site.requests.every(({ redirect, signal }) => redirect === "manual" && signal));
	assert.deepEqual(logs, ["info: Logged in to phase6"]);
});

test("posts all hidden fields of the login form, also new ones", async () => {
	const site = fakePhase6({ loginPage: LOGIN_PAGE.replace("<input type=\"text\"", "<input type=\"hidden\" name=\"csrf\" value=\"a&amp;b\"><input type=\"text\"") });
	createHelper({ site });
	await settle();
	const [login] = site.requests.filter(({ method }) => method === "POST");
	assert.equal(login.form.csrf, "a&b");
	assert.equal(login.form.josso_cmd, "login");
});

test("keeps the cookies of the session across the redirects", async () => {
	const { site } = createHelper();
	await settle();
	const [login] = site.requests.filter(({ method }) => method === "POST");
	assert.deepEqual(login.cookies, { JSESSIONID: "J1", TPU: "T1" });
	assert.ok(site.requests.slice(4).every(({ cookies }) => cookies.JOSSO_SESSIONID === "S1"));
});

test("asks phase6 once per update while the session lasts", async () => {
	const { site, timers, notifications } = createHelper();
	await settle();
	const requests = site.requests.length;
	await updateAgain(timers);
	assert.deepEqual(site.requests.slice(requests).map(({ method, path }) => `${method} ${path}`), ["GET /classic/service/user/parent/"]);
	assert.deepEqual(names(notifications), ["Emma", "Noah"]);
});

test("logs in again when the session has expired", async () => {
	const { site, timers, notifications } = createHelper();
	await settle();
	site.expire();
	const requests = site.requests.length;
	await updateAgain(timers);
	assert.equal(site.requests.slice(requests).filter(({ method }) => method === "POST").length, 1);
	assert.deepEqual(names(notifications), ["Emma", "Noah"]);
});

test("loads the family overview after a login that lands on another page", async () => {
	const site = fakePhase6();
	site.fail((url) => {
		const { pathname } = new URL(url);
		if (pathname === "/classic/service/user/login-redirect-on-success.jsp") {
			return new Response(null, { status: 302, headers: { location: "/lernen/" } });
		}
		return pathname === "/lernen/" ? new Response("<html><body>Lernen</body></html>") : null;
	});
	const { notifications } = createHelper({ site });
	await settle();
	assert.deepEqual(names(notifications), ["Emma", "Noah"]);
});

test("forgets the cookies that phase6 deletes", async () => {
	const site = fakePhase6();
	const { timers } = createHelper({ site });
	await settle();
	site.fail(() => new Response("", { status: 503, headers: { "set-cookie": "JOSSO_SESSIONID=; Max-Age=0; Domain=phase-6.de; Path=/" } }));
	await updateAgain(timers);
	site.fail(null);
	const requests = site.requests.length;
	await updateAgain(timers);
	assert.equal(site.requests[requests].cookies.JOSSO_SESSIONID, undefined);
	assert.equal(site.requests.slice(requests).filter(({ method }) => method === "POST").length, 1);
});

test("takes no options from socket notifications", async () => {
	const { helper, site, notifications } = createHelper();
	helper.socketNotificationReceived("GET_PROFILES", { username: "other@example.com", password: "other", baseUrl: "https://example.com" });
	await settle();
	assert.ok(site.requests.every(({ host, form }) => host === "www.phase-6.de" && (!form || form.josso_username === "parent@example.com")));
	assert.deepEqual(names(notifications), ["Emma", "Noah"]);
});

test("sends the profiles to a module that starts after the update", async () => {
	const { helper, site, notifications } = createHelper();
	await settle();
	const requests = site.requests.length;
	notifications.length = 0;
	helper.socketNotificationReceived("GET_PROFILES");
	assert.deepEqual(names(notifications), ["Emma", "Noah"]);
	assert.equal(site.requests.length, requests);
});

test("sends nothing to a module that starts before the first update has finished", () => {
	const { helper, notifications } = createHelper();
	helper.socketNotificationReceived("GET_PROFILES");
	assert.deepEqual(notifications, []);
});

test("updates again updateInterval after an update has finished", async () => {
	const { timers, notifications } = createHelper({ config: { ...CONFIG, updateInterval: 15 * 60 * 1000 } });
	await settle();
	assert.deepEqual([...timers].map(({ delay }) => delay), [15 * 60 * 1000]);
	await updateAgain(timers);
	assert.equal(notifications.length, 2);
	assert.equal(timers.size, 1);
});

test("updates every 10 minutes by default", async () => {
	const { timers, logs } = createHelper();
	await settle();
	assert.deepEqual([...timers].map(({ delay }) => delay), [10 * 60 * 1000]);
	assert.ok(!logs.some((line) => line.startsWith("warn:")));
});

test("updates at most once a minute, e.g. for an updateInterval in seconds", async () => {
	const { timers, logs } = createHelper({ config: { ...CONFIG, updateInterval: 600 } });
	await settle();
	assert.deepEqual([...timers].map(({ delay }) => delay), [60 * 1000]);
	assert.deepEqual(logs.filter((line) => line.startsWith("warn:")), ["warn: updateInterval is 600 milliseconds: the module updates every 60 seconds instead."]);
});

test("limits updateInterval to the longest delay of setTimeout(), about 24 days", async () => {
	const { timers } = createHelper({ config: { ...CONFIG, updateInterval: 30 * 24 * 60 * 60 * 1000 } });
	await settle();
	assert.deepEqual([...timers].map(({ delay }) => delay), [2 ** 31 - 1]);
});

test("stops updating when MagicMirror² stops", async () => {
	const { helper, timers } = createHelper();
	await settle();
	helper.stop();
	assert.equal(timers.size, 0);
});

test("reports nothing and does not update again when MagicMirror² stops during an update", async () => {
	const { helper, timers, notifications } = createHelper();
	helper.stop();
	await settle();
	assert.deepEqual(notifications, []);
	assert.equal(timers.size, 0);
});

test("reports a missing username or password without asking phase6", async () => {
	for (const [config, name] of [[{ username: "parent@example.com" }, "password"], [{ password: "secret" }, "username"], [{ username: " ", password: "secret" }, "username"]]) {
		const { site, timers, notifications, logs } = createHelper({ config });
		await settle();
		assert.deepEqual(last(notifications), { profiles: null, error: { code: "NO_CREDENTIALS", name, file: "config/config.js" } });
		assert.deepEqual(site.requests, []);
		assert.equal(timers.size, 0);
		assert.deepEqual(logs, [`error: The ${name} is missing in config/config.js. Add it, then restart MagicMirror². See the README.`]);
	}
});

test("reports a variable of config/config.env that is not set", async () => {
	// MagicMirror² leaves a variable as it is when config.env does not set it
	const { site, notifications, logs } = createHelper({ config: { username: "parent@example.com", password: "${SECRET_PHASE6_PASSWORD}" } });
	await settle();
	assert.deepEqual(last(notifications).error, { code: "NO_CREDENTIALS", name: "SECRET_PHASE6_PASSWORD", file: "config/config.env" });
	assert.deepEqual(site.requests, []);
	assert.match(logs[0], /^error: config\.js uses \$\{SECRET_PHASE6_PASSWORD\} as the password, but config\/config\.env does not set SECRET_PHASE6_PASSWORD\./);
});

test("reports a login that phase6 rejects with a page of its own, and does not try again", async () => {
	const site = fakePhase6();
	site.fail((url) => (new URL(url).pathname === "/session/login-web" ? new Response("Benutzername oder Passwort falsch") : null));
	const { timers, notifications, logs } = createHelper({ site });
	await settle();
	assert.deepEqual(last(notifications).error, { code: "LOGIN_FAILED" });
	assert.equal(timers.size, 0);
	assert.ok(!logs.includes("info: Logged in to phase6"));
});

test("reports a login that phase6 rejects, and does not try again", async () => {
	const { site, timers, notifications, logs } = createHelper({ config: { ...CONFIG, password: "Hund123" } });
	await settle();
	assert.deepEqual(last(notifications), { profiles: null, error: { code: "LOGIN_FAILED" } });
	assert.equal(site.requests.filter(({ method }) => method === "POST").length, 1);
	assert.equal(timers.size, 0);
	assert.equal(logs.length, 1);
	assert.match(logs[0], /^error: phase6 rejected the login \(user\.login\.wrong\)\. Check the username and the password .* restart MagicMirror²/);
	assert.doesNotMatch(logs[0], /Hund123/);
});

test("reports that phase6 is not reachable: no connection, a timeout or an error of phase6", async () => {
	assert.deepEqual(await problemOf(() => {
		throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND www.phase-6.de"), { code: "ENOTFOUND" }) });
	}), { code: "NOT_REACHABLE", detail: "ENOTFOUND" });
	assert.deepEqual(await problemOf(() => {
		throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
	}), { code: "NOT_REACHABLE", detail: "timeout" });
	assert.deepEqual(await problemOf(() => new Response("Wartungsarbeiten", { status: 503 })), { code: "NOT_REACHABLE", detail: "HTTP 503" });
	// While phase6 sends a page, too
	const breaking = (error) => () => new Response(new ReadableStream({
		pull(controller) {
			controller.error(error);
		}
	}));
	assert.deepEqual(await problemOf(breaking(new DOMException("The operation was aborted due to timeout", "TimeoutError"))), { code: "NOT_REACHABLE", detail: "timeout" });
	assert.deepEqual(await problemOf(breaking(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }))), { code: "NOT_REACHABLE", detail: "UND_ERR_SOCKET" });
});

test("reports too many requests, and tries again at the next update", async () => {
	const site = fakePhase6();
	site.fail(() => new Response("Zu viele Anfragen", { status: 429 }));
	const { timers, notifications } = createHelper({ site });
	await settle();
	assert.deepEqual(last(notifications).error, { code: "MODULE_ERROR_RATE_LIMITED" });
	assert.deepEqual([...timers].map(({ delay }) => delay), [10 * 60 * 1000]);
});

test("keeps the profiles while phase6 is not reachable, and tries again in a minute", async () => {
	const site = fakePhase6();
	const { timers, notifications } = createHelper({ site });
	await settle();
	const { profiles } = last(notifications);
	site.fail(() => new Response("", { status: 502 }));
	await updateAgain(timers);
	assert.deepEqual(last(notifications), { profiles, error: { code: "NOT_REACHABLE", detail: "HTTP 502" } });
	assert.deepEqual([...timers].map(({ delay }) => delay), [60 * 1000]);
	site.fail(null);
	await updateAgain(timers);
	assert.equal(last(notifications).error, null);
	assert.deepEqual([...timers].map(({ delay }) => delay), [10 * 60 * 1000]);
});

test("reports when phase6 shows no family members, and tries again later", async () => {
	for (const site of [
		fakePhase6({ overview: "<html><body><p>Willkommen bei phase6</p></body></html>" }),
		fakePhase6({ loginPage: "<html><body>Wartungsarbeiten</body></html>" })
	]) {
		const { timers, notifications } = createHelper({ site });
		await settle();
		assert.deepEqual(last(notifications).error, { code: "NO_FAMILY" });
		assert.deepEqual([...timers].map(({ delay }) => delay), [10 * 60 * 1000]);
	}
	assert.deepEqual(await problemOf((url) => (new URL(url).pathname === "/classic/service/user/parent/" ? new Response("", { status: 404 }) : null)), { code: "NO_FAMILY" });
});

test("reports a page of phase6 other than the family overview", async () => {
	const site = fakePhase6();
	site.fail((url) => {
		const { pathname } = new URL(url);
		if (pathname === "/classic/service/user/") {
			return new Response(null, { status: 302, headers: { location: "/lernen/" } });
		}
		return pathname === "/lernen/" ? new Response("<html><body>Lernen</body></html>") : null;
	});
	const { notifications, logs } = createHelper({ site });
	await settle();
	assert.deepEqual(last(notifications).error, { code: "NO_FAMILY" });
	assert.match(logs[0], /^error: phase6 shows \/lernen\/ instead of the family overview\./);
});

test("follows no redirect to another website or to http, so cookies go only to phase6", async () => {
	for (const location of ["https://example.com/wartung", "http://www.phase-6.de/classic/service/user/login.html"]) {
		const site = fakePhase6();
		site.fail((url) => (new URL(url).pathname === "/classic/service/user/" ? new Response(null, { status: 302, headers: { location } }) : null));
		const { notifications, logs } = createHelper({ site });
		await settle();
		assert.deepEqual(last(notifications).error, { code: "NO_FAMILY" });
		assert.ok(logs[0].startsWith(`error: phase6 redirected to ${new URL(location).origin}. Use the login of the parent`), logs[0]);
		assert.ok(site.requests.every(({ host }) => host === "www.phase-6.de"));
	}
});

test("gives up after 10 redirects", async () => {
	const site = fakePhase6();
	site.fail((url) => (new URL(url).pathname === "/classic/service/user/" ? new Response(null, { status: 302, headers: { location: "/classic/service/user/" } }) : null));
	const { notifications, logs } = createHelper({ site });
	await settle();
	assert.deepEqual(last(notifications).error, { code: "NO_FAMILY" });
	assert.match(logs[0], /^error: phase6 redirected too often\./);
	assert.equal(site.requests.length, 11);
});

test("reports an error of the module itself, with the error in the log", async () => {
	// An answer without the headers of a response breaks the node helper
	const site = fakePhase6();
	site.fail(() => ({ status: 200, headers: {}, text: async () => "" }));
	const { timers, notifications, logs } = createHelper({ site });
	await settle();
	assert.deepEqual(last(notifications).error, { code: "MODULE_ERROR_UNSPECIFIED" });
	assert.match(logs[0], /^error: The update failed: TypeError: /);
	assert.equal(timers.size, 1);
	// Errors of Node.js with a code of their own, too
	assert.deepEqual(await problemOf((url) => (new URL(url).pathname === "/classic/service/user/" ? new Response(null, { status: 302, headers: { location: "https://[" } }) : null)), { code: "MODULE_ERROR_UNSPECIFIED" });
});

test("logs a problem once, and again when it changes, and when phase6 works again", async () => {
	const site = fakePhase6();
	const { timers, logs } = createHelper({ site });
	await settle();
	site.fail(() => new Response("", { status: 503 }));
	await updateAgain(timers);
	await updateAgain(timers);
	site.fail(() => new Response("", { status: 502 }));
	await updateAgain(timers);
	site.fail(null);
	await updateAgain(timers);
	assert.deepEqual(logs, [
		"info: Logged in to phase6",
		"error: phase6 is not reachable: HTTP 503. The module tries again in a minute.",
		"error: phase6 is not reachable: HTTP 502. The module tries again in a minute.",
		"info: phase6 works again"
	]);
});

test("shows the children by their first name", async () => {
	assert.deepEqual((await sent({})).profiles, [
		{ name: "Emma", lastLearned: "2026-10-10T15:25", due: 29, streak: 28 },
		{ name: "Noah", lastLearned: "2026-10-09T07:09", due: 50, streak: 0 }
	]);
	assert.deepEqual((await sent({}, OVERVIEW.replace("Muster Emma", "Muster Anna Lena").replace("Muster Noah", "Noah"))).profiles.map(({ name }) => name), ["Anna Lena", "Noah"]);
});

test("shows all profiles if there are no children", async () => {
	assert.deepEqual((await sent({}, OVERVIEW.replaceAll(" child ", " "))).profiles.map(({ name }) => name), ["Lena", "Emma", "Noah"]);
});

test("shows the profiles of the option profiles, in its order and with its names", async () => {
	assert.deepEqual((await sent({ profiles: ["noah", "Muster Emma", "Lena"] })).profiles.map(({ name, due }) => [name, due]), [["noah", 50], ["Muster Emma", 29], ["Lena", 0]]);
	assert.deepEqual((await sent({ profiles: "Emma" })).profiles.map(({ name, due }) => [name, due]), [["Emma", 29]]);
});

test("reports the names in profiles and dueAdjustments that match no profile", async () => {
	const { notifications, logs } = createHelper({ config: { ...CONFIG, profiles: ["Emma", "Ben"], dueAdjustments: { Mia: -1 } } });
	await settle();
	const { profiles, error } = last(notifications);
	assert.deepEqual(profiles.map(({ name }) => name), ["Emma"]);
	assert.deepEqual(error, { code: "UNKNOWN_PROFILE", name: "Ben, Mia", names: "Lena, Emma, Noah" });
	assert.equal(logs.at(-1), "error: phase6 has no profile Ben, Mia, only Lena, Emma, Noah. Correct profiles or dueAdjustments in config/config.js, then restart MagicMirror².");
});

test("adds dueAdjustments to the due vocabulary, but not below zero", async () => {
	assert.deepEqual((await sent({ dueAdjustments: { emma: -1, Noah: "-60" } })).profiles.map(({ due }) => due), [28, 0]);
});

test("sends only what the module shows, without surnames", async () => {
	const { notifications } = createHelper();
	await settle();
	assert.doesNotMatch(JSON.stringify(notifications), /Muster|Lena|@/);
});

test("reads the profiles of the family overview", () => {
	assert.deepEqual(parse(OVERVIEW), [
		{ name: "Muster Lena", child: false, lastLearned: null, due: 0, streak: 0 },
		{ name: "Muster Emma", child: true, lastLearned: "2026-10-10T15:25", due: 29, streak: 28 },
		{ name: "Muster Noah", child: true, lastLearned: "2026-10-09T07:09", due: 50, streak: 0 }
	]);
});

test("reads a date without a time, and passes another text on as it is", () => {
	assert.equal(parse(OVERVIEW.replace("10.10.2026 15:25", "10.10.2026"))[1].lastLearned, "2026-10-10T00:00");
	assert.equal(parse(OVERVIEW.replace("10.10.2026 15:25", "Heute, 15:25"))[1].lastLearned, "Heute, 15:25");
});

test("reads names with entities", () => {
	assert.equal(parse(OVERVIEW.replace("Muster Emma", "M&uuml;ller J&#252;rgen &amp; L&#xe4;ra"))[1].name, "Müller Jürgen & Lära");
});

test("reads numbers with dots between thousands", () => {
	assert.equal(parse(OVERVIEW.replace("<span>29</span>", "<span>1.234</span>"))[1].due, 1234);
});

test("skips panels without a profile", () => {
	const offer = "<div class=\"button row panel offer\"><b>PLUS für die ganze Familie</b><small>Jetzt testen</small></div>";
	assert.deepEqual(parse(OVERVIEW.replace("<footer>", `${offer}<footer>`)).map(({ name }) => name), ["Muster Lena", "Muster Emma", "Muster Noah"]);
});

test("uses only invented e-mail addresses in the fixtures", () => {
	for (const file of fs.readdirSync(path.join(__dirname, "fixtures"))) {
		const addresses = fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8").match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
		assert.deepEqual(addresses.filter((address) => !address.endsWith("@example.com")), [], file);
	}
});
