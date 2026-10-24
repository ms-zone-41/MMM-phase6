// Tests for the module, which shows the profiles on the mirror. Run them in
// the module directory with `npm install` and `node --run test`.

// A time zone other than UTC, so that the tests tell the day in the time zone
// of the mirror from that in UTC, also on GitHub
process.env.TZ = "Europe/Berlin";

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

// The clock of the browser stands still on 10 October 2026 at 18:00, unless
// a test moves it
const NOW = new Date(2026, 9, 10, 18, 0).getTime();
let now = NOW;
class FixedDate extends Date {
	constructor(...args) {
		super(...(args.length > 0 ? args : [now]));
	}

	static now() {
		return now;
	}
}

// Load the module like MagicMirror² does, with document and the config of
// MagicMirror² as globals, and a setInterval() that only collects the timers,
// which the tests run themselves
const document = new JSDOM("<!doctype html><html><body></body></html>").window.document;
const globalConfig = {};
const intervals = [];
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
	Date: FixedDate,
	setInterval: (callback, delay) => intervals.push({ callback, delay })
});

// The profiles as the node helper sends them
const EMMA = { name: "Emma", lastLearned: new Date(2026, 9, 10, 15, 25).getTime(), due: 29, streak: 28 };
const NOAH = { name: "Noah", lastLearned: new Date(2026, 9, 9, 7, 9).getTime(), due: 0, streak: 3 };

// Start the module in a mirror with the given language, locale and
// timeFormat, and with the given options of the module, with stand-ins for
// the methods of MagicMirror²
function createModule(language = "en", locale = undefined, timeFormat = 24, options = {}) {
	Object.assign(globalConfig, { language, locale, timeFormat });
	const module = Object.assign(Object.create(definition), {
		name: "MMM-phase6",
		config: { ...definition.defaults, ...options },
		socketNotifications: [],
		// Like MagicMirror², fill in variables such as {name}
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

// The texts that are bright
function bright(dom) {
	return Array.from(dom.querySelectorAll(".bright"), (element) => element.textContent);
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

test("shows the profiles without the headers of the columns if showColumnHeaders is false", () => {
	const dom = receive(createModule("de", undefined, 24, { showColumnHeaders: false }), [EMMA, NOAH]);
	assert.deepEqual(rows(dom), [
		["Emma", "Heute", "29", "28"],
		["Noah", "Gestern", "0", "3"]
	]);
	assert.equal(dom.querySelector("th"), null);
});

test("shows the date of earlier days, with the year only for another year", () => {
	const profiles = [
		{ ...EMMA, lastLearned: new Date(2026, 9, 8, 23, 59).getTime() },
		{ ...EMMA, lastLearned: new Date(2025, 11, 30, 8, 0).getTime() },
		{ ...EMMA, lastLearned: null }
	];
	assert.deepEqual(dates(profiles, "de"), ["08.10.", "30.12.2025", "–"]);
	assert.deepEqual(dates(profiles, "en"), ["10/08", "12/30/2025", "–"]);
	// In the language of the mirror, like the clock, whatever locale says
	assert.deepEqual(dates(profiles, "de", "en-US"), ["08.10.", "30.12.2025", "–"]);
	assert.deepEqual(dates(profiles, "de", "de_DE"), ["08.10.", "30.12.2025", "–"]);
});

test("takes the day in the time zone of the mirror", () => {
	// 00:30 in Germany is still the day before in UTC
	assert.deepEqual(dates([{ ...EMMA, lastLearned: Date.UTC(2026, 9, 9, 22, 30) }, { ...EMMA, lastLearned: Date.UTC(2026, 9, 9, 21, 59) }], "de"), ["Heute", "Gestern"]);
});

test("shows the profiles again every minute, so that today and yesterday change at midnight also while no update arrives", () => {
	const module = createModule("de");
	// The timer of this module, which it started last
	const { callback, delay } = intervals.at(-1);
	assert.equal(delay, 60 * 1000);
	receive(module, [EMMA, NOAH], { code: "LOGIN_FAILED" });
	now = new Date(2026, 9, 11, 0, 1).getTime();
	try {
		const updates = module.updates;
		callback();
		assert.equal(module.updates, updates + 1);
		assert.deepEqual(rows(module.getDom()).slice(1).map((row) => row[1]), ["Gestern", "09.10."]);
	} finally {
		now = NOW;
	}
});

test("shows the name and the due vocabulary bright only while vocabulary is due", () => {
	const dom = receive(createModule(), [EMMA, NOAH]);
	assert.deepEqual(bright(dom), ["Emma", "29"]);
	// Otherwise in the normal text color of the table, and the rows have no
	// class of their own, e.g. none for a bold name
	assert.equal(dom.querySelectorAll("td.normal, td.dimmed").length, 0);
	assert.deepEqual(Array.from(dom.querySelectorAll("tr"), (row) => row.className), ["", "", ""]);
});

test("gives the cells of each column the same class, also the header", () => {
	const dom = receive(createModule(), [EMMA]);
	assert.deepEqual(Array.from(dom.querySelectorAll("tr"), (row) => Array.from(row.children, (cell) => `${cell.tagName} ${cell.className}`)), [
		["TH p6-name xsmall dimmed", "TH p6-last xsmall dimmed", "TH p6-due xsmall dimmed", "TH p6-streak xsmall dimmed"],
		["TD p6-name bright", "TD p6-last", "TD p6-due bright", "TD p6-streak"]
	]);
});

test("shows a calendar icon after each streak, as high as the digits and in the color of the streak, so that it reads as days", () => {
	const dom = receive(createModule(), [EMMA, NOAH]);
	assert.deepEqual(Array.from(dom.querySelectorAll(".p6-streak"), (cell) => Array.from(cell.childNodes, (node) => (node.tagName ? `${node.tagName} ${node.className}` : node.textContent))), [
		["Streak"],
		["28", "I fa-regular fa-calendar-days fa-xs"],
		["3", "I fa-regular fa-calendar-days fa-xs"]
	]);
});

test("shows a problem without a table if no update has worked yet", () => {
	const dom = receive(createModule("de"), null, { code: "LOGIN_FAILED" });
	assert.equal(warning(dom), "phase6 hat den Login abgelehnt: Login auf phase-6.de prüfen, dann MagicMirror² neu starten");
	assert.equal(dom.querySelector("table"), null);
});

test("shows a problem above the profiles of the last update that worked, dimmed until an update works", () => {
	const module = createModule();
	const dom = receive(module, [EMMA, NOAH], { code: "DOWN", time: new Date(2026, 9, 10, 17, 16).getTime() });
	assert.equal(warning(dom), "phase6 has been down since 17:16");
	assert.deepEqual(Array.from(dom.children, (element) => element.className), ["p6-warning", "p6-profiles p6-stale dimmed"]);
	assert.equal(rows(dom).length, 3);
	// Nothing bright, also while vocabulary is due
	assert.deepEqual(bright(dom), []);
	const again = receive(module, [EMMA, NOAH]);
	assert.equal(warning(again), null);
	assert.equal(again.querySelector("table").className, "p6-profiles");
	assert.deepEqual(bright(again), ["Emma", "29"]);
});

test("shows only the problem if no profile matches", () => {
	const dom = receive(createModule(), [], { code: "UNKNOWN_PROFILE", name: "Ben", names: "Lena, Emma, Noah" });
	assert.equal(dom.textContent, "phase6 has no profile Ben. Profiles: Lena, Emma, Noah");
	assert.equal(dom.querySelector("table"), null);
});

test("does not dim the profiles below a name that matches no profile, as they are up to date", () => {
	const dom = receive(createModule(), [EMMA], { code: "UNKNOWN_PROFILE", name: "Ben", names: "Lena, Emma, Noah" });
	assert.equal(warning(dom), "phase6 has no profile Ben. Profiles: Lena, Emma, Noah");
	assert.equal(dom.querySelector("table").className, "p6-profiles");
	assert.deepEqual(bright(dom), ["Emma", "29"]);
});

test("fills in the variables of a problem", () => {
	assert.equal(warning(receive(createModule("de"), null, { code: "NO_CREDENTIALS", name: "SECRET_PHASE6_PASSWORD", file: "config/config.env" })), "SECRET_PHASE6_PASSWORD fehlt in config/config.env");
});

test("shows the time of the next try in the language and the time format of the mirror, above the dimmed profiles", () => {
	const error = { code: "LOGIN_RETRY", time: new Date(2026, 9, 11, 0, 5).getTime() };
	const dom = receive(createModule("de"), [EMMA, NOAH], error);
	assert.equal(warning(dom), "phase6 lehnt den Login gerade ab (nächster Versuch um 00:05)");
	assert.equal(dom.querySelector("table").className, "p6-profiles p6-stale dimmed");
	assert.equal(warning(receive(createModule("en"), [EMMA], error)), "phase6 is rejecting the login (next try at 00:05)");
	// Some versions of Node.js put a narrow space before AM
	assert.equal(warning(receive(createModule("en", undefined, 12), [EMMA], error)).replace(/\s/g, " "), "phase6 is rejecting the login (next try at 12:05 AM)");
});

test("says since when phase6 is down or not reachable, in the language and the time format of the mirror", () => {
	const time = new Date(2026, 9, 9, 23, 16).getTime();
	assert.equal(warning(receive(createModule("de"), [EMMA], { code: "DOWN", time })), "phase6 ist seit 23:16 gestört");
	assert.equal(warning(receive(createModule("de"), [EMMA], { code: "NOT_REACHABLE", time })), "phase6 ist seit 23:16 nicht erreichbar");
	assert.equal(warning(receive(createModule("en"), [EMMA], { code: "NOT_REACHABLE", time })), "phase6 has not been reachable since 23:16");
	// Some versions of Node.js put a narrow space before PM
	assert.equal(warning(receive(createModule("en", undefined, 12), [EMMA], { code: "DOWN", time })).replace(/\s/g, " "), "phase6 has been down since 11:16 PM");
});

test("has a message for each problem of the node helper, in each language", () => {
	for (const language of ["en", "de"]) {
		for (const code of ["NO_CREDENTIALS", "LOGIN_FAILED", "LOGIN_RETRY", "DOWN", "NOT_REACHABLE", "NO_FAMILY", "UNKNOWN_PROFILE"]) {
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
