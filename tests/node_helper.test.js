// Tests for the node helper, which reads the profiles from phase6. Run them in
// the module directory with `npm install` and `node --run test`.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { fakePhase6 } = require("./fake-phase6.js");

// The options of the module in config.js
const CONFIG = { username: "parent@example.com", password: "secret" };

// Load the node helper with stand-ins for MagicMirror², for fetch() and for
// the timers, and start it with the given options of config.js
function createHelper({ config = CONFIG, site = fakePhase6() } = {}) {
	const timers = new Set();
	const notifications = [];
	const context = {
		require: (name) => ({
			node_helper: { create: (definition) => definition },
			logger: { debug() {}, log() {}, info() {}, warn() {}, error() {} }
		})[name] ?? createRequire(path.join(__dirname, "../node_helper.js"))(name),
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
	return { helper, site, timers, notifications };
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

// The names of the profiles that the node helper sent last
function names(notifications) {
	return notifications.at(-1).payload.data.accounts.map((account) => account.displayName);
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
	const { site } = createHelper();
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

test("reports a login that phase6 rejects", async () => {
	const { site, notifications } = createHelper({ config: { ...CONFIG, password: "wrong" } });
	await settle();
	assert.deepEqual(notifications.at(-1).payload, { ok: false, error: "phase6 rejected the username or the password" });
	assert.equal(site.requests.at(-1).path, "/classic/service/user/login.html?ErrorCode=user.login.wrong&josso_back_to=https%3A%2F%2Fwww.phase-6.de%2Fclassic%2Fservice%2Fuser%2F");
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

test("reports a problem of the connection, a timeout and an HTTP error", async () => {
	const breaking = (error) => () => new Response(new ReadableStream({
		pull(controller) {
			controller.error(error);
		}
	}));
	const problems = [
		[() => {
			throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND www.phase-6.de"), { code: "ENOTFOUND" }) });
		}, "phase6 cannot be reached: ENOTFOUND"],
		[() => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		}, "phase6 did not answer within 30 seconds"],
		[() => new Response("Wartungsarbeiten", { status: 503 }), "phase6 answered with HTTP 503"],
		// While phase6 sends a page, too
		[breaking(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "phase6 did not answer within 30 seconds"],
		[breaking(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })), "phase6 cannot be reached: UND_ERR_SOCKET"]
	];
	for (const [failure, error] of problems) {
		const site = fakePhase6();
		site.fail(failure);
		const { notifications } = createHelper({ site });
		await settle();
		assert.deepEqual(notifications.at(-1).payload, { ok: false, error });
	}
});

test("follows no redirect to another website, so cookies go only to phase6", async () => {
	const site = fakePhase6();
	site.fail((url) => (new URL(url).pathname === "/classic/service/user/" ? new Response(null, { status: 302, headers: { location: "https://example.com/wartung" } }) : null));
	const { notifications } = createHelper({ site });
	await settle();
	assert.deepEqual(notifications.at(-1).payload, { ok: false, error: "phase6 redirected to https://example.com" });
	assert.ok(site.requests.every(({ host }) => host === "www.phase-6.de"));
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
	const { timers } = createHelper();
	await settle();
	assert.deepEqual([...timers].map(({ delay }) => delay), [10 * 60 * 1000]);
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

test("reports a missing username or password", async () => {
	const { site, notifications } = createHelper({ config: { username: "parent@example.com" } });
	await settle();
	assert.deepEqual(notifications.at(-1).payload, { ok: false, error: "No credentials configured. Set username and password in config.js." });
	assert.deepEqual(site.requests, []);
});

test("uses only invented e-mail addresses in the fixtures", () => {
	for (const file of fs.readdirSync(path.join(__dirname, "fixtures"))) {
		const addresses = fs.readFileSync(path.join(__dirname, "fixtures", file), "utf8").match(/[\w.+-]+@[\w-]+\.[\w.-]+/g) ?? [];
		assert.deepEqual(addresses.filter((address) => !address.endsWith("@example.com")), [], file);
	}
});
