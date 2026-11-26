import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { newSessionFile, sessionCwd } from "../src/extension.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pibg-start-"));

test("a named session file carries a session_info entry pi reads back", () => {
	const file = newSessionFile(tmpdir(), "pi-web-developer: do a thing", dir());
	const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines[0].type, "session");
	assert.equal(lines[1].type, "session_info");
	assert.equal(SessionManager.open(file).getSessionName(), "pi-web-developer: do a thing");
});

test("an unnamed session file holds only the header", () => {
	const file = newSessionFile(tmpdir(), undefined, dir());
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
	assert.equal(SessionManager.open(file).getSessionName(), undefined);
});

test("stop() is false for a pid that is not a live run", () => {
	const api = (globalThis as any)[Symbol.for("pi-background.v1")];
	assert.equal(api.stop(2 ** 30), false);
});

test("send() runs the next turn in the same session file and its folder, with the extra env", async () => {
	const api = (globalThis as any)[Symbol.for("pi-background.v1")];
	const agent = dir();
	const before = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	try {
		// The pi the runner starts loads this extension, which writes down what that pi was given.
		const seen = join(agent, "seen.json");
		mkdirSync(join(agent, "extensions"));
		writeFileSync(
			join(agent, "extensions", "seen.ts"),
			`import { writeFileSync } from "node:fs";
export default (pi) => pi.on("session_start", (_e, ctx) => writeFileSync(process.env.SEEN, JSON.stringify({ role: process.env.PI_ROLE, cwd: ctx.cwd, file: ctx.sessionManager.getSessionFile() })));
`,
		);
		const cwd = realpathSync(dir());
		const file = newSessionFile(cwd, "an earlier run", join(agent, "sessions"));
		const sent = api.send({ file, msg: "now also fix X", env: { PI_ROLE: "app/dev", SEEN: seen, PI_SKIP_VERSION_CHECK: "1" } });
		assert.equal(sent.file, file);
		const live = () => api.runs().some((r: any) => r.pid === sent.pid && (r.status === "running" || r.status === "waiting"));
		const until = async (done: () => boolean) => {
			for (let i = 0; i < 300 && !done(); i++) await new Promise((r) => setTimeout(r, 200));
		};
		await until(() => existsSync(seen));
		// With no model login the turn ends on its own; stop it in case this machine has one.
		api.stop(sent.pid);
		await until(() => !live());
		assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), { role: "app/dev", cwd, file });
		const run = api.runs().find((r: any) => r.pid === sent.pid);
		assert.deepEqual([run.file, run.msg, run.cwd], [file, "now also fix X", cwd]);
	} finally {
		if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = before;
	}
});

test("send() refuses a file that is not a session, and starts nothing", () => {
	const api = (globalThis as any)[Symbol.for("pi-background.v1")];
	const notes = join(dir(), "notes.jsonl");
	writeFileSync(notes, '{"type":"message"}\n');
	assert.throws(() => api.send({ file: notes, msg: "hi" }), /notes\.jsonl is not a pi session file/);
	assert.throws(() => api.send({ file: join(dir(), "gone.jsonl"), msg: "hi" }), /gone\.jsonl is not a pi session file/);
	assert.equal(sessionCwd(newSessionFile(tmpdir(), undefined, dir())), tmpdir());
});
