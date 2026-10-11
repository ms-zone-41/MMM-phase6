# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

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
