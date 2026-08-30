# opencode-codemaxxing

An [opencode](https://opencode.ai) plugin that **refuses to stop improving your project**. After every assistant response it autonomously analyzes the codebase, injects a fresh, targeted improvement prompt, and repeats — pumping in a continuous stream of self-generated prompts until a configurable **token budget**, **round cap**, or **stability signal** stops it.

> **⚠️ Heads-up:** This is an *autonomous, unbounded-improvement* agent. It makes real file edits by itself. Run it on a branch you're prepared to review, or back up first.

## How it works

1. Listens for the `session.idle` event (fires whenever the assistant finishes a response).
2. Verifies the idle session belongs to the current project (won't hijack other tabs).
3. Reads the conversation to sum token usage (`AssistantMessage.tokens.input + output`).
4. Checks the project's changed files to detect if the previous round produced work.
5. Injects a crafted improvement prompt back into the session via `client.session.prompt()`.
6. Repeats until `maxTokens`, `maxRounds`, the model's own context limit, or (optionally) a stable round stops it.

The injected prompt tells the model to *actually make edits* this round — inspect the code, pick one bounded improvement, implement it, verify it, and report — rather than just describing what could be done.

## Installation

### Option A — npm package

```bash
npm install opencode-codemaxxing
```

Then add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["opencode-codemaxxing", { "maxTokens": 1000000, "maxRounds": 40 }]
  ]
}
```

### Option B — local copy

Place the built output in your plugin directory (or reference the file directly):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./path/to/codemaxxing/dist/index.js", { "enabled": true }]
  ]
}
```

Restart opencode after changing config — plugins load at startup.

## Configuration

All options are optional. Pass them as the second element of the plugin tuple.

| Option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master switch for the whole loop. |
| `maxTokens` | `number` | `500000` | Cumulative token budget (input + output) for the autonomous run. The loop stops once exceeded. |
| `maxRounds` | `number` | `25` | Max autonomous improvement rounds per session. Use `Infinity` for an effectively endless loop. |
| `focus` | `string` | `"correctness, quality, performance"` | Comma-separated improvement domains fed into each prompt (e.g. `"performance, types, tests, security"`). |
| `keepGoingWhenStable` | `boolean` | `true` | Keep looping even when a round produced no file changes. Set `false` to stop as soon as a round is static. |
| `delayMs` | `number` | `2500` | Pause between the end of one round and the next injected prompt. |
| `skipOnError` | `boolean` | `true` | Skip a round if the last assistant message errored (avoid pushing on top of a broken provider response). |
| `paths` | `string[]` | `[]` | Restrict improvements to these project-relative paths. Empty = whole project. |
| `promptTemplate` | `string` | `""` | Custom prompt. `{{ROUND}}` and `{{FOCUS}}` are substituted. Blank uses the built-in prompt. |
| `stateFile` | `string` | `".codemaxxing.json"` | File used to persist the token budget across restarts/sessions. Set to `""` for memory-only. |
| `respectModelLimit` | `boolean` | `true` | Back off (stop injecting rounds) once the session has used most of the model's context window, so codemaxxing never starves your real conversation. Set `false` to ignore the model's context limit and rely on `maxTokens` alone. |
| `contextHeadroom` | `number` | `0.2` | Fraction of the model's context window to leave untouched when `respectModelLimit` is on. `0.2` keeps the last 20% free. |

### Example tuning

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-codemaxxing",
      {
        "maxTokens": 1000000,
        "maxRounds": 60,
        "focus": "performance, error-handling, tests",
        "keepGoingWhenStable": false,
        "delayMs": 1000,
        "paths": ["src"]
      }
    ]
  ]
}
```

## Notes & safety

- **Token accounting** is exact where possible: it sums `tokens.input + tokens.output` from every assistant message, plus whatever was persisted in `stateFile` from a prior run.
- **Token-limit backoff ("not use it")**: by default (`respectModelLimit: true`) the plugin reads the session's model context window via the `chat.params` hook and stops injecting rounds once the session has consumed everything but `contextHeadroom` of it. That's the "don't use it past the token limit" behavior — flip `respectModelLimit: false` to disable this guard and only honor your own `maxTokens`.
- **Persistence**: budget state is written to `.codemaxxing.json` (in the project root by default) so totals survive a restart. Delete the file to reset, or set `stateFile: ""` to skip persistence.
- **Stable detection**: if the previous round changed zero files, the next prompt explicitly nudges the model toward concrete action rather than fabrication, and (if `keepGoingWhenStable` is off) the loop stops.
- The current implementation does **not** rotate focus between rounds — it keeps the configured focus each time. Future work: weight focus by what actually changed.

## Development

```bash
npm install
npm run build   # compiles src/index.ts -> dist/
npm run typecheck
```

## License

MIT
