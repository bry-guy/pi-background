# pi-background

Run pi sessions in the background on your machine, then pick them up with the normal `/resume` (or `/project`).

## Install

```sh
pi install git:github.com/bry-guy/pi-background
```

Install [pi-keepalive](https://github.com/bry-guy/pi-keepalive) too if you want the machine to stay awake during background turns.

## Use

- `/bg <message>`: run `<message>` in this session in the background. You're moved to a new session right away.
- `/bg`: continue an interrupted turn in the background (sends `continue`).
- `/bg list`: list background runs from the last day and their status.
- `/bg stop`: stop a running background turn. The partial turn is saved.
- **Switching away while a turn is running** asks whether to move it to the background, abort it, or cancel.
- **Resuming a session that's running in the background** asks whether to wait for its turn to end, stop it and continue here, or cancel.

The footer shows `bg: N running`. You get a notification when a run finishes.

## How it works

- **Lock.** Every pi with this extension holds a lock (`<session>.jsonl.lock`, recording pid, host and role) on the session it has open. Pi core and pi-sync don't lock session files, so this is what stops two processes writing to one session.
- **Runner.** Each background run is a detached `node src/runner.ts` process. It builds the session the way pi's CLI does (`createAgentSessionServices` and `createAgentSessionFromServices` from the installed pi), so it loads the same settings, extensions, packages, skills and AGENTS.md as your TUI.
- **One turn per run.** The runner runs a single turn, then saves and exits. On SIGTERM it aborts the turn first, so the partial turn is saved.
- **Run records.** Runs are recorded in `~/.pi/agent/background/<pid>.json`, with a log next to each record.
- **Extensions can tell.** Extensions see `PI_BACKGROUND=1` and `hasUI=false` inside a runner.

## Limits

- A turn that's running can't move between processes. Moving or stopping one loses only the step that was in flight; the next turn starts with `continue`.
- Background runs stop on sleep or shutdown. pi-keepalive prevents idle sleep only.
- A plain `pi` without this extension ignores the lock. With it, a pi that opens a session another process is writing (e.g. `pi -c`) refuses to send until you `/resume` it.
- "Wait for its turn to end" can't be cancelled; it gives up after 30 minutes.
- Projects whose project-local resources aren't trusted run without them; the runner can't show the trust prompt.
- pi-sync: background turns are pushed (tested), but pi-sync never auto-enrolls a session from a background run (it needs `hasUI`). A session that's already synced works. pi-sync could still drop a prompt silently if another process holds the lease; that case isn't tested.

## Test

```sh
npm test
```
