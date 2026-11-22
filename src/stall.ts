// Stall guard for background runs: the runner writes a heartbeat file whenever pi emits an RPC event (and while a
// run waits on you, so waiting isn't a stall), and a per-run monit check stops the run once the heartbeat is
// 10 minutes old. monit runs as Bryan's own daemon with its own config in <agentDir>/background/monit.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive } from "./lock.ts";

export const STALL_MS = 10 * 60_000;

export function heartbeat(dir: string, pid: number) {
	const file = join(dir, `${pid}.beat`);
	let last = 0;
	const beat = (force = false) => {
		const now = Date.now();
		if (!force && now - last < 15_000) return;
		last = now;
		try {
			if (existsSync(file)) utimesSync(file, now / 1000, now / 1000);
			else writeFileSync(file, "");
		} catch {}
	};
	beat(true);
	return {
		file,
		beat,
		age: () => {
			try {
				return Date.now() - statSync(file).mtimeMs;
			} catch {
				return 0;
			}
		},
		remove: () => rmSync(file, { force: true }),
	};
}

function monitBin(): string | undefined {
	for (const b of ["/opt/homebrew/bin/monit", "/usr/local/bin/monit", "/usr/bin/monit"]) if (existsSync(b)) return b;
	return undefined;
}

/** `monit reload` exits 0 even with no daemon, so start one when its pid isn't alive (unless only cleaning up). */
function reload(monit: string, root: string, log: (...a: unknown[]) => void, start = true) {
	let running = false;
	try {
		process.kill(Number(readFileSync(join(root, "monit.pid"), "utf8")), 0);
		running = true;
	} catch {}
	if (!running && !start) return;
	try {
		execFileSync(monit, running ? ["-c", join(root, "monitrc"), "reload"] : ["-c", join(root, "monitrc")], { stdio: "ignore", timeout: 10_000 });
	} catch (e) {
		log("monit failed", (e as Error).message);
	}
}

/**
 * Drops checks whose runner is gone. A runner that never reaches its cleanup (SIGKILL, including monit's own at 13
 * minutes, a crash, a reboot) leaves its check behind, and monit then logs the missing heartbeat every 30 s forever.
 */
export function pruneChecks(dir: string, log: (...a: unknown[]) => void = () => {}): number {
	const root = join(dir, "monit");
	let names: string[];
	try {
		names = readdirSync(join(root, "checks"));
	} catch {
		return 0;
	}
	const dead = names.filter((n) => /^\d+\.monitrc$/.test(n) && !alive(Number.parseInt(n, 10)));
	for (const n of dead) rmSync(join(root, "checks", n), { force: true });
	const monit = monitBin();
	if (dead.length && monit && existsSync(join(root, "monitrc"))) reload(monit, root, log, false);
	return dead.length;
}

/** Registers the per-run monit check. Returns a cleanup, or undefined when monit isn't installed. */
export function watchWithMonit(dir: string, pid: number, beatFile: string, log: (...a: unknown[]) => void): (() => void) | undefined {
	const monit = monitBin();
	if (!monit) {
		log("monit not installed: no stall guard for this run");
		return undefined;
	}
	const root = join(dir, "monit");
	const checks = join(root, "checks");
	mkdirSync(checks, { recursive: true });
	pruneChecks(dir, log);
	writeFileSync(
		join(root, "monitrc"),
		[
			"set daemon 30",
			`set log ${join(root, "monit.log")}`,
			`set pidfile ${join(root, "monit.pid")}`,
			`set statefile ${join(root, "monit.state")}`,
			`set idfile ${join(root, "monit.id")}`,
			`set httpd unixsocket ${join(root, "monit.sock")}`,
			"  allow localhost",
			`include ${checks}/*.monitrc`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	const check = join(checks, `${pid}.monitrc`);
	const mins = STALL_MS / 60_000;
	writeFileSync(
		check,
		[
			`check file pi-bg-${pid} with path ${beatFile}`,
			`  if modify timestamp > ${mins} minutes then exec "/bin/kill -TERM ${pid}"`,
			`  if modify timestamp > ${mins + 3} minutes then exec "/bin/kill -KILL ${pid}"`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	reload(monit, root, log);
	log("monit watching", beatFile);
	return () => {
		rmSync(check, { force: true });
		reload(monit, root, log);
	};
}
