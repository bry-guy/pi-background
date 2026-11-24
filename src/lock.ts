import { execFileSync } from "node:child_process";
import { linkSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";

/** Who has a session file open. Pi core and pi-sync don't lock session files, so every writer must honor this. */
export type Holder = { pid: number; host: string; role: "tui" | "bg"; startedAt: string };

export const lockPath = (file: string) => `${file}.lock`;

/** This machine's names, the one locks are written under first. A Mac with no fixed HostName reports a name that
 *  changes with the network ("Mac.home.arpa" at home, "mac.local" elsewhere), so a dead process's lock looked like
 *  another machine's and was never cleared. Its Bonjour name stays put. */
function hostNames(): string[] {
	const now = hostname();
	if (process.platform !== "darwin") return [now];
	try {
		const name = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		if (name) return [name, `${name}.local`, now]; // the last two: locks written before this fix
	} catch {}
	return [now];
}

// Read once: macOS can change os.hostname() mid-process, which would orphan our own lock.
const HOSTS = hostNames();

/** True if a lock recorded under `host` was taken on this machine. */
export const here = (host: string) => HOSTS.includes(host);

/** True if `h` is this process's own lock. */
export const mine = (h: Holder | undefined) => h?.pid === process.pid && here(h.host);

/** Linux /proc/<pid>/cmdline names node/pi in argv[0]. Not comm: Node names its main thread "MainThread". */
export const nodeCmdline = (cmdline: string) => /node|pi/i.test(basename(cmdline.split("\0")[0]!));

/** True if `pid` is running and is a node/pi process (a reused pid of another program counts as dead). */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
	}
	try {
		return nodeCmdline(readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch {}
	try {
		const comm = execFileSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
		return /node|pi/i.test(comm);
	} catch {
		return true; // ps missing or failed: trust kill(0)
	}
}

/** Current live holder, or undefined. A lock left by a dead process on this host is removed. */
export function holder(file: string): Holder | undefined {
	for (let i = 0; i < 3; i++) {
		let raw: string;
		let h: Holder;
		try {
			raw = readFileSync(lockPath(file), "utf8");
			h = JSON.parse(raw);
		} catch {
			return undefined;
		}
		if (!here(h.host) || alive(h.pid)) return h;
		reclaim(file, raw);
	}
	return undefined;
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Removes the lock only if it still holds `seen` (a dead holder's), under a short-lived `<lock>.reclaim` mutex:
 * two processes reclaiming at once would otherwise let the second delete the lock the first just took.
 */
export function reclaim(file: string, seen: string): void {
	const mutex = `${lockPath(file)}.reclaim`;
	const tmp = `${mutex}.${process.pid}`;
	writeFileSync(tmp, String(process.pid));
	try {
		for (let i = 0; i < 40; i++) {
			try {
				linkSync(tmp, mutex);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				// The mutex is held for a few syscalls; one older than 5s belongs to a process that died holding it.
				try {
					if (Date.now() - statSync(mutex).mtimeMs > 5000) unlinkSync(mutex);
				} catch {}
				sleep(5);
				continue;
			}
			try {
				if (readFileSync(lockPath(file), "utf8") === seen) unlinkSync(lockPath(file));
			} catch {
			} finally {
				unlinkSync(mutex);
			}
			return;
		}
	} finally {
		try {
			unlinkSync(tmp);
		} catch {}
	}
}

/** Take the lock, or report who holds it. Re-acquiring a lock this process already holds succeeds. */
export function acquire(file: string, role: Holder["role"]): { ok: true } | { ok: false; heldBy: Holder } {
	const me: Holder = { pid: process.pid, host: HOSTS[0]!, role, startedAt: new Date().toISOString() };
	const tmp = `${lockPath(file)}.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(me));
	try {
		for (let i = 0; i < 2; i++) {
			try {
				linkSync(tmp, lockPath(file)); // atomic and never exposes a half-written lock
				return { ok: true };
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
			const h = holder(file);
			if (mine(h)) return { ok: true };
			if (h) return { ok: false, heldBy: h };
		}
		const h = holder(file);
		return h ? { ok: false, heldBy: h } : { ok: false, heldBy: me };
	} finally {
		try {
			unlinkSync(tmp);
		} catch {}
	}
}

export function release(file: string): void {
	const h = holder(file);
	if (mine(h)) {
		try {
			unlinkSync(lockPath(file));
		} catch {}
	}
}

/** Poll until nobody holds the lock. Resolves false on timeout or abort. */
export async function waitFree(file: string, timeoutMs = Infinity, signal?: AbortSignal): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (holder(file)) {
		if (Date.now() > end || signal?.aborted) return false;
		await new Promise((r) => setTimeout(r, 300));
	}
	return true;
}
