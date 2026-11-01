// Detached background runner: runs one turn of an existing pi session, then exits.
// Usage: node runner.ts <pi-package-dir> <session-file> <message> <log-file>
// pi runs as `pi --mode rpc --session <file>` under it, so the session loads exactly what the CLI loads
// (settings, extensions incl. built-ins, packages, skills, AGENTS.md, enabledModels) through public interfaces only.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquire, release, waitFree } from "./lock.ts";
import { type Ask, type Run, writeRun } from "./registry.ts";

const [pkgDir, file, msg, log] = process.argv.slice(2);
if (!pkgDir || !file || !msg) {
	console.error("usage: runner.ts <pi-package-dir> <session-file> <message> [log-file]");
	process.exit(2);
}

// Only pi's public surface: its package entry (for getAgentDir) and its CLI (`pi --mode rpc`), which loads
// everything the TUI does, built-in extensions included.
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const entry: string = pkg.exports?.["."]?.import ?? pkg.main;
const bin: string = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.pi;
const pi = await import(pathToFileURL(join(pkgDir, entry)).href);

const agentDir: string = pi.getAgentDir();
const dir = join(agentDir, "background");
let cwd: string;
try {
	cwd = JSON.parse(readFileSync(file, "utf8").split("\n", 1)[0]).cwd;
} catch (e) {
	console.error(`cannot read session header of ${file}:`, e);
	process.exit(2);
}
const run: Run = {
	pid: process.pid,
	file,
	name: basename(file),
	msg,
	log: log ?? "",
	startedAt: new Date().toISOString(),
	status: "running",
	sock: join(dir, `${process.pid}.sock`),
};
const log_ = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// Record the run first so a runner stuck behind the lock still shows up in /bg list.
writeRun(dir, { ...run, status: "waiting" });
const giveUp = (error: string) => {
	log_(error);
	writeRun(dir, { ...run, status: "error", error, endedAt: new Date().toISOString() });
	process.exit(1);
};
// The TUI releases its lock only after its own turn is aborted and saved, so wait for it.
if (!(await waitFree(file, 120_000))) giveUp("session stayed locked for 2 minutes; gave up");
const got = acquire(file, "bg");
if (!got.ok) giveUp(`session locked by pid ${got.heldBy.pid} (${got.heldBy.role})`);
writeRun(dir, run);

let closeSocket = () => {};
const textOf = (m: { content?: unknown }) =>
	typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") : "";

// pi itself runs in `pi --mode rpc --session <file>`: JSON commands on its stdin, events and responses on its stdout.
let child: ChildProcess | undefined;
let reqId = 0;
const pending = new Map<string, (r: any) => void>();
const listeners = new Set<(e: any) => void>();
function rpc(command: Record<string, unknown>): Promise<any> {
	const id = `r${++reqId}`;
	return new Promise((resolve, reject) => {
		if (!child?.stdin?.writable) return reject(new Error("pi is not running"));
		pending.set(id, (r) => (r.success ? resolve(r.data) : reject(new Error(r.error ?? `${command.type} failed`))));
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
	});
}
const reply = (o: unknown) => child?.stdin?.writable && child.stdin.write(`${JSON.stringify(o)}\n`);
/** Resolves on the next event that matches. */
const next = (match: (e: any) => boolean) =>
	new Promise<any>((resolve) => {
		const l = (e: any) => {
			if (!match(e)) return;
			listeners.delete(l);
			resolve(e);
		};
		listeners.add(l);
	});

// Extension dialogs wait here until a TUI answers (watching it, or /bg from any session). No timeout of our own:
// a background turn that needs you waits for you, rather than going on with "no".
const asks = new Map<string, Ask & { timer?: ReturnType<typeof setTimeout> }>();
let broadcast: (o: unknown) => void = () => {};
const syncWaiting = () => {
	run.waiting = asks.size ? [...asks.values()].map(({ timer: _, ...a }) => a) : undefined;
	if (!finished) writeRun(dir, run);
};
function ask(a: Ask, timeout?: number) {
	// pi gives up on its own after an extension's timeout and doesn't tell us; drop the question then too.
	const timer = timeout && timeout > 0 ? setTimeout(() => settle(a.id), timeout) : undefined;
	asks.set(a.id, { ...a, timer });
	log_("waiting on you:", a.title);
	broadcast({ t: "ask", ...a });
	syncWaiting();
}
/** Removes a question; with a response, also sends it to pi. */
function settle(id: string, response?: Record<string, unknown>) {
	const a = asks.get(id);
	if (!a) return;
	asks.delete(id);
	if (a.timer) clearTimeout(a.timer);
	if (response) reply({ type: "extension_ui_response", id, ...response });
	broadcast({ t: "asked", id });
	syncWaiting();
	log_("answered", a.title, JSON.stringify(response ?? "(dropped)"));
}
function answer(id: string, value: unknown) {
	const a = asks.get(id);
	if (!a) return;
	if (a.method === "confirm") settle(id, { confirmed: value === true });
	else if (typeof value === "string" && (a.method !== "select" || a.options?.includes(value))) settle(id, { value });
	else settle(id, { cancelled: true });
}
/** A turn that ends or stops takes its open questions with it. */
const dropAsks = () => {
	for (const id of [...asks.keys()]) settle(id, { cancelled: true });
};

let finished = false;
async function finish(status: Run["status"], error?: string) {
	if (finished) return;
	finished = true;
	dropAsks();
	try {
		run.name = (await withTimeout(rpc({ type: "get_state" }), 5_000))?.sessionName ?? run.name; // auto-titles land during the turn
	} catch {}
	// Closing stdin makes pi shut down: session_shutdown runs, so pi-sync and pi-keepalive clean up.
	if (child && child.exitCode === null) {
		const exited = new Promise((r) => child!.once("exit", r));
		child.stdin?.end();
		if (!(await withTimeout(exited, 15_000).then(() => true, () => false))) child.kill("SIGKILL");
	}
	closeSocket();
	release(file);
	writeRun(dir, { ...run, waiting: undefined, status, error, endedAt: new Date().toISOString() });
	log_("finished", status, error ?? "");
	process.exit(status === "done" ? 0 : 1);
}
const withTimeout = <T>(p: Promise<T>, ms: number) =>
	Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms).unref())]);

/** Stops the turn; pi's abort resolves once the partial turn is saved. */
async function stop(why: string) {
	if (finished) return;
	log_(why, "- aborting so the partial turn is saved");
	dropAsks();
	try {
		await withTimeout(rpc({ type: "abort" }), 15_000);
	} catch (e) {
		log_("abort failed", e);
	}
	await finish("stopped");
}
for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, () => void stop(`got ${sig}`));

try {
	// The session header's cwd wins in pi anyway; starting there keeps relative paths in extensions honest.
	child = spawn(process.execPath, [join(pkgDir, bin), "--mode", "rpc", "--session", file], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr!.on("data", (d) => process.stdout.write(d));
	child.on("exit", (code, sig) => {
		for (const r of pending.values()) r({ success: false, error: `pi exited (${sig ?? code})` });
		pending.clear();
		if (!finished) void finish("error", `pi exited unexpectedly (${sig ?? code})`);
	});
	let buf = "";
	child.stdout!.on("data", (d) => {
		buf += d;
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let m: any;
			try {
				m = JSON.parse(line);
			} catch {
				log_("pi:", line);
				continue;
			}
			if (m.type === "response" && m.id && pending.has(m.id)) {
				pending.get(m.id)!(m);
				pending.delete(m.id);
			} else if (m.type === "extension_ui_request") {
				if (["select", "confirm", "input", "editor"].includes(m.method))
					ask({ id: m.id, method: m.method, title: m.title, message: m.message, options: m.options, placeholder: m.placeholder, prefill: m.prefill }, m.timeout);
				else if (m.method === "notify") {
					log_("notify", m.notifyType ?? "info", m.message);
					broadcast({ t: "notify", d: m.message, level: m.notifyType ?? "info" });
				}
			} else if (m.type === "extension_error") log_("extension error", m.extensionPath, m.error);
			else for (const l of [...listeners]) l(m);
		}
	});

	// Watchers (a TUI that /resumed this session) connect here: we stream events out, and take
	// queued messages, answers and aborts in. One JSON object per line each way.
	const watchers = new Set<Socket>();
	const queued: { d: string; id?: string }[] = [];
	const send = (o: unknown) => {
		const line = `${JSON.stringify(o)}\n`;
		for (const w of watchers) w.write(line);
	};
	broadcast = send;
	// What a watcher that connects mid-message missed: the reply so far and the tool now running.
	let partial = "";
	let tool: string | undefined;
	let last: { stopReason?: string; errorMessage?: string } | undefined;
	listeners.add((e: any) => {
		if (e.type === "message_start" && e.message?.role === "assistant") partial = "";
		else if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") {
			partial += e.assistantMessageEvent.delta;
			send({ t: "text", d: e.assistantMessageEvent.delta });
		} else if (e.type === "message_start" && e.message?.role === "user") send({ t: "user", d: textOf(e.message) });
		else if (e.type === "message_end" && e.message?.role === "assistant") {
			partial = "";
			last = e.message;
			send({ t: "end" });
		} else if (e.type === "tool_execution_start") {
			tool = `${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 120)}`;
			send({ t: "tool", d: tool });
		} else if (e.type === "tool_execution_end") {
			tool = undefined;
			if (e.isError) send({ t: "tool_err", d: e.toolName });
		} else if (e.type === "agent_end") dropAsks();
	});
	const server = createServer((c) => {
		if (partial) c.write(`${JSON.stringify({ t: "text", d: partial })}\n`);
		if (tool) c.write(`${JSON.stringify({ t: "tool", d: tool })}\n`);
		for (const { timer: _, ...a } of asks.values()) c.write(`${JSON.stringify({ t: "ask", ...a })}\n`);
		watchers.add(c);
		c.on("close", () => watchers.delete(c));
		c.on("error", () => watchers.delete(c));
		let cbuf = "";
		c.on("data", (d) => {
			cbuf += d;
			for (let i = cbuf.indexOf("\n"); i >= 0; i = cbuf.indexOf("\n")) {
				const line = cbuf.slice(0, i);
				cbuf = cbuf.slice(i + 1);
				let m: { t: string; d?: string; id?: string; value?: unknown };
				try {
					m = JSON.parse(line);
				} catch {
					continue;
				}
				if (m.t === "answer" && m.id) answer(m.id, m.value);
				else if (m.t === "abort") void stop("watcher pressed Esc");
				else if (m.t === "msg" && m.d) {
					log_("queued from watcher", JSON.stringify(m.d));
					// Run after the current prompt, in order. One that arrives after the last is never confirmed
					// ("took"), and the watcher sends it again itself once this run lets go of the session.
					queued.push({ d: m.d, id: m.id });
				}
			}
		});
	});
	rmSync(run.sock!, { force: true });
	server.listen(run.sock);
	closeSocket = () => {
		for (const w of watchers) w.end();
		server.close();
		rmSync(run.sock!, { force: true });
	};

	const state = await withTimeout(rpc({ type: "get_state" }), 60_000);
	run.name = state.sessionName ?? run.name;
	writeRun(dir, run);

	/** One prompt to the end of its run. False if an extension refused it. */
	const prompt = async (text: string) => {
		const settled = next((e) => e.type === "agent_settled");
		const { disposition } = await rpc({ type: "prompt", message: text });
		// pi answers "handled" both for a prompt an extension refused and for an extension command, which runs
		// right there; only plain messages can tell us they were refused.
		if (disposition === "handled") return text.startsWith("/");
		await settled;
		return true;
	};
	log_("prompting", JSON.stringify(msg), "model", state.model?.id);
	// An extension can swallow the prompt (pi-sync does when another device holds the conversation's lease).
	if (!(await prompt(msg))) await finish("error", "prompt was not sent: an extension refused it (another device may be running this conversation)");
	while (queued.length && !finished) {
		const q = queued.shift()!;
		if (q.id) send({ t: "took", id: q.id });
		await prompt(q.d);
	}
	if (!finished) await finish(last?.stopReason === "error" ? "error" : "done", last?.stopReason === "error" ? last.errorMessage : undefined);
} catch (e) {
	log_("failed", e);
	await finish("error", String((e as Error)?.message ?? e));
}
