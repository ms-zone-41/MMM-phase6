/**
 * MagicMirror² Module: MMM-phase6
 * Shows key learning stats from phase6 "Kundenservice" account overview.
 *
 * NOTE: This is an unofficial community module. It logs in to your phase6 account
 * from your MagicMirror device and scrapes the overview page.
 *
 * @license MIT
 * @see https://github.com/ms-zone-41/MMM-phase6
 */
Module.register("MMM-phase6", {
	// The options of the display. The node helper reads username, password,
	// updateInterval, profiles and dueAdjustments from config.js.
	defaults: {
		title: "phase6",
		showHeader: true,

		// License label (e.g. "PLUS aktiv")
		// The data is still scraped, but hidden in the UI by default.
		showLicense: false,
		showLastLearned: true,
		// If false, the year is removed from the "Zuletzt" date to keep the table compact.
		// Example: "26.01.2026 15:19" -> "26.01. 15:19"
		lastLearnedShowYear: false,
		showDueVocab: true,
		showStreak: true,
		// Show a "Stand: ..." line below the table (fetch timestamp).
		// Default is false to avoid extra noise.
		showFetchedAt: false,
		locale: "de-DE"
	},

	// The node helper reads its options with getServerModuleConfig()
	requiresVersion: "2.38.0",

	getHeader: function () {
		// Use MagicMirror's native header rendering (with the standard underline).
		// Respect a user-provided module header (configured via the MagicMirror "header" field)
		// and fall back to this module's `config.title`.
		if (this.config.showHeader === false) return null;

		const userHeader = (this.data && typeof this.data.header === "string") ? this.data.header.trim() : "";
		if (userHeader) return userHeader;

		return this.config.title || "phase6";
	},

	start: function () {
		// The profiles of the last update that worked and the problem of the
		// last update, from the node helper
		this.profiles = null;
		this.fetchedAt = null;
		this.error = null;
		this.loaded = false;

		this.sendSocketNotification("GET_PROFILES");
	},

	getStyles: function () {
		return ["font-awesome.css", "phase6.css"];
	},

	getTranslations: function () {
		return {
			en: "translations/en.json",
			de: "translations/de.json"
		};
	},

	getDom: function () {
		const wrapper = document.createElement("div");
		wrapper.className = "mmm-phase6";

		if (!this.loaded) {
			const loading = document.createElement("span");
			loading.className = "dimmed light small";
			loading.textContent = this.translate("LOADING");
			wrapper.appendChild(loading);
			return wrapper;
		}

		// The problem of the last update, with the profiles of the last update
		// that worked below it, if any
		if (this.error) {
			const warning = document.createElement("div");
			warning.className = "mmm-phase6-warning small";
			const icon = document.createElement("i");
			icon.className = "fa-solid fa-triangle-exclamation";
			warning.append(icon, this.translate(this.error.code, this.error));
			wrapper.appendChild(warning);
		}

		// No profiles to show come with a problem
		if (!this.profiles?.length) {
			return wrapper;
		}

		const table = document.createElement("table");
		table.className = this.error ? "small mmm-phase6-stale" : "small";

		const thead = document.createElement("thead");
		const hr = document.createElement("tr");
		const headers = [
			{ label: "", className: "mmm-phase6-col-name" },
			{ label: this.translate("LAST_LEARNED"), className: "mmm-phase6-col-last" },
			{ label: this.translate("DUE"), className: "mmm-phase6-col-due" },
			{ label: this.translate("STREAK"), className: "mmm-phase6-col-streak" }
		];
		headers.forEach((h) => {
			const th = document.createElement("th");
			th.textContent = h.label;
			th.className = h.className;
			hr.appendChild(th);
		});
		thead.appendChild(hr);
		table.appendChild(thead);

		const tbody = document.createElement("tbody");
		this.profiles.forEach((profile) => {
			const tr = document.createElement("tr");

			// Bold while vocabulary is due
			const tdName = document.createElement("td");
			tdName.className = profile.due > 0 ? "mmm-phase6-name mmm-phase6-name-bold" : "mmm-phase6-name";

			const nameDiv = document.createElement("div");
			nameDiv.className = "mmm-phase6-name-main";
			nameDiv.textContent = profile.name;
			tdName.appendChild(nameDiv);

			if (this.config.showLicense && profile.license) {
				const lic = document.createElement("div");
				lic.className = "mmm-phase6-license dimmed light xsmall";
				lic.textContent = profile.license;
				tdName.appendChild(lic);
			}

			tr.appendChild(tdName);

			const tdLast = document.createElement("td");
			tdLast.className = "mmm-phase6-last";
			tdLast.textContent = this.config.showLastLearned ? this.formatLastLearned(profile.lastLearned) : "—";
			tr.appendChild(tdLast);

			const tdDue = document.createElement("td");
			tdDue.className = "mmm-phase6-due";
			tdDue.textContent = this.config.showDueVocab ? String(profile.due) : "—";
			tr.appendChild(tdDue);

			const tdStreak = document.createElement("td");
			tdStreak.className = "mmm-phase6-streak";
			tdStreak.textContent = this.config.showStreak ? String(profile.streak) : "—";
			tr.appendChild(tdStreak);

			tbody.appendChild(tr);
		});

		table.appendChild(tbody);
		wrapper.appendChild(table);

		if (this.config.showFetchedAt && this.fetchedAt) {
			const ft = document.createElement("div");
			ft.className = "mmm-phase6-fetched dimmed light xsmall";
			ft.textContent = this.translate("UPDATED", { time: new Date(this.fetchedAt).toLocaleString(this.config.locale || "de-DE") });
			wrapper.appendChild(ft);
		}

		return wrapper;
	},

	formatLastLearned: function (value) {
		if (!value) return "—";

		const s = String(value).trim();
		if (!s) return "—";

		// If the user wants the raw value (including year), just return it.
		if (this.config.lastLearnedShowYear === true) return s;

		// Common phase6 format: "DD.MM.YYYY HH:MM" (or without time)
		const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+(\d{1,2}:\d{2}))?\s*$/);
		if (m) {
			const dd = String(m[1]).padStart(2, "0");
			const mm = String(m[2]).padStart(2, "0");
			const time = m[4] ? String(m[4]).trim() : "";
			return time ? `${dd}.${mm}. ${time}` : `${dd}.${mm}.`;
		}

		// Fallback: try to interpret as date-like string and format without year.
		// (This is best-effort; if parsing fails, we keep the original string.)
		const d = new Date(s);
		if (!Number.isNaN(d.getTime())) {
			try {
				const formatted = d.toLocaleString(this.config.locale || "de-DE", {
					day: "2-digit",
					month: "2-digit",
					hour: "2-digit",
					minute: "2-digit"
				});
				// Some locales insert a comma between date and time.
				return formatted.replace(",", "");
			} catch {
				// ignore and fall through
			}
		}

		// Last resort: remove a ".YYYY" segment if present anywhere in the string.
		return s.replace(/(\d{1,2}\.\d{1,2})\.\d{2,4}/, "$1.");
	},

	socketNotificationReceived: function (notification, payload) {
		if (notification === "PROFILES") {
			this.loaded = true;
			this.profiles = payload.profiles;
			this.fetchedAt = payload.fetchedAt;
			this.error = payload.error;
			this.updateDom();
		}
	}
});
