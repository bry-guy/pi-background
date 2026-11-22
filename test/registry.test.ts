import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listRuns, type Run, writeRun } from "../src/registry.ts";
import { latestActivity } from "../src/widget.ts";

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
