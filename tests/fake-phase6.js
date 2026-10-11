// A stand-in for www.phase-6.de for the tests of the node helper. It answers
// fetch() like the website: without a session, the family overview redirects
// to the login page, and the login redirects to the family overview, or back
// to the login page with an ErrorCode. The cookie JOSSO_SESSIONID holds the
// session.

const fs = require("node:fs");
const path = require("node:path");

// The family overview of Lena Muster and her children Emma and Noah, with
// invented names and e-mail addresses
const OVERVIEW = fs.readFileSync(path.join(__dirname, "fixtures/parent.html"), "utf8");

// The form of the login page, as on www.phase-6.de
const LOGIN_PAGE = `<html><body>
<form class="email-login" method="post" action="/session/login-web" name="login" id="login" onclick="mainLoginSbm()">
	<input type="hidden" name="josso_cmd" value="login">
	<input type="hidden" name="josso_back_to" value="https://www.phase-6.de/classic/service/user/login-redirect-on-success.jsp">
	<input type="hidden" name="josso_on_error" value="https://www.phase-6.de/classic/service/user/login.html?ErrorCode=user.login.wrong&josso_back_to=https%3A%2F%2Fwww.phase-6.de%2Fclassic%2Fservice%2Fuser%2F">
	<input type="text" name="josso_username" id="Email" class="form-control" placeholder="E-Mail" value="" required="required"/>
	<input type="password" class="form-control" name="josso_password" id="Password" placeholder="Passwort" required="required"/>
	<button class="btn btn-primary" type="submit" style="width: 100%">Anmelden</button>
</form>
</body></html>`;

function answer(status, { body = null, location, cookies = [] } = {}) {
	const headers = new Headers();
	if (location) {
		headers.set("location", location);
	}
	for (const cookie of cookies) {
		headers.append("set-cookie", cookie);
	}
	return new Response(body, { status, headers });
}

// The stand-in, with the account parent@example.com, the password secret and
// the given family overview. requests lists each request, with its cookies
// and the fields of its form. expire() ends the sessions, and fail(handler)
// lets handler(url) answer instead, e.g. with an error, while it returns
// something.
function fakePhase6({ overview = OVERVIEW, loginPage = LOGIN_PAGE } = {}) {
	const requests = [];
	const sessions = new Set();
	let logins = 0;
	let failure = null;

	async function fetch(url, options = {}) {
		const { host, pathname, search } = new URL(url);
		const method = options.method ?? "GET";
		const headers = new Headers(options.headers);
		const cookies = Object.fromEntries((headers.get("cookie") ?? "").split(/;\s*/).filter(Boolean).map((pair) => pair.split("=")));
		const form = options.body ? Object.fromEntries(new URLSearchParams(String(options.body))) : null;
		requests.push({ method, host, path: pathname + search, cookies, form, redirect: options.redirect, signal: options.signal });
		const response = (failure && await failure(url)) || route(method, pathname, cookies, form);
		// Like fetch(), with the URL of the request
		return Object.defineProperty(response, "url", { value: String(url) });
	}

	function route(method, pathname, cookies, form) {
		const loggedIn = sessions.has(cookies.JOSSO_SESSIONID);
		switch (`${method} ${pathname}`) {
			case "GET /classic/service/user/parent/":
				return loggedIn ? answer(200, { body: overview, cookies: ["TPU=T2; Max-Age=604800; Path=/; Secure"] }) : answer(302, { location: "/classic/service/user/" });
			case "GET /classic/service/user/":
				return loggedIn ? answer(302, { location: "parent/?tmp=42" }) : answer(302, { location: "https://www.phase-6.de/classic/service/user/login.html" });
			case "GET /classic/service/user/login.html":
				return answer(200, { body: loginPage, cookies: ["JSESSIONID=J1; Path=/; Secure; HttpOnly", "TPU=T1; Max-Age=604800; Path=/; Secure"] });
			case "POST /session/login-web":
				if (form.josso_username === "parent@example.com" && form.josso_password === "secret") {
					const session = `S${++logins}`;
					sessions.add(session);
					return answer(302, { location: form.josso_back_to, cookies: [`JOSSO_SESSIONID=${session}; Domain=phase-6.de; Path=/; Secure; HttpOnly`] });
				}
				return answer(302, { location: form.josso_on_error, cookies: ["JOSSO_SESSIONID=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:10 GMT; Domain=phase-6.de; Path=/; Secure"] });
			case "GET /classic/service/user/login-redirect-on-success.jsp":
				return answer(302, { location: "https://www.phase-6.de/classic/service/user/" });
			default:
				return answer(404, { body: "Seite nicht gefunden" });
		}
	}

	return {
		fetch,
		requests,
		expire: () => sessions.clear(),
		fail: (handler) => {
			failure = handler;
		}
	};
}

module.exports = { fakePhase6, OVERVIEW, LOGIN_PAGE };
