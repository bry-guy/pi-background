import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { newSessionFile } from "../src/extension.ts";

const dir = () => mkdtempSync(join(tmpdir(), "pibg-start-"));

test("a named session file carries a session_info entry pi reads back", () => {
	const file = newSessionFile(tmpdir(), "pi-web-developer: do a thing", dir());
	const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines[0].type, "session");
	assert.equal(lines[1].type, "session_info");
	assert.equal(SessionManager.open(file).getSessionName(), "pi-web-developer: do a thing");
});

test("an unnamed session file holds only the header", () => {
	const file = newSessionFile(tmpdir(), undefined, dir());
	assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
	assert.equal(SessionManager.open(file).getSessionName(), undefined);
});
