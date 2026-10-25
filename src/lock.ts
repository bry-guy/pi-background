import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

/** Who has a session file open. Pi core and pi-sync don't lock session files, so every writer must honor this. */
export type Holder = { pid: number; host: string; role: "tui" | "bg"; startedAt: string };

export const lockPath = (file: string) => `${file}.lock`;

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Current live holder, or undefined. A lock left by a dead process on this host is removed. */
export function holder(file: string): Holder | undefined {
	let h: Holder;
	try {
		h = JSON.parse(readFileSync(lockPath(file), "utf8"));
	} catch {
		return undefined;
	}
	if (h.host === hostname() && !alive(h.pid)) {
		// shortcut: check-then-unlink can race with a second reclaimer; fine for one user's local processes.
		try {
			unlinkSync(lockPath(file));
		} catch {}
		return undefined;
	}
	return h;
}

/** Take the lock, or report who holds it. Re-acquiring a lock this process already holds succeeds. */
export function acquire(file: string, role: Holder["role"]): { ok: true } | { ok: false; heldBy: Holder } {
	const me: Holder = { pid: process.pid, host: hostname(), role, startedAt: new Date().toISOString() };
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
			if (h?.pid === process.pid && h.host === me.host) return { ok: true };
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
	if (h?.pid === process.pid && h.host === hostname()) {
		try {
			unlinkSync(lockPath(file));
		} catch {}
	}
}

/** Poll until nobody holds the lock. Resolves false on timeout. */
export async function waitFree(file: string, timeoutMs: number): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (holder(file)) {
		if (Date.now() > end) return false;
		await new Promise((r) => setTimeout(r, 300));
	}
	return true;
}
