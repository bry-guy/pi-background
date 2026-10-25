// Detached background runner: runs one turn of an existing pi session, then exits.
// Usage: node runner.ts <pi-package-dir> <session-file> <message> <log-file>
// Builds the session the same way pi's CLI does (dist/main.js createRuntime), minus CLI flags,
// so it loads the same settings, extensions, packages, skills and AGENTS.md as the TUI.
import { readFileSync } from "node:fs";
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
};
const log_ = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// The TUI releases its lock only after its own turn is aborted and saved, so wait for it.
if (!(await waitFree(file, 120_000))) {
	log_("session is still locked; giving up");
	process.exit(1);
}
const got = acquire(file, "bg");
if (!got.ok) {
	log_("lock taken by", got.heldBy);
	process.exit(1);
}
writeRun(dir, run);

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
	release(file);
	writeRun(dir, { ...run, status, error, endedAt: new Date().toISOString() });
	log_("finished", status, error ?? "");
	process.exit(status === "done" ? 0 : 1);
}

for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
	process.on(sig, async () => {
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
		for (const e of services.resourceLoader.getExtensions().errors) log_("extension failed:", e.path, e.error);
		const created = await pi.createAgentSessionFromServices({
			services,
			sessionManager: o.sessionManager,
			sessionStartEvent: o.sessionStartEvent,
		});
		return { ...created, services, diagnostics: [] };
	};
	const sessionManager = pi.SessionManager.open(file);
	run.name = sessionManager.getSessionName() ?? run.name;
	runtime = await pi.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	const session = runtime!.session;
	await session.bindExtensions({ mode: "print", onError: (e: { extensionPath: string; error: string }) => log_("extension error", e.extensionPath, e.error) });
	log_("prompting", JSON.stringify(msg), "model", session.model?.id);
	await session.prompt(msg);
	const last = session.messages.at(-1);
	await finish(last?.stopReason === "error" ? "error" : "done", last?.errorMessage);
} catch (e) {
	log_("failed", e);
	await finish("error", String((e as Error)?.message ?? e));
}
