// The "background runs" widget: one line per run that is running, waiting on you, or ended since the last prompt.
// Pure, so tests can load it without pi.
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
}

export function runLine(r: Run, o: WidgetInput): string {
	const start = Date.parse(r.startedAt);
	const parts = [runTitle(r), runState(r), elapsed((live(r) ? o.now : o.endedAt(r)) - start)];
	if (live(r)) {
		const what = o.activity(r.file) ?? (r.tool ? `${r.tool}…` : undefined);
		if (what) parts.push(what);
	} else if (r.error) parts.push(clip(r.error, 80));
	return parts.join(" · ");
}

/** Lines for the widget, or undefined when there is nothing to show. */
export function widgetLines(runs: Run[], o: WidgetInput): string[] | undefined {
	const shown = runs.filter((r) => live(r) || o.endedAt(r) > o.since);
	if (!shown.length) return undefined;
	const lines = shown.slice(0, MAX_ROWS).map((r) => `◇ ${runLine(r, o)}`);
	if (shown.length > MAX_ROWS) lines.push(`  +${shown.length - MAX_ROWS} more`);
	return lines;
}
