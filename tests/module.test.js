// Tests for the module, which shows the profiles on the mirror. Run them in
// the module directory with `npm install` and `node --run test`.

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

// The texts of the module, and those of MagicMirror² that it uses
const TRANSLATIONS = {
	en: { ...require("../translations/en.json"), LOADING: "Loading …", MODULE_ERROR_RATE_LIMITED: "Too many requests. Retrying later.", MODULE_ERROR_UNSPECIFIED: "Check logs for more details." },
	de: { ...require("../translations/de.json"), LOADING: "Lade …", MODULE_ERROR_RATE_LIMITED: "Zu viele Anfragen. Erneuter Versuch später.", MODULE_ERROR_UNSPECIFIED: "Prüfe die Logdateien für weitere Details." }
};

// Load the module like MagicMirror² does, with document as a global
const document = new JSDOM("<!doctype html><html><body></body></html>").window.document;
let definition;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../MMM-phase6.js"), "utf8"), {
	Module: {
		register(name, value) {
			definition = value;
		}
	},
	Log: { info() {} },
	document
});

// The accounts as the node helper sends them
const EMMA = { name: "Muster Emma", displayName: "Emma", license: "PLUS aktiv", lastLearned: "10.10.2026 15:25", dueVocab: 29, streakDays: 28 };
const NOAH = { name: "Muster Noah", displayName: "Noah", license: "PLUS aktiv", lastLearned: "09.10.2026 07:09", dueVocab: 0, streakDays: 3 };

// Start the module in a mirror with the given language, with stand-ins for
// the methods of MagicMirror²
function createModule(options = {}, language = "en") {
	const module = Object.assign(Object.create(definition), {
		name: "MMM-phase6",
		config: { ...definition.defaults, ...options },
		socketNotifications: [],
		// Like MagicMirror², fill in variables such as {detail}
		translate(key, variables = {}) {
			return (TRANSLATIONS[language][key] ?? key).replace(/{([^{}]+)}/g, (placeholder, name) => (name in variables ? variables[name] : placeholder));
		},
		sendSocketNotification(notification, payload) {
			this.socketNotifications.push({ notification, payload });
		},
		updates: 0,
		updateDom() {
			this.updates++;
		}
	});
	module.start();
	return module;
}

// Send the accounts from the node helper to the module, as JSON like
// socket.io, and return what the module shows once it has asked for an update
function receive(module, accounts, error = null) {
	const updates = module.updates;
	module.socketNotificationReceived("PROFILES", JSON.parse(JSON.stringify({ accounts, fetchedAt: "2026-10-10T16:00:00.000Z", error })));
	assert.equal(module.updates, updates + 1);
	return module.getDom();
}

// The rows of the table, with the text of each cell
function rows(dom) {
	return Array.from(dom.querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => cell.textContent));
}

// The text of the problem above the table
function warning(dom) {
	return dom.querySelector(".mmm-phase6-warning")?.textContent ?? null;
}

test("asks the node helper for the profiles when it starts, without options", () => {
	assert.deepEqual(createModule().socketNotifications, [{ notification: "GET_PROFILES", payload: undefined }]);
});

test("shows that it loads until the node helper sends the profiles", () => {
	assert.equal(createModule({}, "de").getDom().textContent, "Lade …");
});

test("shows the profiles in a table, with a header in the language of the mirror", () => {
	assert.deepEqual(rows(receive(createModule(), [EMMA, NOAH])), [
		["", "Last learned", "Due", "Streak"],
		["Emma", "10.10. 15:25", "29", "28"],
		["Noah", "09.10. 07:09", "0", "3"]
	]);
	assert.deepEqual(rows(receive(createModule({}, "de"), [EMMA]))[0], ["", "Zuletzt", "Fällig", "Serie"]);
});

test("shows a problem without a table if no update has worked yet", () => {
	const dom = receive(createModule({}, "de"), null, { code: "LOGIN_FAILED" });
	assert.equal(warning(dom), "phase6 hat den Login abgelehnt: Benutzername und Passwort prüfen, dann MagicMirror² neu starten");
	assert.equal(dom.querySelector("table"), null);
});

test("shows a problem above the profiles of the last update that worked, dimmed", () => {
	const dom = receive(createModule(), [EMMA, NOAH], { code: "NOT_REACHABLE", detail: "HTTP 503" });
	assert.equal(warning(dom), "phase6 is not reachable (HTTP 503)");
	assert.deepEqual(Array.from(dom.children, (element) => element.className), ["mmm-phase6-warning small", "small mmm-phase6-stale"]);
	assert.equal(rows(dom).length, 3);
	assert.ok(!receive(createModule(), [EMMA, NOAH]).querySelector("table").classList.contains("mmm-phase6-stale"));
});

test("fills in the variables of a problem", () => {
	assert.equal(warning(receive(createModule({}, "de"), null, { code: "NO_CREDENTIALS", name: "SECRET_PHASE6_PASSWORD", file: "config/config.env" })), "SECRET_PHASE6_PASSWORD fehlt in config/config.env");
});

test("has a message for each problem of the node helper, in each language", () => {
	for (const language of ["en", "de"]) {
		for (const code of ["NO_CREDENTIALS", "LOGIN_FAILED", "NOT_REACHABLE", "NO_FAMILY"]) {
			assert.ok(TRANSLATIONS[language][code], `${language}: ${code}`);
		}
	}
	assert.deepEqual(Object.keys(TRANSLATIONS.de).sort(), Object.keys(TRANSLATIONS.en).sort());
});

test("says so if there are no profiles to show", () => {
	assert.equal(receive(createModule(), []).textContent, "No profiles to show");
});

test("shows names as text, not as HTML", () => {
	const dom = receive(createModule(), [{ ...EMMA, displayName: "<b>Emma</b>" }]);
	assert.equal(rows(dom)[1][0], "<b>Emma</b>");
	assert.equal(dom.querySelector("td b"), null);
});

test("names style sheets and translations that exist", () => {
	const module = createModule();
	for (const file of [...module.getStyles().filter((file) => file !== "font-awesome.css"), ...Object.values(module.getTranslations())]) {
		assert.ok(fs.existsSync(path.join(__dirname, "..", file)), file);
	}
});
