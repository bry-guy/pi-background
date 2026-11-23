import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./lock.ts";

/** One background run, stored as <dir>/<pid>.json by the runner. */
export type Run = {
	pid: number;
	file: string;
	name: string;
	msg: string;
	log: string;
	startedAt: string;
	status: "waiting" | "running" | "done" | "error" | "stopped" | "stalled" | "died";
	endedAt?: string;
	error?: string;
	/** Unix socket watchers connect to while the run is live. */
	sock?: string;
	/** Questions an extension asked that wait for an answer from a TUI; the turn is paused on them. */
	waiting?: Ask[];
	/** What the run is doing now ("running bash"), null between tools' turns; absent in records before this field. */
	activity?: string | null;
	/** When `activity` last changed (ms). */
	activityAt?: number;
};

/** An extension dialog (select, confirm, input, editor) a background run forwards to whoever answers first. */
export type Ask = {
	id: string;
	method: "select" | "confirm" | "input" | "editor";
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
};

const DAY = 24 * 60 * 60 * 1000;

export function writeRun(dir: string, run: Run): void {
	mkdirSync(dir, { recursive: true });
	// Write then rename: a reader never sees a half-written record (which made a live run look missing, then "died").
	const tmp = join(dir, `${run.pid}.json.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(run, null, 2));
	renameSync(tmp, join(dir, `${run.pid}.json`));
}

/** All runs, newest first. A "running" run whose process is gone is reported as "died". Runs ended over a day ago are pruned. */
export function listRuns(dir: string): Run[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch {
		return [];
	}
	const runs: Run[] = [];
	for (const n of names) {
		try {
			const r: Run = JSON.parse(readFileSync(join(dir, n), "utf8"));
			if ((r.status === "running" || r.status === "waiting") && !alive(r.pid)) r.status = "died";
			const ended = r.endedAt ? Date.parse(r.endedAt) : r.status === "died" ? Date.parse(r.startedAt) : undefined;
			if (ended && Date.now() - ended > DAY) {
				rmSync(join(dir, n), { force: true });
				rmSync(r.log, { force: true });
				if (r.sock) rmSync(r.sock, { force: true });
				continue;
			}
			runs.push(r);
		} catch {}
	}
	return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A running run's activity: what the step is about when pi-summarize has said so, and the tool running now. */
export const nowDoing = (step: string | undefined, tool: string) => (step ? `${step} (${tool})` : `running ${tool}`);

/** Sets run.activity, saving the record at most once per `ms`; the last change always lands. */
export function activityTracker(run: Run, save: () => void, ms = 3_000) {
	let savedAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (text: string | null) => {
		if (run.activity === text) return;
		run.activity = text;
		run.activityAt = Date.now();
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			savedAt = Date.now();
			save();
		}, Math.max(0, savedAt + ms - Date.now()));
		timer.unref?.();
	};
}

/**
 * The newest pi-summarize activity line in a session file, reading only its last `max` bytes (a partial first or
 * last line is skipped). Undefined when there is none. Only these entries: never model text or thinking.
 */
export function latestActivity(file: string, max = 64 * 1024): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const size = fstatSync(fd).size;
		const len = Math.min(size, max);
		const buf = Buffer.alloc(len);
		readSync(fd, buf, 0, len, size - len);
		const lines = buf.toString("utf8").split("\n");
		if (len < size) lines.shift();
		for (let i = lines.length - 1; i >= 0; i--) {
			if (!lines[i]!.includes('"pi-summarize"')) continue;
			try {
				const e = JSON.parse(lines[i]!);
				const text = e.type === "custom" && e.customType === "pi-summarize" && e.data?.kind === "activity" ? e.data.text : undefined;
				const clean = typeof text === "string" ? text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim() : "";
				if (clean) return clean.length > 100 ? `${clean.slice(0, 99)}…` : clean;
			} catch {}
		}
	} catch {
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return undefined;
}
