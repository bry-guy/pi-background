import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { acquire, holder, release, waitFree } from "./lock.ts";
import { type Ask, listRuns, type Run } from "./registry.ts";

const RUNNER = fileURLToPath(new URL("./runner.ts", import.meta.url));
const STATUS = "pi-background";
const WATCH = "pi-background-watch";
// Saved as the backgrounded turn's prompt so the model knows why its last step reads "aborted".
const MOVED = "(This session was moved to the background mid-turn; the last step was interrupted.) Continue.";

/** Session name, else its first user message, for notices. */
const titleOf = (ctx: ExtensionContext) => {
	const first = ctx.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message?.role === "user") as any;
	const text = first ? [first.message.content].flat().map((c: any) => (typeof c === "string" ? c : (c.text ?? ""))).join("") : "";
	return ctx.sessionManager.getSessionName() ?? (text.slice(0, 40) || "session");
};

const runsDir = () => join(getAgentDir(), "background");
const label = (r: Run) => `${r.name}  ${r.waiting?.length ? "waiting on you" : r.status}  ${r.startedAt.slice(11, 16)}  "${r.msg.slice(0, 50)}"`;

/**
 * The pi package the runner should load. This process's own getPackageDir() can point at a removed or
 * bundled install (a pi started before an upgrade), so fall back to the pi on PATH.
 */
function piPackageDir(): string {
	const own = getPackageDir();
	if (existsSync(join(own, "dist/index.js"))) return own;
	const bin = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
	// npm installs link into the package itself; Homebrew's pi is a wrapper next to libexec/.
	for (let d = dirname(bin); d !== "/"; d = dirname(d)) {
		for (const c of [d, join(d, "libexec/lib/node_modules/@earendil-works/pi-coding-agent")])
			if (existsSync(join(c, "dist/index.js")) && existsSync(join(c, "package.json"))) return c;
	}
	return own;
}

/** Start a detached runner for one turn on `file`. It waits for this process to release the session lock. */
function spawnRunner(file: string, msg: string, cwd: string, warn: (text: string) => void): void {
	const dir = runsDir();
	mkdirSync(dir, { recursive: true });
	const log = join(dir, `${Date.now()}-${basename(file, ".jsonl")}.log`);
	const out = openSync(log, "a");
	const child = spawn(process.execPath, [RUNNER, piPackageDir(), file, msg, log], {
		cwd,
		detached: true,
		stdio: ["ignore", out, out],
		env: { ...process.env, PI_BACKGROUND: "1" },
	});
	// A runner that dies before writing its run record would otherwise vanish without a trace.
	child.on("exit", (code) => {
		if (code && !listRuns(dir).some((r) => r.pid === child.pid)) warn(`Background run failed to start (exit ${code}). Log: ${log}`);
	});
	child.unref();
}

// pi re-runs the extension factory on every session switch, so state that must survive a switch lives here.
let pendingNotice: string | undefined;
const notified = new Set<string>();
let primed = false;
// The live session's ui; a runner's exit can arrive after the session that started it was replaced.
let liveUi: ExtensionContext["ui"] | undefined;
// Questions from background runs already announced (by id), so each is notified once per pi process.
const announced = new Set<string>();

/**
 * Shows a background run's question here and returns the answer, or undefined if dismissed (Esc), which leaves
 * the run waiting. Confirm goes through a select so Esc can mean "later" rather than "no".
 */
async function showAsk(ui: ExtensionContext["ui"], a: Ask, from: string, signal?: AbortSignal): Promise<{ value: unknown } | undefined> {
	const title = `${from} asks: ${a.title}`;
	if (a.method === "confirm") {
		const c = await ui.select(a.message ? `${title}\n${a.message}` : title, ["Yes", "No"], { signal });
		return c === undefined ? undefined : { value: c === "Yes" };
	}
	const v =
		a.method === "select"
			? await ui.select(title, a.options ?? [], { signal })
			: a.method === "input"
				? await ui.input(title, a.placeholder, { signal })
				: await ui.editor(title, a.prefill);
	return v === undefined ? undefined : { value: v };
}

/** Sends an answer to a run's socket (a short connection of its own). */
function sendAnswer(sock: string, id: string, value: unknown): Promise<void> {
	return new Promise((resolve) => {
		const c = connect(sock, () => c.end(`${JSON.stringify({ t: "answer", id, value })}\n`, () => resolve()));
		c.on("error", () => resolve());
	});
}

// Messages queued to a background run that it never took (it finished first): sent here after the reload.
let resend: { file: string; texts: string[] } | undefined;
const warn = (text: string) => liveUi?.notify(text, "error");

export default function (pi: ExtensionAPI) {
	if (process.env.PI_BACKGROUND) return; // the runner locks its own session; don't nest
	let held: string | undefined;
	// Session opened while another process was writing it: our in-memory copy may be behind the file.
	let stale: string | undefined;
	let ui: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let watching:
		| { file: string; sock?: Socket; lines: string[]; pending: Map<string, string>; asking: Map<string, AbortController>; stopInput: () => void }
		| undefined;

	const render = () => {
		if (!watching || !ui) return;
		ui.ui.setWidget(WATCH, ["── background session running (Esc stops it) ──", ...watching.lines.join("").split("\n").slice(-14)]);
	};

	/** Stream the background run on `file` into this TUI; reload the session when the run lets go of it. */
	function watch(ctx: ExtensionContext, file: string) {
		const w: NonNullable<typeof watching> = { file, lines: [], pending: new Map(), asking: new Map(), stopInput: () => {} };
		watching = w;
		ctx.ui.setStatus(WATCH, "background session running");
		w.stopInput = ctx.ui.onTerminalInput((data) => {
			if (watching !== w || data !== "\x1b") return undefined;
			w.sock?.write(`${JSON.stringify({ t: "abort" })}\n`);
			return { consume: true };
		});
		const attach = () => {
			if (watching !== w) return;
			const run = listRuns(runsDir()).find((r) => r.file === file && (r.status === "running" || r.status === "waiting"));
			if (!run?.sock || !existsSync(run.sock)) {
				// Runner still starting, or already gone: retry until it's live or the lock is free.
				if (holder(file)?.role === "bg") setTimeout(attach, 500);
				else void reload();
				return;
			}
			const sock = connect(run.sock);
			w.sock = sock;
			let buf = "";
			sock.on("data", (d) => {
				buf += d;
				for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
					let m: { t: string; d?: string; id?: string; level?: string } & Partial<Ask>;
					try {
						m = JSON.parse(buf.slice(0, i));
					} catch {
						m = { t: "" };
					}
					buf = buf.slice(i + 1);
					if (m.t === "text") w.lines.push(m.d ?? "");
					else if (m.t === "user") w.lines.push(`\n› ${m.d}\n`);
					else if (m.t === "tool") w.lines.push(`\n⚙ ${m.d}\n`);
					else if (m.t === "tool_err") w.lines.push(`✗ ${m.d} failed\n`);
					else if (m.t === "end") w.lines.push("\n");
					else if (m.t === "took" && m.id) w.pending.delete(m.id);
					else if (m.t === "notify" && m.d) ctx.ui.notify(m.d, m.level === "error" ? "error" : m.level === "warning" ? "warning" : "info");
					else if (m.t === "ask" && m.id && !w.asking.has(m.id)) {
						// The run is paused on this question: ask it here, like the session's own dialog.
						const a = m as Ask;
						const ctl = new AbortController();
						w.asking.set(a.id, ctl);
						w.lines.push(`\n? ${a.title}\n`);
						void showAsk(ctx.ui, a, "Background run", ctl.signal)
							.then((got) => {
								if (got && watching === w && !ctl.signal.aborted) sock.write(`${JSON.stringify({ t: "answer", id: a.id, value: got.value })}\n`);
							})
							.catch(() => {})
							.finally(() => w.asking.delete(a.id));
					} else if (m.t === "asked" && m.id) w.asking.get(m.id)?.abort(); // answered elsewhere
				}
				render();
			});
			sock.on("error", () => {});
			sock.on("close", () => void reload());
		};
		const reload = async () => {
			if (watching !== w) return;
			await waitFree(file, 120_000);
			if (watching !== w) return;
			if (w.pending.size) resend = { file, texts: [...w.pending.values()] };
			// Only a command context can switch sessions; switching to the same file reloads what the runner wrote.
			pi.sendUserMessage("/bg-reload", { expandPromptTemplates: true });
		};
		attach();
		render();
	}

	function unwatch() {
		if (!watching) return;
		watching.stopInput();
		for (const ctl of watching.asking.values()) ctl.abort();
		watching.sock?.destroy();
		watching = undefined;
		ui?.ui.setWidget(WATCH, undefined);
		ui?.ui.setStatus(WATCH, undefined);
	}

	/** /bg with no message: answer what background runs are waiting on, from here, one after another. */
	async function answerWaiting(ctx: ExtensionContext) {
		const open = listRuns(runsDir()).flatMap((r) =>
			r.status === "running" && r.sock ? (r.waiting ?? []).map((a) => ({ r, a, label: `${r.name}: ${a.title}` })) : [],
		);
		if (!open.length) return ctx.ui.notify("Usage: /bg <message>. No background run is waiting on you.", "info");
		let item = open[0]!;
		if (open.length > 1) {
			const c = await ctx.ui.select("Waiting on you", open.map((o) => o.label));
			const found = open.find((o) => o.label === c);
			if (!found) return;
			item = found;
		}
		const got = await showAsk(ctx.ui, item.a, `"${item.r.name}"`);
		if (!got) return; // Esc: still waiting
		await sendAnswer(item.r.sock!, item.a.id, got.value);
		ctx.ui.notify(`Answered; "${item.r.name}" continues in the background.`, "info");
	}

	const poll = () => {
		const runs = listRuns(runsDir());
		const live = runs.filter((r) => r.status === "running" || r.status === "waiting");
		const blocked = live.filter((r) => r.waiting?.length);
		ui?.ui.setStatus(STATUS, live.length ? `bg: ${live.length} running${blocked.length ? `, ${blocked.length} waiting on you` : ""}` : undefined);
		for (const r of blocked) {
			for (const a of r.waiting!) {
				if (announced.has(a.id)) continue;
				announced.add(a.id);
				// Watching it already shows the question.
				if (primed && watching?.file !== r.file) ui?.ui.notify(`"${r.name}" is waiting on you: ${a.title}\n/bg to answer here, or /resume it.`, "warning");
			}
		}
		for (const r of runs) {
			const key = `${r.pid}:${r.startedAt}`;
			if (r.status === "running" || r.status === "waiting" || notified.has(key)) continue;
			notified.add(key);
			if (primed) ui?.ui.notify(`bg: ${r.name} ${r.status}${r.error ? `: ${r.error}` : ""}`, r.status === "done" ? "info" : "warning");
		}
	};

	pi.on("session_start", (_event, ctx) => {
		ui = ctx;
		liveUi = ctx.ui;
		poll(); // the first poll in a pi process marks already-finished runs as seen without notifying
		primed = true;
		timer = setInterval(poll, 5000);
		timer.unref();
		lock(ctx);
		const file = ctx.sessionManager.getSessionFile();
		if (file && holder(file)?.role === "bg") watch(ctx, file);
		if (pendingNotice) ctx.ui.notify(pendingNotice, "info");
		pendingNotice = undefined;
	});

	// A new session's file appears only after its first reply, so retry around turns.
	pi.on("agent_start", (_event, ctx) => lock(ctx));
	pi.on("agent_end", (_event, ctx) => lock(ctx));

	function lock(ctx: ExtensionContext) {
		const file = ctx.sessionManager.getSessionFile();
		if (!file || held === file || !existsSync(file)) return; // no file yet: nobody else can be writing it
		const got = acquire(file, "tui");
		if (got.ok) held = file;
		else if (got.heldBy.role !== "bg") {
			stale = file;
			ctx.ui.notify(
				`This session is open in another pi (pid ${got.heldBy.pid}). Writing from both corrupts it.`,
				"warning",
			);
		}
	}

	// Startup (pi -c, pi --session) fires no session_before_switch, so the only safe gate is before input is accepted.
	pi.on("input", (event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		if (watching && watching.file === file) {
			// Like typing during a turn: the message is queued and the background run picks it up.
			const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			watching.pending.set(id, event.text);
			watching.sock?.write(`${JSON.stringify({ t: "msg", d: event.text, id })}\n`);
			watching.lines.push(`\n⏳ queued: ${event.text}\n`);
			render();
			return { action: "handled" };
		}
		if (!file || held === file) return { action: "continue" };
		if (stale !== file) {
			lock(ctx);
			if (held === file || !existsSync(file)) return { action: "continue" };
		}
		const h = holder(file);
		ctx.ui.notify(
			h
				? `Not sent: pid ${h.pid} (${h.role}) is writing this session. ${h.role === "bg" ? "/bg stop it or wait" : "Close it there"}, then /resume this session.`
				: "Not sent: this session changed on disk while it was open here. /resume it to load the latest version.",
			"warning",
		);
		return { action: "handled" };
	});

	pi.on("session_shutdown", () => {
		if (held) release(held);
		held = undefined;
		stale = undefined;
		unwatch();
		clearInterval(timer);
		ui = undefined;
		liveUi = undefined; // this ctx goes stale once the session is replaced
	});

	pi.on("session_before_switch", (_event, ctx) => {
		// Leaving mid-turn: pi aborts and saves the turn, we release the lock, and the runner (waiting on it) finishes the work.
		const current = ctx.sessionManager.getSessionFile();
		if (current && !ctx.isIdle() && !watching) {
			spawnRunner(current, MOVED, ctx.cwd, warn);
			pendingNotice = `Running "${titleOf(ctx)}" in background…`;
		}
		return undefined;
	});

	pi.registerCommand("bg-reload", {
		description: "(internal) reload a session after its background turn ends",
		handler: async (_args, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return;
			const texts = resend?.file === file ? resend.texts : [];
			resend = undefined;
			await ctx.switchSession(file, {
				withSession: async (c) => {
					if (texts.length) c.ui.notify(`The background run ended before taking ${texts.length > 1 ? `${texts.length} queued messages` : "your queued message"}; sending ${texts.length > 1 ? "them" : "it"} here.`, "info");
					for (const [i, text] of texts.entries()) await c.sendUserMessage(text, i ? { deliverAs: "followUp" } : undefined);
				},
			});
		},
	});

	pi.registerCommand("bg", {
		description: "Background sessions: /bg <message> | /bg (answer a waiting run) | /bg list | /bg stop",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const runs = listRuns(runsDir());
			if (/^(list|stop)\b/.test(arg) && arg !== "list" && arg !== "stop")
				return ctx.ui.notify(`Unknown: /bg ${arg}. Use /bg list, /bg stop, or /bg <message>.`, "warning");
			if (!arg) return answerWaiting(ctx);
			if (arg === "list") {
				ctx.ui.notify(runs.length ? runs.map(label).join("\n") : "No background runs.", "info");
				return;
			}
			if (arg === "stop") {
				const running = runs.filter((r) => r.status === "running" || r.status === "waiting");
				if (!running.length) return ctx.ui.notify("Nothing running in the background.", "info");
				const c = await ctx.ui.select("Stop which run?", running.map(label));
				const r = running.find((x) => label(x) === c);
				if (r) process.kill(r.pid, "SIGTERM");
				return;
			}
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return ctx.ui.notify("This session isn't saved to a file, so it can't run in the background.", "error");
			if (!ctx.isIdle()) return ctx.ui.notify("Busy. Just switch sessions; the turn moves to the background.", "warning");
			// pi writes a new session's file only after the first reply; the runner needs it to exist.
			if (!existsSync(file)) writeFileSync(file, `${JSON.stringify(ctx.sessionManager.getHeader())}\n`);
			spawnRunner(file, arg, ctx.cwd, warn);
			const notice = `Running "${titleOf(ctx)}" in background…`;
			// Leave the session so only the runner writes to it; switching releases our lock.
			await ctx.newSession({
				withSession: async (c) => c.ui.notify(notice, "info"),
			});
		},
	});
}
