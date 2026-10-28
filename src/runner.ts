// Detached background runner: runs one turn of an existing pi session, then exits.
// Usage: node runner.ts <pi-package-dir> <session-file> <message> <log-file>
// Builds the session the same way pi's CLI does (dist/main.js createRuntime), minus CLI flags,
// so it loads the same settings, extensions, packages, skills and AGENTS.md as the TUI.
import { readFileSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquire, release, waitFree } from "./lock.ts";
import { type Run, writeRun } from "./registry.ts";

const [pkgDir, file, msg, log] = process.argv.slice(2);
if (!pkgDir || !file || !msg) {
	console.error("usage: runner.ts <pi-package-dir> <session-file> <message> [log-file]");
	process.exit(2);
}

const pi = await import(pathToFileURL(join(pkgDir, "dist/index.js")).href);
const { builtInExtensions } = await import(pathToFileURL(join(pkgDir, "dist/extensions/index.js")).href);

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

let runtime: { session: any; dispose(): Promise<void> } | undefined;
let finished = false;
async function finish(status: Run["status"], error?: string) {
	if (finished) return;
	finished = true;
	run.name = runtime?.session.sessionManager.getSessionName() ?? run.name; // auto-titles may land during the turn
	try {
		await runtime?.dispose(); // emits session_shutdown, so extensions like pi-sync and pi-keepalive clean up
	} catch (e) {
		log_("dispose failed", e);
	}
	closeSocket();
	release(file);
	writeRun(dir, { ...run, status, error, endedAt: new Date().toISOString() });
	log_("finished", status, error ?? "");
	process.exit(status === "done" ? 0 : 1);
}

for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
	process.on(sig, async () => {
		if (finished) return;
		log_("got", sig, "- aborting so the partial turn is saved");
		try {
			await runtime?.session.abort();
		} catch (e) {
			log_("abort failed", e);
		}
		await finish("stopped");
	});
}

try {
	process.chdir(cwd);
	const trustStore = new pi.ProjectTrustStore(agentDir);
	const projectTrusted = !pi.hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
	if (!projectTrusted) log_("project is not trusted; its project-local resources are skipped");

	const createRuntime = async (o: { cwd: string; agentDir: string; sessionManager: unknown; sessionStartEvent?: unknown }) => {
		const settingsManager = pi.SettingsManager.create(o.cwd, o.agentDir, { projectTrusted });
		const services = await pi.createAgentSessionServices({
			cwd: o.cwd,
			agentDir: o.agentDir,
			settingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			resourceLoaderOptions: { extensionFactories: builtInExtensions },
		});
		const ext = services.resourceLoader.getExtensions();
		log_("extensions:", ext.extensions.map((e: { path: string }) => e.path.split("/node_modules/").at(-1)).join(", "));
		for (const e of ext.errors) log_("extension failed:", e.path, e.error);
		// Mirror main.js buildSessionOptions: enabledModels scope the model, and a new session starts on
		// the saved default if it's in scope, else the first scoped model. Existing sessions restore their own.
		const patterns: string[] | undefined = settingsManager.getEnabledModels();
		const scoped: { model: any; thinkingLevel?: string }[] = patterns?.length
			? (await pi.resolveModelScopeWithDiagnostics(patterns, services.modelRuntime, { signal: AbortSignal.timeout(15_000) })).scopedModels
			: [];
		const sm = o.sessionManager as { buildSessionContext(): { messages: unknown[] } };
		let pick: (typeof scoped)[number] | undefined;
		if (scoped.length && sm.buildSessionContext().messages.length === 0) {
			const p = settingsManager.getDefaultProvider();
			const id = settingsManager.getDefaultModel();
			const saved = p && id ? services.modelRuntime.getModel(p, id) : undefined;
			pick = scoped.find((x) => saved && x.model.provider === saved.provider && x.model.id === saved.id) ?? scoped[0];
		}
		const created = await pi.createAgentSessionFromServices({
			services,
			sessionManager: o.sessionManager,
			sessionStartEvent: o.sessionStartEvent,
			model: pick?.model,
			thinkingLevel: pick?.thinkingLevel,
			scopedModels: scoped.length ? scoped : undefined,
		});
		return { ...created, services, diagnostics: [] };
	};
	const sessionManager = pi.SessionManager.open(file);
	run.name = sessionManager.getSessionName() ?? run.name;
	runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	const session = runtime!.session;
	await session.bindExtensions({ mode: "print", onError: (e: { extensionPath: string; error: string }) => log_("extension error", e.extensionPath, e.error) });
	// Watchers (a TUI that /resumed this session) connect here: we stream events out, and take
	// queued messages and aborts in. One JSON object per line each way.
	const watchers = new Set<Socket>();
	const queued: string[] = [];
	const send = (o: unknown) => {
		const line = `${JSON.stringify(o)}\n`;
		for (const w of watchers) w.write(line);
	};
	session.subscribe((e: any) => {
		if (e.type === "message_update" && e.assistantMessageEvent?.type === "text_delta") send({ t: "text", d: e.assistantMessageEvent.delta });
		else if (e.type === "message_start" && e.message?.role === "user") send({ t: "user", d: textOf(e.message) });
		else if (e.type === "message_end" && e.message?.role === "assistant") send({ t: "end" });
		else if (e.type === "tool_execution_start") send({ t: "tool", d: `${e.toolName} ${JSON.stringify(e.args ?? {}).slice(0, 120)}` });
		else if (e.type === "tool_execution_end" && e.isError) send({ t: "tool_err", d: e.toolName });
	});
	const server = createServer((c) => {
		watchers.add(c);
		c.on("close", () => watchers.delete(c));
		c.on("error", () => watchers.delete(c));
		let buf = "";
		c.on("data", (d) => {
			buf += d;
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let m: { t: string; d?: string };
				try {
					m = JSON.parse(line);
				} catch {
					continue;
				}
				if (m.t === "abort") void session.abort().then(() => finish("stopped"));
				else if (m.t === "msg" && m.d) {
					log_("queued from watcher", JSON.stringify(m.d));
					// Mid-run messages join the loop like a TUI follow-up; late ones run after it.
					if (session.isStreaming) void session.followUp(m.d);
					else queued.push(m.d);
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
	writeRun(dir, run);

	log_("prompting", JSON.stringify(msg), "model", session.model?.id);
	const before = session.messages.length;
	await session.prompt(msg);
	while (queued.length) await session.prompt(queued.shift()!);
	// An extension can swallow the prompt (pi-sync does when another device holds the conversation's lease).
	const last = session.messages.at(-1);
	if (session.messages.length === before)
		await finish("error", "prompt was not sent: an extension refused it (another device may be running this conversation)");
	else await finish(last?.stopReason === "error" ? "error" : "done", last?.errorMessage);
} catch (e) {
	log_("failed", e);
	await finish("error", String((e as Error)?.message ?? e));
}
