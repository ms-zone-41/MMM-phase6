/* MagicMirror²
 * Module: MMM-phase6
 *
 * Shows when the children last learned on phase6, how much vocabulary is
 * due, and how many days in a row they learned.
 *
 * MIT Licensed.
 */

Module.register("MMM-phase6", {

	// The module has no options for the display: the node helper reads all
	// options from config.js and sends what the module shows.
	defaults: {},

	// The node helper reads its options with getServerModuleConfig()
	requiresVersion: "2.38.0",

	start() {
		Log.info(`Starting module: ${this.name}`);
		// The profiles of the last update that worked, and the problem of the
		// last update, from the node helper
		this.profiles = null;
		this.error = null;
		this.sendSocketNotification("GET_PROFILES");
	},

	getStyles() {
		return ["font-awesome.css", "MMM-phase6.css"];
	},

	getTranslations() {
		return {
			en: "translations/en.json",
			de: "translations/de.json"
		};
	},

	// The node helper sends the profiles after each update
	socketNotificationReceived(notification, payload) {
		if (notification === "PROFILES") {
			this.profiles = payload.profiles;
			this.error = payload.error;
			this.updateDom();
		}
	},

	// The problem of the last update, if any, above the profiles
	getDom() {
		const wrapper = document.createElement("div");
		wrapper.className = "small";
		if (!this.profiles && !this.error) {
			wrapper.classList.add("dimmed");
			wrapper.textContent = this.translate("LOADING");
			return wrapper;
		}
		if (this.error) {
			const warning = document.createElement("div");
			warning.className = "p6-warning";
			const icon = document.createElement("i");
			icon.className = "fa-solid fa-triangle-exclamation";
			warning.append(icon, this.translate(this.error.code, this.error));
			wrapper.append(warning);
		}
		if (this.profiles?.length > 0) {
			wrapper.append(this.getTable());
		}
		return wrapper;
	},

	// A row for each profile, below a row with the headers of the columns. The
	// th and the td of each column have the same class, so that custom.css can
	// hide a column.
	getTable() {
		const table = document.createElement("table");
		// While the problem lasts, the profiles are those of the last update
		// that worked: dimmed, as phase6 may show other numbers by now. The
		// class p6-stale lets custom.css style them.
		const stale = Boolean(this.error);
		table.className = stale ? "p6-profiles p6-stale dimmed" : "p6-profiles";
		table.append(this.getRow("th", ["", this.translate("LAST_LEARNED"), this.translate("DUE"), this.translate("STREAK")]));
		for (const profile of this.profiles) {
			const row = this.getRow("td", [profile.name, this.formatDate(profile.lastLearned), String(profile.due), String(profile.streak)]);
			// The name and the due vocabulary bright, unless they are stale
			if (!stale) {
				row.querySelectorAll(".p6-name, .p6-due").forEach((cell) => cell.classList.add("bright"));
			}
			// Bold while vocabulary is due, also while stale
			if (profile.due > 0) {
				row.classList.add("p6-has-due");
			}
			table.append(row);
		}
		return table;
	},

	getRow(tag, texts) {
		const row = document.createElement("tr");
		["p6-name", "p6-last", "p6-due", "p6-streak"].forEach((className, index) => {
			const cell = document.createElement(tag);
			cell.className = className;
			// As text, not as HTML
			cell.textContent = texts[index];
			row.append(cell);
		});
		return row;
	},

	// When a profile last learned: today, yesterday or the date, with the year
	// only if it is not this year. The node helper sends the date of phase6,
	// e.g. "2026-10-10T15:25", or any other text of phase6, which shows as it
	// is.
	formatDate(value) {
		if (!value) {
			return "–";
		}
		const match = (/^(\d{4})-(\d\d)-(\d\d)T/).exec(value);
		if (!match) {
			return value;
		}
		const date = new Date(match[1], match[2] - 1, match[3]);
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const days = Math.round((today - date) / (24 * 60 * 60 * 1000));
		if (days === 0) {
			return this.translate("TODAY");
		}
		if (days === 1) {
			return this.translate("YESTERDAY");
		}
		return date.toLocaleDateString(config.language, {
			day: "2-digit",
			month: "2-digit",
			year: date.getFullYear() === today.getFullYear() ? undefined : "numeric"
		});
	}
});
