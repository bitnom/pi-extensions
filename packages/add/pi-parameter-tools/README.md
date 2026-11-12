# pi-parameter-tools

Set the model and the thinking level of a pi session.

Four tools:

| Tool | What it changes |
|---|---|
| `set_own_thinking` | the calling agent's thinking/reasoning effort |
| `set_own_model` | the calling agent's provider/model |
| `set_session_thinking` | the thinking/reasoning effort of an explicitly identified pi session |
| `set_session_model` | the provider/model of an explicitly identified pi session |

The own tools act on the caller's own session, in the caller's own process, through pi's own
session-control methods (`pi.setModel`, `pi.setThinkingLevel`).

The session-targeted tools act on a session the caller **names**: a session id **and** one
unambiguous binding — a session file path, or a herdr lane. A session id alone is never
enough (ids can repeat across session files), and two bindings at once are a conflict, not
a preference.

## How a target session is reached

pi exposes a documented **RPC mode** (`pi --mode rpc`): JSONL commands on stdin/stdout,
including `get_state`, `set_model` and `set_thinking_level`. That is the supported way to
drive a session's parameters from outside that session's own process, so it is what this
package uses.

The order of operations for a session-targeted change:

1. **Shape** — exactly one of `sessionPath` / `lane`. Both is `identity_binding_conflict`,
   neither is `identity_binding_required`.
2. **Grammar** — the session id, the path and the lane must look like what they claim to
   be, or the request is `invalid_identifier`.
3. **Resolution** — a lane is resolved to a session file with one herdr query
   (`herdr agent get <lane>`). A lane that is not a pi lane, is unknown, is ambiguous, or
   that herdr cannot answer for, is refused with its own code.
4. **Identity** — the target is opened and asked which session it is. A target that
   answers with a different session id (`session_id_mismatch`) or a different file
   (`session_identity_mismatch`) is refused **before anything is changed**.
5. **The change** — pi's own setter runs, in the target's own process.
6. **The report** — the before and after state, the records the target gained, and
   whether the change landed.

A target that is the caller's own session (same id **and** same file) is changed in the
caller's own process, over the ExtensionAPI, with no second process at all.

## What the result says

Every call returns the same envelope, whether it changed something or refused:

```jsonc
{
  "ok": true,
  "tool": "set_session_thinking",
  "target": {
    "kind": "session",
    "sessionId": "…", "sessionPath": "…",
    "requested": { "sessionId": "…", "sessionPath": "…" },
    "resolution": { "source": "session_file" }
  },
  "model":    { "before": {…}, "requested": null, "after": {…} },
  "thinking": { "before": "off", "requested": "high", "after": "high", "supported": ["off","low","medium","high"] },
  "applied": "thinking",        // model | thinking | both | none | unknown
  "changed": true,
  "records": { "modelChangeEntryId": null, "thinkingLevelEntryId": "a1b2c3d4" },
  "disk": { "state": "unknown" },
  "effective": "next_request",
  "partial": false,
  "warnings": ["…"]
}
```

**Records, disk and durability are three different things.** `records` is the id of the
session entry pi wrote (observed, or null when no entry was seen). `disk.state` is
`unknown` or `not_applicable` and is never `written`: an extension cannot prove that a
session file reached the disk. **Durability is never claimed.** A change takes effect on
the **next request**, not in the middle of the current one.

`applied` is a comparison of the values before and after the attempt, never a count of
records. `partial` is true when the memory changed but the expected record was not seen.

## Refusal codes

`invalid_identifier`, `invalid_level`, `level_unsupported`, `no_model_selected`,
`model_unknown`, `auth_missing`, `identity_binding_required`, `identity_binding_conflict`,
`no_session_file`, `session_id_mismatch`, `session_identity_mismatch`,
`target_not_reachable`, `target_session_unresolvable`, `target_lane_unknown`,
`target_not_pi`, `target_ambiguous`, `lane_targets_other_session`, `herdr_absent`,
`herdr_not_managed`, `herdr_unavailable`, `herdr_api_failure`, `apply_failed`,
`partial_apply`.

## What this package does not do

* **No pty, no keystrokes, no slash-command relay.** A target is never driven by typing
  into its terminal.
* **No hand-written session files.** The records are created by pi's own setter, inside a
  pi process. This package never appends to a session file itself.
* **No settings edits, no restarts, no relaunch commands.** The tool changes the
  parameter; it does not change the process.
* **No mailbox, no daemon, no watcher, no timer.** Every call is one operation.
* **No provider calls.** Setting a model is not a completion; nothing here talks to a
  provider beyond the local credential check pi itself performs.

## Known limitations

* **A live lane's running process keeps its current parameters.** The change is written to
  the target session (and its session file, when pi persists it), but a pi process that is
  already running with that session keeps the parameters it started with until it
  resumes. The result carries this as a warning rather than claiming more.
* **The map of lanes is only as fresh as herdr.** A lane binding resolves through
  `herdr agent get`; a lane that has just been renamed may not resolve.
* **Handler errors are not observable.** pi routes a throwing `model_select` or
  `thinking_level_select` handler to a host-only channel; the ExtensionAPI exposes no
  subscription for it. A successful change is reported as successful.
* **Durability is not proven**, only observed as a session record.

## Tests

```bash
npm run check        # typecheck + lint + tests
bun test             # the tests alone
```

The unit tests drive injected collaborators — no process, no provider, no network. The
integration test opens **two disposable pi sessions** in a temporary directory and checks
the property that matters: a change aimed at one session changes that session and leaves
the other one's state and file untouched, in both directions.

## Install

```bash
pi -e npm:@arhen/pi-add-parameter-tools      # try it
pi install npm:@arhen/pi-add-parameter-tools  # keep it
```

## License

MIT
