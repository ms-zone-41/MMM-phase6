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
		// Show the profiles again every minute, like the calendar: today and
		// yesterday change at midnight, also while no update arrives
		setInterval(() => this.updateDom(), 60 * 1000);
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

	// The node helper sends the profiles after each update, and when the
	// browser connects
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
			// The node helper sends the time of the next try, if any, in
			// milliseconds
			const variables = this.error.time ? { ...this.error, time: this.formatTime(this.error.time) } : this.error;
			warning.append(icon, this.translate(this.error.code, variables));
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
		// class p6-stale lets custom.css style them. A name in the options
		// that matches no profile comes with the profiles of this update.
		const stale = Boolean(this.error) && this.error.code !== "UNKNOWN_PROFILE";
		table.className = stale ? "p6-profiles p6-stale dimmed" : "p6-profiles";
		table.append(this.getRow("th", ["", this.translate("LAST_LEARNED"), this.translate("DUE"), this.translate("STREAK")]));
		for (const profile of this.profiles) {
			const row = this.getRow("td", [profile.name, this.formatDate(profile.lastLearned), String(profile.due), String(profile.streak)]);
			// A calendar icon after the streak, in its color, so that it reads
			// as days and not as more vocabulary. fa-xs makes it as high as the
			// digits.
			const icon = document.createElement("i");
			icon.className = "fa-regular fa-calendar-check fa-xs";
			row.querySelector(".p6-streak").append(icon);
			// The name and the due vocabulary bright while vocabulary is due,
			// unless they are stale; otherwise they have the color of the table
			if (profile.due > 0 && !stale) {
				row.querySelectorAll(".p6-name, .p6-due").forEach((cell) => cell.classList.add("bright"));
			}
			table.append(row);
		}
		return table;
	},

	// A row of the headers of the columns (th), small and dimmed, or of a
	// profile (td)
	getRow(tag, texts) {
		const row = document.createElement("tr");
		["p6-name", "p6-last", "p6-due", "p6-streak"].forEach((className, index) => {
			const cell = document.createElement(tag);
			cell.className = tag === "th" ? `${className} xsmall dimmed` : className;
			// As text, not as HTML
			cell.textContent = texts[index];
			row.append(cell);
		});
		return row;
	},

	// When a profile last learned: today, yesterday or the date, with the year
	// only if it is not this year, in the time zone of the mirror. The node
	// helper sends the time in milliseconds, or null.
	formatDate(value) {
		if (!value) {
			return "–";
		}
		const date = new Date(value);
		date.setHours(0, 0, 0, 0);
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
	},

	// A time in the language and the time format of MagicMirror², like the
	// clock, e.g. 14:05, or 2:05 PM with a timeFormat of 12
	formatTime(time) {
		const twelve = config.timeFormat === 12;
		return new Date(time).toLocaleTimeString(config.language, { hour: twelve ? "numeric" : "2-digit", minute: "2-digit", hourCycle: twelve ? "h12" : "h23" });
	}
});
