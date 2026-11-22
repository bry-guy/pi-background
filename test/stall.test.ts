import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pruneChecks } from "../src/stall.ts";

test("pruneChecks drops monit checks whose runner is gone and keeps live ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "pibg-stall-"));
	const checks = join(dir, "monit", "checks");
	mkdirSync(checks, { recursive: true });
	for (const pid of [process.pid, 2 ** 30]) writeFileSync(join(checks, `${pid}.monitrc`), "");
	assert.equal(pruneChecks(dir), 1);
	assert.deepEqual(readdirSync(checks), [`${process.pid}.monitrc`]);
	assert.equal(pruneChecks(join(dir, "nothing")), 0);
});
