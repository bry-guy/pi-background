import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	status: "waiting" | "running" | "done" | "error" | "stopped" | "died";
	endedAt?: string;
	error?: string;
	/** Unix socket watchers connect to while the run is live. */
	sock?: string;
	/** Questions an extension asked that wait for an answer from a TUI; the turn is paused on them. */
	waiting?: Ask[];
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
	writeFileSync(join(dir, `${run.pid}.json`), JSON.stringify(run, null, 2));
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
