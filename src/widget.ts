// The "background runs" widget: one line per run that is running, waiting on you, or ended since the last prompt.
// Pure, so tests can load it without pi.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Run } from "./registry.ts";

export const MAX_ROWS = 6;
const live = (r: Run) => r.status === "running" || r.status === "waiting";

/** 42s, 6m 20s, 1h 05m. */
export function elapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Session name, else the first words of its first message (an unnamed run's name is its file name). */
export const runTitle = (r: Run) => clip(r.name && !r.name.endsWith(".jsonl") ? r.name : r.msg.split(/\s+/).slice(0, 6).join(" "), 40);

export function runState(r: Run): string {
	if (!live(r)) return r.status;
	return r.waiting?.length ? "waiting on you" : r.status === "waiting" ? "starting" : "running";
}

export interface WidgetInput {
	now: number;
	/** When the user last prompted: runs that ended before then are no longer listed. */
	since: number;
	/** When an ended run ended (a "died" run has no endedAt in its record). */
	endedAt(r: Run): number;
	/** Latest activity line of a session file. */
	activity(file: string): string | undefined;
	/** Terminal columns (80 when unknown); a row never wraps. */
	width?: number;
}

/** A run's row without the 2-column marker, at most `width` columns: the activity or error is clipped first. */
export function runLine(r: Run, o: WidgetInput, width = 78): string {
	const start = Date.parse(r.startedAt);
	const head = [runTitle(r), runState(r), elapsed((live(r) ? o.now : o.endedAt(r)) - start)].join(" · ");
	const what = live(r) ? o.activity(r.file) : r.error;
	const room = width - head.length - 3;
	return clip(what && room >= 2 ? `${head} · ${clip(what, room)}` : head, width);
}

/** Lines for the widget, or undefined when there is nothing to show. */
export function widgetLines(runs: Run[], o: WidgetInput): string[] | undefined {
	const shown = runs.filter((r) => live(r) || o.endedAt(r) > o.since);
	if (!shown.length) return undefined;
	const lines = shown.slice(0, MAX_ROWS).map((r) => `◇ ${runLine(r, o, (o.width || 80) - 2)}`);
	if (shown.length > MAX_ROWS) lines.push(`  +${shown.length - MAX_ROWS} more`);
	return lines;
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
