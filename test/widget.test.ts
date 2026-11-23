import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run } from "../src/registry.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { elapsed, widgetLines } from "../src/widget.ts";

const T0 = Date.parse("2026-11-22T10:00:00Z");
const run = (pid: number, extra: Partial<Run> = {}): Run => ({
	pid,
	file: `/s/${pid}.jsonl`,
	name: `x_${pid}.jsonl`,
	msg: "Fix the flaky DOM test in pi-web and open a PR",
	log: "",
	startedAt: new Date(T0).toISOString(),
	status: "running",
	...extra,
});
const input = (o: Partial<Parameters<typeof widgetLines>[1]> = {}) => ({
	now: T0 + 380_000,
	since: T0,
	endedAt: (r: Run) => (r.endedAt ? Date.parse(r.endedAt) : 0),
	activity: (f: string) => (f === "/s/1.jsonl" ? "Checking why the DOM gate fails" : undefined),
	...o,
});

test("elapsed", () => {
	assert.equal(elapsed(42_000), "42s");
	assert.equal(elapsed(380_000), "6m 20s");
	assert.equal(elapsed(3_900_000), "1h 05m");
});

test("one line per run: name, state, elapsed, activity", () => {
	const lines = widgetLines(
		[
			run(1, { name: "pi-web/pi-web-developer: fix DOM test", activity: "running bash" }),
			run(2),
			run(3, { waiting: [{ id: "a", method: "confirm", title: "Push?" }] }),
			run(4, { status: "waiting" }),
		],
		input({ width: 120 }),
	);
	assert.deepEqual(lines, [
		"◇ pi-web/pi-web-developer: fix DOM test · running · 6m 20s · running bash",
		"◇ Fix the flaky DOM test in · running · 6m 20s",
		"◇ Fix the flaky DOM test in · waiting on you · 6m 20s",
		"◇ Fix the flaky DOM test in · starting · 6m 20s",
	]);
});

test("an ended run stays with its final state until the next prompt", () => {
	const done = run(1, { status: "error", error: "boom", endedAt: new Date(T0 + 60_000).toISOString() });
	assert.deepEqual(widgetLines([done], input()), ["◇ Fix the flaky DOM test in · error · 1m 00s · boom"]);
	assert.equal(widgetLines([done], input({ since: T0 + 120_000 })), undefined);
	const died = run(2, { status: "died" });
	assert.equal(widgetLines([died], input()), undefined); // dead before this pi started (endedAt 0)
	assert.match(widgetLines([died], input({ endedAt: () => T0 + 5_000 }))![0]!, /· died · 5s$/);
});

test("no runs, no widget; more than six collapse", () => {
	assert.equal(widgetLines([], input()), undefined);
	const lines = widgetLines([1, 2, 3, 4, 5, 6, 7, 8].map((p) => run(p)), input())!;
	assert.equal(lines.length, 7);
	assert.equal(lines[6], "  +2 more");
});

test("rows never wrap: pi pads widget lines, so a row fits columns - 2; a live step that doesn't fit gets its own line", () => {
	const r = run(1, { name: "pi-web/pi-web-developer: fix DOM test", activity: "Checking why the DOM gate fails (bash)" });
	assert.deepEqual(widgetLines([r], input({ width: 72 })), [
		"◇ pi-web/pi-web-developer: fix DOM test · running · 6m 20s",
		"  Checking why the DOM gate fails (bash)",
	]);
	assert.equal(widgetLines([r], input({ width: 42 }))![0]!.length, 40);
	assert.deepEqual(widgetLines([r], input({ width: 42 }))![1], "  Checking why the DOM gate fails (bash)");
	// Unknown width: 80. A step longer than the row is clipped on its own line.
	assert.deepEqual(widgetLines([{ ...r, activity: "x".repeat(200) }], input())!.map((l) => l.length), [58, 78]);
	// Wide characters count as two columns.
	for (const line of widgetLines([{ ...r, activity: "日本語".repeat(30) }], input())!) assert.ok(visibleWidth(line) <= 78, `${visibleWidth(line)}`);
	// An ended row stays one line: its error or last step is clipped.
	const done = run(2, { status: "error", error: "x".repeat(200), endedAt: new Date(T0 + 60_000).toISOString() });
	assert.deepEqual(widgetLines([done], input())!.map((l) => l.length), [78]);
});

test("a running row shows the record's activity, never a session breadcrumb; an ended row shows its last step", () => {
	const o = input({ activity: () => "Checking why the DOM gate fails" });
	assert.equal(widgetLines([run(1)], o)![0], "◇ Fix the flaky DOM test in · running · 6m 20s");
	assert.equal(widgetLines([run(1, { activity: null })], o)![0], "◇ Fix the flaky DOM test in · running · 6m 20s");
	const done = run(1, { status: "done", endedAt: new Date(T0 + 60_000).toISOString() });
	assert.equal(widgetLines([done], o)![0], "◇ Fix the flaky DOM test in · done · 1m 00s · last step: Checking why the DOM…");
});
