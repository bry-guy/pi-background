import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activityTracker, latestActivity, listRuns, nowDoing, type Run, writeRun } from "../src/registry.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pibg-reg-"));
const activity = (text: string) => JSON.stringify({ type: "custom", customType: "pi-summarize", data: { kind: "activity", text, at: 1 } });
const message = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

test("writeRun replaces the record atomically and leaves no temp file", () => {
	const d = dir();
	const run: Run = { pid: process.pid, file: "/f", name: "n", msg: "m", log: "", startedAt: new Date().toISOString(), status: "running" };
	writeRun(d, run);
	writeRun(d, { ...run, name: "renamed" });
	assert.deepEqual(readdirSync(d), [`${process.pid}.json`]);
	assert.equal(listRuns(d)[0]!.name, "renamed");
});

test("latestActivity: newest activity entry, never assistant text", () => {
	const f = join(dir(), "s.jsonl");
	writeFileSync(f, [activity("Reading the docs"), activity("Fixing the test"), message("secret plan"), ""].join("\n"));
	assert.equal(latestActivity(f), "Fixing the test");
});

test("latestActivity tolerates a truncated last line and a cut first line", () => {
	const f = join(dir(), "s.jsonl");
	writeFileSync(f, `${"x".repeat(500)}\n${activity("Running the e2e suite")}\n${activity("Half written").slice(0, 60)}`);
	assert.equal(latestActivity(f), "Running the e2e suite");
	assert.equal(latestActivity(f, 80), undefined); // only the cut-off tail fits
});

test("latestActivity: none, or no file", () => {
	const f = join(dir(), "s.jsonl");
	writeFileSync(f, `${message("hi")}\n`);
	assert.equal(latestActivity(f), undefined);
	assert.equal(latestActivity(join(dir(), "missing.jsonl")), undefined);
});

test("activityTracker: changes save at most once per interval, the last one always lands", async () => {
	const run: Run = { pid: 1, file: "/f", name: "n", msg: "m", log: "", startedAt: "", status: "running", activity: null };
	const saved: (string | null | undefined)[] = [];
	const set = activityTracker(run, () => saved.push(run.activity), 50);
	set("running bash");
	set("running read");
	set("running read"); // unchanged: nothing to do
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(saved, ["running read"]);
	assert.ok(run.activityAt! > 0);
	set("running edit");
	set(null); // turn ended
	await new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(saved, ["running read"]); // throttled
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(saved, ["running read", null]);
});

test("nowDoing: the step's summary with the tool, or just the tool before any summary exists", () => {
	assert.equal(nowDoing("Fixing the test", "bash"), "Fixing the test (bash)");
	assert.equal(nowDoing(undefined, "bash"), "running bash");
});
