import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { acquire, holder, release, waitFree } from "./lock.ts";
import { listRuns, type Run } from "./registry.ts";

const RUNNER = fileURLToPath(new URL("./runner.ts", import.meta.url));
const STATUS = "pi-background";
const WAIT_MS = 30 * 60 * 1000;

const runsDir = () => join(getAgentDir(), "background");
const label = (r: Run) => `${r.name}  ${r.status}  ${r.startedAt.slice(11, 16)}  "${r.msg.slice(0, 50)}"`;

/** Start a detached runner for one turn on `file`. It waits for this process to release the session lock. */
function spawnRunner(file: string, msg: string, cwd: string): void {
	const dir = runsDir();
	mkdirSync(dir, { recursive: true });
	const log = join(dir, `${Date.now()}-${basename(file, ".jsonl")}.log`);
	const out = openSync(log, "a");
	spawn(process.execPath, [RUNNER, getPackageDir(), file, msg, log], {
		cwd,
		detached: true,
		stdio: ["ignore", out, out],
		env: { ...process.env, PI_BACKGROUND: "1" },
	}).unref();
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_BACKGROUND) return; // the runner locks its own session; don't nest
	let held: string | undefined;
	let pendingContinue: string | undefined;
	let ui: ExtensionContext | undefined;
	const notified = new Set<string>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const poll = () => {
		const runs = listRuns(runsDir());
		const running = runs.filter((r) => r.status === "running").length;
		ui?.ui.setStatus(STATUS, running ? `bg: ${running} running` : undefined);
		for (const r of runs) {
			const key = `${r.pid}:${r.startedAt}`;
			if (r.status === "running" || notified.has(key)) continue;
			notified.add(key);
			if (timer) ui?.ui.notify(`bg: ${r.name} ${r.status}${r.error ? `: ${r.error}` : ""}`, r.status === "done" ? "info" : "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx;
		if (!timer) {
			poll(); // mark already-finished runs as seen without notifying
			timer = setInterval(poll, 5000);
			timer.unref();
		}
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		const got = acquire(file, "tui");
		if (got.ok) held = file;
		else
			ctx.ui.notify(
				got.heldBy.role === "bg"
					? `This session is running in the background (pid ${got.heldBy.pid}). Switch away, or /bg stop it, before typing here.`
					: `This session is open in another pi (pid ${got.heldBy.pid}). Writing from both corrupts it.`,
				"warning",
			);
		if (pendingContinue === file) {
			pendingContinue = undefined;
			setTimeout(() => pi.sendUserMessage("continue"), 0); // after the switch finishes
		}
	});

	pi.on("session_shutdown", (event) => {
		if (held) release(held);
		held = undefined;
		if (event.reason === "quit" && timer) clearInterval(timer);
	});

	pi.on("session_before_switch", async (event, ctx) => {
		const target = event.targetSessionFile;
		const h = target ? holder(target) : undefined;
		if (target && h?.role === "bg") {
			if (!ctx.hasUI) return { cancel: true };
			const c = await ctx.ui.select(`${basename(target)} is running in the background`, [
				"Wait for its turn to end",
				"Stop it and continue here",
				"Cancel",
			]);
			if (!c || c === "Cancel") return { cancel: true };
			if (c.startsWith("Stop")) {
				try {
					process.kill(h.pid, "SIGTERM");
				} catch {} // already gone: waitFree returns at once
				pendingContinue = target;
			}
			ctx.ui.notify("Waiting for the background turn to end…", "info");
			if (!(await waitFree(target, WAIT_MS))) {
				pendingContinue = undefined;
				ctx.ui.notify("Still running; switch cancelled.", "warning");
				return { cancel: true };
			}
		}
		const current = ctx.sessionManager.getSessionFile();
		if (current && !ctx.isIdle() && ctx.hasUI) {
			const c = await ctx.ui.select("This session is still working", ["Move it to the background", "Abort it", "Cancel"]);
			if (!c || c === "Cancel") return { cancel: true };
			// pi aborts and saves the turn during the switch, then we release the lock; the runner waits for that.
			if (c.startsWith("Move")) spawnRunner(current, "continue", ctx.cwd);
		}
		return undefined;
	});

	pi.registerCommand("bg", {
		description: "Background sessions: /bg <message> | /bg list | /bg stop",
		getArgumentCompletions: (prefix: string) =>
			["list", "stop"].filter((k) => k.startsWith(prefix)).map((k) => ({ value: k, label: k })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			const runs = listRuns(runsDir());
			if (arg === "list") {
				ctx.ui.notify(runs.length ? runs.map(label).join("\n") : "No background runs.", "info");
				return;
			}
			if (arg === "stop") {
				const running = runs.filter((r) => r.status === "running");
				if (!running.length) return ctx.ui.notify("Nothing running in the background.", "info");
				const c = await ctx.ui.select("Stop which run?", running.map(label));
				const r = running.find((x) => label(x) === c);
				if (r) process.kill(r.pid, "SIGTERM");
				return;
			}
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return ctx.ui.notify("This session isn't saved to a file, so it can't run in the background.", "error");
			if (!ctx.isIdle()) return ctx.ui.notify("Busy. Switch sessions and pick 'Move it to the background' instead.", "warning");
			spawnRunner(file, arg || "continue", ctx.cwd);
			// Leave the session so only the runner writes to it; switching releases our lock.
			await ctx.newSession();
			ctx.ui.notify(`bg: ${basename(file)} started. /resume it any time; /bg list shows progress.`, "info");
		},
	});
}
