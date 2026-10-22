# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- `due: "today"` shows the words that phase6 asks for today, at most the daily limit of each vocabulary collection, as the phase6 app shows them under Heute. The default, `"all"`, shows all words that are due

### Changed

- While phase6 does not answer, the message says since when, so that you know how old the dimmed profiles are, and whether phase6 is down ("phase6 has been down since 23:16"), e.g. when it refuses the connection, or the mirror cannot reach it, e.g. without internet ("phase6 has not been reachable since 23:16"). The reason, e.g. ECONNREFUSED, is now in the log only

### Fixed

- The due words could be an hour old: the page Meine Familie › Übersicht shows them late, e.g. still 31 words due 50 minutes after a child had learned them. The module now reads the due words and the day a profile last learned from the phase6 web app, where you see the reports of your children, which has them up to date. The streak still comes from the page

## 2.0.3 - 2026-10-20

### Fixed

- While phase6 had a problem, it also rejected a correct login, and the module showed the old profiles until MagicMirror² restarted. If the login has worked since MagicMirror² started, the module now tries again after 30 minutes, then after 4 more hours, and shows the time of the next try. Then it waits for a restart, so that phase6 does not lock the account
- After a rejected login, the message asked to check the username and the password, although phase6 may also reject a correct login while it has a problem. It now asks to check the login at phase-6.de
- Today and yesterday did not change at midnight until the next update arrived, so after a rejected login, an open mirror still showed yesterday a day later. The module now shows the profiles again every minute, like the calendar
- A mirror that was offline when the module sent an update, e.g. while its Wi-Fi was gone, showed the profiles it had as if they were up to date, without the message: until the next update, and after a rejected login until a browser loaded the page or MagicMirror² restarted. The module now sends the profiles to a mirror as soon as it is connected again, without asking phase6

## 2.0.2 - 2026-10-12

### Fixed

- Every name and its due words were bright, also with no words due, and a name was bold while words were due. A name and its due words are now bright only while words are due, the other rows have the normal text color, and nothing is bold

## 2.0.1 - 2026-10-12

### Fixed

- While a message showed, the profiles of the last update that worked faded to half their brightness, so the dates and the column headers were hard to read. They are now dimmed
- A name in `profiles` or `dueAdjustments` that matches no profile faded the profiles below its message too, although they were up to date
- A long message widened its region, e.g. the left column into the center one, and stretched the other modules in it. It now wraps at the width of the region
- The rows were further apart than those of the calendar and of other modules

## 2.0.0 - 2026-10-11

A rewrite, which changes the configuration. To upgrade, update MagicMirror² to 2.38.0 or newer, run `git pull` in the module directory, change the configuration as below, and restart MagicMirror². The module no longer needs its `node_modules` directory, so you can delete it.

### Changed

- phase6 is read once for all browsers that show the mirror
- No header by default: add `header: "phase6"` next to `position`, as in the README, to keep it. It replaces `title` and `showHeader`
- `profiles` chooses the profiles to show and their names, e.g. `["Emma", "Noah"]`, and replaces `onlyChildren`, `showAccounts`, `excludeAccounts`, `hideSurname` and `surnameToHide`. By default, the module shows the children by their first name
- The day a profile last learned shows as today, yesterday or the date, without the time, in the language of MagicMirror². This replaces `lastLearnedShowYear` and `locale`
- The column headers are in the language of MagicMirror², e.g. Zuletzt, Fällig and Serie
- `updateInterval` is at least one minute
- The classes of the table have new names, e.g. `p6-streak`, for rules in `config/custom.css`

### Added

- Messages in the module, in English and German, when the login is missing or rejected, phase6 is not reachable, the page shows no family members, or a name in the options matches no profile. The log says what to do

### Removed

- `baseUrl`, `loginPath`, `overviewPath`, `requestTimeoutMs` and `sessionCookies`
- The environment variables `PHASE6_USER` and `PHASE6_PASS`: put the login into `config/config.env` as `SECRET_PHASE6_USERNAME` and `SECRET_PHASE6_PASSWORD` instead, see the README
- `showLicense` and `showFetchedAt`
- `showLastLearned`, `showDueVocab` and `showStreak`, which left their column in place: hide a column with `config/custom.css` instead, see the README

### Fixed

- After a restart of MagicMirror², the node helper did not read phase6 again until a browser reloaded the mirror
- A failed update replaced the profiles with an English error, e.g. "fetch failed"
- A rejected login was tried again at every update, which could get the account locked
- When the page was not as expected, the module showed the parent, surnames and the same child more than once
- A number in quotes in `dueAdjustments` showed `NaN`

### Security

- Any device that MagicMirror² lets in could send the node helper a configuration with another `baseUrl`, and the node helper posted the phase6 login there, also from `PHASE6_USER` and `PHASE6_PASS`. If your login is in `config.js`, move it to `config/config.env`, see the README: MagicMirror² sends `config.js` to every browser that shows the mirror

## 1.0.0 - 2026-04-25

Initial release
