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
	en: { ...require("../translations/en.json"), LOADING: "Loading …", TODAY: "Today", YESTERDAY: "Yesterday", MODULE_ERROR_RATE_LIMITED: "Too many requests. Retrying later.", MODULE_ERROR_UNSPECIFIED: "Check logs for more details." },
	de: { ...require("../translations/de.json"), LOADING: "Lade …", TODAY: "Heute", YESTERDAY: "Gestern", MODULE_ERROR_RATE_LIMITED: "Zu viele Anfragen. Erneuter Versuch später.", MODULE_ERROR_UNSPECIFIED: "Prüfe die Logdateien für weitere Details." }
};

// The clock of the browser stands still on 10 October 2026 at 18:00
const NOW = new Date(2026, 9, 10, 18, 0).getTime();
class FixedDate extends Date {
	constructor(...args) {
		super(...(args.length > 0 ? args : [NOW]));
	}

	static now() {
		return NOW;
	}
}

// Load the module like MagicMirror² does, with document and the config of
// MagicMirror² as globals
const document = new JSDOM("<!doctype html><html><body></body></html>").window.document;
const globalConfig = {};
let definition;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../MMM-phase6.js"), "utf8"), {
	Module: {
		register(name, value) {
			definition = value;
		}
	},
	Log: { info() {} },
	document,
	config: globalConfig,
	Date: FixedDate
});

// The profiles as the node helper sends them
const EMMA = { name: "Emma", lastLearned: "2026-10-10T15:25", due: 29, streak: 28 };
const NOAH = { name: "Noah", lastLearned: "2026-10-09T07:09", due: 0, streak: 3 };

// Start the module in a mirror with the given language and locale, with
// stand-ins for the methods of MagicMirror²
function createModule(language = "en", locale = undefined) {
	Object.assign(globalConfig, { language, locale });
	const module = Object.assign(Object.create(definition), {
		name: "MMM-phase6",
		config: { ...definition.defaults },
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

// Send the profiles from the node helper to the module, as JSON like
// socket.io, and return what the module shows once it has asked for an update
function receive(module, profiles, error = null) {
	const updates = module.updates;
	module.socketNotificationReceived("PROFILES", JSON.parse(JSON.stringify({ profiles, error })));
	assert.equal(module.updates, updates + 1);
	return module.getDom();
}

// The rows of the table, with the text of each cell
function rows(dom) {
	return Array.from(dom.querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => cell.textContent));
}

// When each profile last learned
function dates(profiles, language, locale) {
	return rows(receive(createModule(language, locale), profiles)).slice(1).map((row) => row[1]);
}

// The text of the problem above the table
function warning(dom) {
	return dom.querySelector(".p6-warning")?.textContent ?? null;
}

test("asks the node helper for the profiles when it starts, without options", () => {
	assert.deepEqual(createModule().socketNotifications, [{ notification: "GET_PROFILES", payload: undefined }]);
});

test("shows that it loads until the node helper sends the profiles", () => {
	const dom = createModule("de").getDom();
	assert.equal(dom.textContent, "Lade …");
	assert.ok(dom.classList.contains("dimmed"));
});

test("shows the profiles in a table, in the language of the mirror", () => {
	assert.deepEqual(rows(receive(createModule(), [EMMA, NOAH])), [
		["", "Last learned", "Due", "Streak"],
		["Emma", "Today", "29", "28"],
		["Noah", "Yesterday", "0", "3"]
	]);
	assert.deepEqual(rows(receive(createModule("de"), [EMMA, NOAH])), [
		["", "Zuletzt", "Fällig", "Serie"],
		["Emma", "Heute", "29", "28"],
		["Noah", "Gestern", "0", "3"]
	]);
});

test("shows the date of earlier days, with the year only for another year", () => {
	const profiles = [
		{ ...EMMA, lastLearned: "2026-10-08T23:59" },
		{ ...EMMA, lastLearned: "2025-12-30T08:00" },
		{ ...EMMA, lastLearned: null }
	];
	assert.deepEqual(dates(profiles, "de"), ["08.10.", "30.12.2025", "–"]);
	assert.deepEqual(dates(profiles, "en"), ["10/08", "12/30/2025", "–"]);
	// In the language of the mirror, like the clock, whatever locale says
	assert.deepEqual(dates(profiles, "de", "en-US"), ["08.10.", "30.12.2025", "–"]);
	assert.deepEqual(dates(profiles, "de", "de_DE"), ["08.10.", "30.12.2025", "–"]);
});

test("shows another text of phase6 as it is", () => {
	assert.deepEqual(dates([{ ...EMMA, lastLearned: "Heute, 15:25" }], "de"), ["Heute, 15:25"]);
});

test("makes the names of the profiles with due vocabulary bold", () => {
	const dom = receive(createModule(), [EMMA, NOAH]);
	assert.deepEqual(Array.from(dom.querySelectorAll("tr"), (row) => row.classList.contains("p6-has-due")), [false, true, false]);
});

test("gives the cells of each column the same class, also the header", () => {
	const dom = receive(createModule(), [EMMA]);
	assert.deepEqual(Array.from(dom.querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => `${cell.tagName} ${cell.className}`)), [
		["TH p6-name", "TH p6-last", "TH p6-due", "TH p6-streak"],
		["TD p6-name", "TD p6-last", "TD p6-due", "TD p6-streak"]
	]);
});

test("shows a problem without a table if no update has worked yet", () => {
	const dom = receive(createModule("de"), null, { code: "LOGIN_FAILED" });
	assert.equal(warning(dom), "phase6 hat den Login abgelehnt: Benutzername und Passwort prüfen, dann MagicMirror² neu starten");
	assert.equal(dom.querySelector("table"), null);
});

test("shows a problem above the profiles of the last update that worked, dimmed", () => {
	const dom = receive(createModule(), [EMMA, NOAH], { code: "NOT_REACHABLE", detail: "HTTP 503" });
	assert.equal(warning(dom), "phase6 is not reachable (HTTP 503)");
	assert.deepEqual(Array.from(dom.children, (element) => element.className), ["p6-warning", "p6-profiles p6-stale"]);
	assert.equal(rows(dom).length, 3);
	assert.ok(!receive(createModule(), [EMMA, NOAH]).querySelector("table").classList.contains("p6-stale"));
});

test("shows only the problem if no profile matches", () => {
	const dom = receive(createModule(), [], { code: "UNKNOWN_PROFILE", name: "Ben", names: "Lena, Emma, Noah" });
	assert.equal(dom.textContent, "phase6 has no profile Ben. Profiles: Lena, Emma, Noah");
	assert.equal(dom.querySelector("table"), null);
});

test("fills in the variables of a problem", () => {
	assert.equal(warning(receive(createModule("de"), null, { code: "NO_CREDENTIALS", name: "SECRET_PHASE6_PASSWORD", file: "config/config.env" })), "SECRET_PHASE6_PASSWORD fehlt in config/config.env");
});

test("has a message for each problem of the node helper, in each language", () => {
	for (const language of ["en", "de"]) {
		for (const code of ["NO_CREDENTIALS", "LOGIN_FAILED", "NOT_REACHABLE", "NO_FAMILY", "UNKNOWN_PROFILE"]) {
			assert.ok(TRANSLATIONS[language][code], `${language}: ${code}`);
		}
	}
	assert.deepEqual(Object.keys(TRANSLATIONS.de).sort(), Object.keys(TRANSLATIONS.en).sort());
});

test("shows names as text, not as HTML", () => {
	const dom = receive(createModule(), [{ ...EMMA, name: "<b>Emma</b>" }]);
	assert.equal(rows(dom)[1][0], "<b>Emma</b>");
	assert.equal(dom.querySelector("td b"), null);
});

test("names style sheets and translations that exist", () => {
	const module = createModule();
	for (const file of [...module.getStyles().filter((file) => file !== "font-awesome.css"), ...Object.values(module.getTranslations())]) {
		assert.ok(fs.existsSync(path.join(__dirname, "..", file)), file);
	}
});
