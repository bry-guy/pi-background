import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = "/Users/brain/.pi/agent/pi-projects/pi-web-ecosystem/worktrees/pi-background/agent/role-follow-up";
const agent = mkdtempSync(join(tmpdir(), "pibg-agent-"));
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_SKIP_VERSION_CHECK = "1";
const { newSessionFile } = await import(`${ROOT}/src/extension.ts`);

test("send probe", async () => {
	const api = (globalThis as any)[Symbol.for("pi-background.v1")];
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pibg-cwd-")));
	const out = join(agent, "probe.json");
	mkdirSync(join(agent, "extensions"), { recursive: true });
	writeFileSync(join(agent, "extensions", "probe.ts"), `import { writeFileSync } from "node:fs";\nexport default (pi) => pi.on("session_start", (_e, ctx) => writeFileSync(process.env.PROBE_OUT, JSON.stringify({ role: process.env.PI_ROLE, cwd: ctx.cwd, file: ctx.sessionManager.getSessionFile() })));\n`);
	const file = newSessionFile(cwd, "probe", join(agent, "sessions"));
	const t0 = Date.now();
	const { pid } = api.send({ file, msg: "hello", env: { PI_ROLE: "app/dev", PROBE_OUT: out } });
	while (!existsSync(out) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200));
	console.log("probe after", Date.now() - t0, existsSync(out) && readFileSync(out, "utf8"));
	console.log(JSON.stringify(api.runs()));
	api.stop(pid);
	for (let i = 0; i < 100 && api.runs().some((r: any) => r.pid === pid && (r.status === "running" || r.status === "waiting")); i++) await new Promise((r) => setTimeout(r, 200));
	console.log("after", Date.now() - t0, JSON.stringify(api.runs().map((r: any) => [r.status, r.error, r.file === file, r.cwd === cwd])));
	const log = api.runs()[0]?.log; if (log) console.log(readFileSync(log, "utf8").slice(0, 3000));
});
