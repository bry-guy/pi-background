# pi-background

Run pi sessions in the background on your machine, then pick them up with the normal `/resume` (or `/project`).

## Install

```sh
pi install npm:@bry-guy/pi-background
# or from git:
pi install git:github.com/bry-guy/pi-background
```

Install [pi-keepalive](https://github.com/bry-guy/pi-keepalive) too if you want the machine to stay awake during background turns.

## Use

- **Switch away while a turn is running** (`/resume`, `/new`, `/project`): the turn keeps going in the background. You see `Running "<session>" in background…`, and the footer shows `background: N running` (`N here, M elsewhere` when some belong to another project).
- **Go back to it** with `/resume`: you watch it live. A status says "watching · Esc stops it", messages you type are queued and picked up by the run, and Esc stops it. When the turn ends, it's a normal session again.
- **A background run that needs you waits for you.** When an extension asks something (a permission gate, `ask_user_question`, pi-sync's "take it over?"), the turn pauses. A pi open in the same project (or folder) gets a notice, `"<session>" is waiting on you: <question>`, and rings the terminal bell (tmux highlights the window); every open pi shows `, M waiting` in the footer. Answer it from wherever you are with `/bg`, or `/resume` the session and answer it there. Esc leaves it waiting. There is no timeout, and with pi-keepalive the machine may sleep while it waits.
- **What runs are doing.** Above the editor, one row per background run that is running or waiting and belongs here: to this session's pi project ([pi-projects](https://github.com/bry-guy/pi-projects)), or to its folder when it is in no project. Runs elsewhere are only counted in the footer, and their end is not announced here; `/bg list` shows all of them. Each row has its name, state (`starting`, `running`, `waiting on you`), elapsed time, and what it is doing now. With [pi-summarize](https://github.com/bry-guy/pi-summarize) in the run, that is its newest summary plus the tool running now, such as `Fixing the retention test (bash)`; otherwise `running <tool>`; nothing while the model is thinking before its first tool. When it doesn't fit beside the name it goes on a second line. pi's RPC mode does not forward the child's working message, so the summary comes from the session file, where pi-summarize writes it when a step ends: it describes the step before the current tool. An ended run shows its error or `last step: <activity>` on one line, clipped. Refreshed every 5 s. A run that ends stays listed with its final state (`done`, `error`, `stopped`, `stalled`, `died`) until your next prompt. At most 6 runs, then `+N more`.
- `/bg <message>`: send a message and leave in one step.
- `/bg`: answer what background runs are waiting on.
- `/bg list`, `/bg stop`: housekeeping.

Moving a turn mid-step restarts that step; the runner tells the model it was moved.

## How it works

- **Lock.** Every pi with this extension holds a lock (`<session>.jsonl.lock`, recording pid, host and role) on the session it has open. Pi core and pi-sync don't lock session files, so this is what stops two processes writing to one session. A lock left by a process that died is cleared by the next pi on the same machine; on macOS the machine is known by its Bonjour name, because the hostname changes with the network.
- **Runner.** Each background run is a detached `node src/runner.ts` process that drives `pi --mode rpc --session <file>` (the installed pi's own CLI). So the session loads exactly what your TUI loads (settings, extensions including pi's built-ins, packages, skills, AGENTS.md, enabledModels), and the runner uses only pi's public interfaces.
- **One turn per run.** The runner runs a single turn (plus any messages queued while you watch), then saves and exits.
- **Watching.** The runner streams events over `~/.pi/agent/background/<pid>.sock`; the TUI shows them under the transcript and reloads the session when the run ends. On SIGTERM it aborts the turn first, so the partial turn is saved.
- **Run records.** Runs are recorded in `~/.pi/agent/background/<pid>.json` (written to a temp file and renamed, so a reader never sees half a record), with a log next to each record.
- **Dialogs.** Extension dialogs (select, confirm, input, editor) arrive from pi's RPC mode and are forwarded over the socket and recorded in the run record (`waiting`); the first TUI to answer wins. Notifications are shown to watchers; other UI calls (widgets, status, custom components) do nothing. Messages you type while watching are confirmed by the run when it starts them; any it never took are sent from your TUI once the run ends.
- **Extensions can tell.** Extensions see `PI_BACKGROUND=1` inside a runner, and `hasUI=true` because their dialogs reach you.

## Stall guard

A run that makes no progress for 10 minutes is stopped and listed as `stalled`. The runner touches
`<agentDir>/background/<pid>.beat` on every event from pi (and every 30 s while it waits on you or a tool call is still running, so waiting or a
long quiet build isn't a stall; a single tool call counts as progress for at most 2 hours). A per-run [monit](https://mmonit.com/monit/) check (`brew install monit`) watches that file and sends SIGTERM
once it's 10 minutes old, SIGKILL at 13. monit runs as your own daemon with its own config in
`<agentDir>/background/monit/` and is started by the first run that needs it. Checks whose runner is gone (killed before it could clean up) are dropped when a pi with this extension starts and when a run starts. Without monit, runs have no stall guard
(logged).

## For other extensions

`globalThis[Symbol.for("pi-background.v1")]`:
- `start({ cwd, msg, env, name })` creates a new session in `cwd` (named `name`, if given), runs `msg` in it in the
  background with extra `env`, and returns `{ file, pid }`. pi-projects' `role_agent` uses it with `PI_ROLE`.
  The new session starts with the calling session's model and thinking level, not the configured defaults.
- `runs()` lists runs (`Run` in `src/registry.ts`).
- `stop(pid)` stops a live run like `/bg stop`; returns false when no live run has that pid.

## Limits

- A turn that's running can't move between processes. Moving or stopping one loses only the step that was in flight; the next turn starts with `continue`.
- Background runs stop on sleep or shutdown. pi-keepalive prevents idle sleep only.
- A plain `pi` without this extension ignores the lock. With it, a pi that opens a session another process is writing (e.g. `pi -c`) refuses to send until you `/resume` it.
- Projects whose project-local resources aren't trusted run without them; the runner can't show the trust prompt.
- Extensions' fully custom UI components (`ctx.ui.custom`) get no answer in a background run.
- pi-sync: background turns hold the conversation's lease and are pushed when they finish. With a current pi-sync, background sessions sync like foreground ones. If another device holds the lease, the run ends as an error.

## Test

```sh
npm test
```
