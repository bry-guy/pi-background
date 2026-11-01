import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquire, holder, lockPath, reclaim, release, waitFree } from "../src/lock.ts";

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
	await new Promise((r) => setTimeout(r, 100));
	writeFileSync(lockPath(f), JSON.stringify({ pid: child.pid, host: hostname(), role: "bg", startedAt: "" }));
	const r = acquire(f, "tui");
	assert.equal(r.ok, false);
	assert.equal(!r.ok && r.heldBy.pid, child.pid);
	assert.equal(await waitFree(f, 50), false);
	assert.equal(await waitFree(f, 5000), true);
});

test("a live pid that isn't node/pi doesn't hold the lock", () => {
	const f = session();
	const child = spawn("sleep", ["5"]);
	writeFileSync(lockPath(f), JSON.stringify({ pid: child.pid, host: hostname(), role: "bg", startedAt: "" }));
	assert.deepEqual(acquire(f, "tui"), { ok: true });
	child.kill();
});

test("reclaiming a dead holder's lock never removes a lock someone took meanwhile", () => {
	const f = session();
	const dead = JSON.stringify({ pid: 2 ** 22 - 1, host: hostname(), role: "bg", startedAt: "" });
	writeFileSync(lockPath(f), dead);
	// Another process reclaimed it first and took the lock; this one acts on what it read before.
	writeFileSync(lockPath(f), JSON.stringify({ pid: process.pid, host: hostname(), role: "tui", startedAt: "" }));
	reclaim(f, dead);
	assert.equal(holder(f)?.pid, process.pid);
	writeFileSync(lockPath(f), dead);
	reclaim(f, dead);
	assert.equal(existsSync(lockPath(f)), false);
	assert.equal(existsSync(`${lockPath(f)}.reclaim`), false);
});

test("a reclaim mutex left by a crashed process is cleared after 5s", () => {
	const f = session();
	const dead = JSON.stringify({ pid: 2 ** 22 - 1, host: hostname(), role: "bg", startedAt: "" });
	writeFileSync(lockPath(f), dead);
	writeFileSync(`${lockPath(f)}.reclaim`, "1");
	utimesSync(`${lockPath(f)}.reclaim`, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
	assert.deepEqual(acquire(f, "tui"), { ok: true });
});
