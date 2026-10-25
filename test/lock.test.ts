import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquire, holder, lockPath, release, waitFree } from "../src/lock.ts";

const session = () => join(mkdtempSync(join(tmpdir(), "pibg-")), "s.jsonl");

test("acquire, re-acquire, release", () => {
	const f = session();
	assert.deepEqual(acquire(f, "tui"), { ok: true });
	assert.deepEqual(acquire(f, "tui"), { ok: true });
	assert.equal(holder(f)?.pid, process.pid);
	release(f);
	assert.equal(existsSync(lockPath(f)), false);
});

test("a dead holder's lock is reclaimed", () => {
	const f = session();
	writeFileSync(lockPath(f), JSON.stringify({ pid: 2 ** 22 - 1, host: hostname(), role: "bg", startedAt: "" }));
	assert.deepEqual(acquire(f, "tui"), { ok: true });
});

test("a live holder blocks; waitFree resolves when it exits", async () => {
	const f = session();
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},800)"]);
	writeFileSync(lockPath(f), JSON.stringify({ pid: child.pid, host: hostname(), role: "bg", startedAt: "" }));
	const r = acquire(f, "tui");
	assert.equal(r.ok, false);
	assert.equal(!r.ok && r.heldBy.pid, child.pid);
	assert.equal(await waitFree(f, 50), false);
	assert.equal(await waitFree(f, 5000), true);
});
