// The "background runs" widget: one row per run that is running, waiting on you, or ended since the last prompt.
// Pure, so tests can load it without pi.
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
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

/** At most n terminal columns (wide characters count as two). */
const clip = (t: string, n: number) => (visibleWidth(t) > n ? `${sliceByColumn(t, 0, n - 1, true)}…` : t);

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
	/** Latest pi-summarize line of a session file: written when a step ends, so shown only for ended runs. */
	activity(file: string): string | undefined;
	/** Terminal columns (80 when unknown); a row never wraps. */
	width?: number;
}

/** A run's row without its marker, at most `width` columns: the activity or error is clipped first. */
export function runLine(r: Run, o: WidgetInput, width = 76): string {
	const start = Date.parse(r.startedAt);
	const head = [runTitle(r), runState(r), elapsed((live(r) ? o.now : o.endedAt(r)) - start)].join(" · ");
	const last = live(r) ? undefined : o.activity(r.file);
	const what = live(r) ? r.activity : (r.error ?? (last && `last step: ${last}`));
	const room = width - visibleWidth(head) - 3;
	return clip(what && room >= 2 ? `${head} · ${clip(what, room)}` : head, width);
}

/** The footer: live runs of this session's project or folder, those elsewhere, and how many wait on the user. */
export function statusText(here: number, elsewhere: number, waiting: number): string | undefined {
	if (!here && !elsewhere) return undefined;
	const n = elsewhere ? [here ? `${here} here` : "", `${elsewhere} elsewhere`].filter(Boolean).join(", ") : `${here} running`;
	return `background: ${n}${waiting ? `, ${waiting} waiting` : ""}`;
}

/** Lines for the widget, or undefined when there is nothing to show. */
export function widgetLines(runs: Run[], o: WidgetInput): string[] | undefined {
	const shown = runs.filter((r) => live(r) || o.endedAt(r) > o.since);
	if (!shown.length) return undefined;
	// pi pads a widget line by one column each side, and the marker takes two.
	const width = (o.width || 80) - 4;
	const lines = shown.slice(0, MAX_ROWS).flatMap((r) => {
		const now = live(r) && r.activity;
		// A live run's step rarely fits beside its name: it gets its own line rather than being cut to a few words.
		if (now && visibleWidth(runLine(r, o, Infinity)) > width) return [`◇ ${runLine({ ...r, activity: null }, o, width)}`, `  ${clip(now, width)}`];
		return [`◇ ${runLine(r, o, width)}`];
	});
	if (shown.length > MAX_ROWS) lines.push(`  +${shown.length - MAX_ROWS} more`);
	return lines;
}
