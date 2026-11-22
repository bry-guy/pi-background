import assert from "node:assert/strict";
import { test } from "node:test";
import type { Run } from "../src/registry.ts";
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

test("one line per run: name, state, elapsed, activity (else the last tool)", () => {
	const lines = widgetLines(
		[
			run(1, { name: "pi-web/pi-web-developer: fix DOM test" }),
			run(2, { tool: "bash" }),
			run(3, { waiting: [{ id: "a", method: "confirm", title: "Push?" }] }),
			run(4, { status: "waiting" }),
		],
		input(),
	);
	assert.deepEqual(lines, [
		"◇ pi-web/pi-web-developer: fix DOM test · running · 6m 20s · Checking why the DOM gate fails",
		"◇ Fix the flaky DOM test in · running · 6m 20s · bash…",
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
