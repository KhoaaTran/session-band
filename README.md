# session-band

English · [Tiếng Việt](README.vi.md)

A Claude Code mod in two parts, with a status line to go with it:

- **The band**, always above the prompt: turn, time left on the prompt cache, output speed, context, and the 5h and weekly limits.
- **The activity pane**, opened from `☰` beside Context: each prompt, the requests it sent to the model, their tool calls and subagents, and the shells still running in the background.
- **The status line** (`statusline.js`) under the prompt: model and effort, folder, session title. It also hands the band the figures the mod API lacks.

![session-band in Claude Code: the band and status line on the left, the activity pane docked on the right](docs/preview.png)

<sub>An illustration of what the mod draws, not a screenshot: your terminal's font and widths apply.</sub>

## Install

Needs a Claude Code with mods (on by default from 2.1.287; written against 2.1.310). Works on macOS, Linux and Windows.

### One line

The band and the activity pane, at the prompt of a terminal session:

```text
/plugin install session-band --marketplace KhoaaTran/session-band
```

Answer `y` to add the marketplace, then pick a scope (the user scope is first). From a shell: `claude plugin install session-band --marketplace KhoaaTran/session-band`. In the desktop app: + next to the prompt box, Plugins, Add marketplace with `KhoaaTran/session-band`, then Add plugin.

The status line, the hour-long prompt cache and the pane's shortcut are not part of a plugin: for them, install with the prompt below instead, which also needs Node.js and git.

### One prompt

Open Claude Code in any folder and paste this prompt as it is:

```text
Install the session-band mod for Claude Code on this machine, step by step:

1. Clone https://github.com/KhoaaTran/session-band.git into ~/.claude/mods/session-band. If that folder already holds this repo, run git pull instead.
2. Run node --version. If Node.js is missing, stop and tell me.
3. Merge into ~/.claude/settings.json, keeping everything already there (create the file if it is missing). Paths are this machine's absolute paths, with / even on Windows:
   - env.CLAUDE_CODE_PLUGIN_DIRS = the mod's folder. If the variable already holds another value, ask me before changing it.
   - env.ENABLE_PROMPT_CACHING_1H = "1"
   - statusLine = { "type": "command", "command": "node <mod folder>/statusline.js", "refreshInterval": 1 }. If another statusLine is set, ask me before replacing it.
4. Merge into ~/.claude/keybindings.json, keeping the bindings already there (create the file if it is missing, with "$schema": "https://www.schemastore.org/claude-code-keybindings.json"): in the "Chat" context block, add "ctrl+x ctrl+p": "command:activity". If that key is bound to something else, ask me.
5. Run claude plugin validate ~/.claude/mods/session-band and tell me the result.
6. Sum up what changed in the two settings files, then remind me to open a new session so the mod loads.
```

### By hand

1. Clone the repo into `~/.claude/mods/session-band`.
2. Merge into `~/.claude/settings.json`, with `<home>` your home folder as an absolute path: `/Users/you` on macOS, `/home/you` on Linux, `C:/Users/you` on Windows:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "<home>/.claude/mods/session-band",
       "ENABLE_PROMPT_CACHING_1H": "1"
     },
     "statusLine": {
       "type": "command",
       "command": "node <home>/.claude/mods/session-band/statusline.js",
       "refreshInterval": 1
     }
   }
   ```

3. Merge into `~/.claude/keybindings.json` the key that opens the pane:

   ```json
   {
     "bindings": [{ "context": "Chat", "bindings": { "ctrl+x ctrl+p": "command:activity" } }]
   }
   ```

4. Open a new session. The band shows above the prompt, `☰` beside Context opens the pane, and the status line shows model, folder and session title. No band? Run `claude --debug` and look for `session-band` loading in the debug log.

`ENABLE_PROMPT_CACHING_1H` keeps the prompt cache for an hour; without it the cache lasts 5 minutes and the band shows `(5m, 1h off)`. `refreshInterval: 1` keeps the band's cache clock true to the second.

To update: `git pull` in `~/.claude/mods/session-band`, then open a new session.

### Your own status line segments

To add segments of your own machine at the end of the status line without touching the repo, create `~/.claude/statusline.local.js` exporting `(input, colors) => string`: `input` is the JSON Claude Code hands the status line, `colors` the script's palette. Without the file the status line runs as usual.

```js
module.exports = (d, C) => (d.session_id ? C.teal + "◆ my thing" + C.r : "")
```

### What the band reads

| File | For |
|---|---|
| `claude-prompt-cache-<session id>.json` in the system temp folder | the prompt cache's real deadline, the turn count |
| `~/.claude/rate-limits-cache.json` | the latest 5h and weekly limits of every session |

`statusline.js` writes both. Without them the band still runs: the cache deadline is estimated from the last answer, and the limits come from the running session's `$.session.usage()`.

### What the pane writes

| Folder | For |
|---|---|
| `session-band/<session id>/` in a temporary folder only you read: `%TEMP%` on Windows, `$TMPDIR` on macOS, `$XDG_RUNTIME_DIR` (else `~/.cache`) on Linux | each tool call's whole input and output, one JSON file per call, each subagent's prompt and report, and an `alive` mark the session renews every minute |

The folder goes when its session ends (exit, `/clear`, a resume). A session's start removes the folders of sessions that ended without removing theirs, a killed one included, and leaves alone those another running session still marks. The session's state keeps only each call's first lines.

| Store | For |
|---|---|
| `totals:<session id>` in the mod's own `$.store` (a JSON file under `~/.claude`) | the session lines' figures alone, about ten numbers, saved at each answer and at the session's end; the last 50 sessions are kept |

A resumed session's pane goes on from those figures: its Session, Time, Cost and Token lines count what came before, and the prompts from before the resume show as one line, `… 9 prompts before the resume`. Their rows, requests and tool calls are not kept.

### Everything it runs, reads and sends

Nothing goes over the network: neither the mod nor `statusline.js` sends data anywhere or downloads anything, and neither changes a setting or a permission.

| | The mod (`hooks/`) | `statusline.js` (full install only) |
|---|---|---|
| Watches | the session's prompts, requests, tool calls and subagents, to draw them; their text stays on this machine, in the files above | the JSON Claude Code hands a status line |
| Reads | the environment variables `HOME`, `USERPROFILE`, `OS`, `TEMP`, `TMP`, `TMPDIR` and `XDG_RUNTIME_DIR`, to find the temporary and home folders; the two files under What the band reads; its own folder and `$.store`; the session's usage figures | the session's transcript, for its title and turn count; `~/.claude/statusline.local.js` when you made one |
| Writes | its own folder and `$.store`, as above | `claude-statusline-<session id>.json` and `claude-prompt-cache-<session id>.json` in the system temp folder, `~/.claude/rate-limits-cache.json` |
| Runs | one command, to remove a session's folder of its own: `cmd /c rmdir /s /q <folder>` on Windows, `rm -rf -- <folder>` on macOS and Linux, only for a `session-band/<session id>` folder in the temporary folder | nothing |
| Calls | Claude Code's `PushNotification` tool, 10 and then 5 minutes before the prompt cache expires, while Claude is not working: `<project folder>: the prompt cache expires in 5 min`, shown on the desktop and, over Remote Control, on your phone; a toast when it is not delivered | nothing |

## Use

| To | How |
|---|---|
| Open or close the pane | press `☰` beside Context (green while open), or `/activity` |
| Keyboard shortcut | `Ctrl+X Ctrl+P` from the prompt (bound at install) |
| Move into the pane | `Ctrl+X Tab`, then Tab and Enter; `Ctrl+X X` closes it |
| Widen or narrow the pane | drag its edge, or `Ctrl+X ←`/`Ctrl+X →` from inside it |
| See a tool call whole | press its row; `‹ Back` returns to it |
| Clear what is done | `/activity clear`; `/clear` starts the pane over with the new conversation; a resume goes on from the session's figures |
| Preview the cache expiry notice | `/session-band demo <minutes>` |

Pressing the band's button writes nothing to the transcript. Running `/activity` (the shortcut too) leaves one command line, about ten tokens.

## Reading the pane

| Where | Means |
|---|---|
| Session lines, top | requests, tool calls and failures; time and cost; `Token`: every token the API processed, input with its cache reads and output, subagents included (each request sends the conversation again, so it far outgrows the context) · `Out`: tokens written · `Cache hit`: the share of the main loop's input read from the cache |
| `Background: 1 running` | under the session lines while a shell runs in the background (`run_in_background`, ctrl+b, a timeout): one row a command, timed until its task ends, whichever prompt started it |
| `│` | splits a row: the name on the left, its figures right-aligned on the right |
| Times | seconds under a minute (`14s`), a clock from a minute (`01:39`, `1:02:40`); the right column pads them to one width so they line up |
| Prompt row, left | when it was sent (`14:21`, lit while it is open or runs), then its text; a turn a background task's notification started reads as its summary (`Background command "…" completed (exit code 0)`); where the prompts listed cross midnight, a rule names the day (`── 24/10 ──`) |
| Prompt row, right | what the prompt cost, subagents included · its whole time; the context it left is in its summary |
| `Turn` | the main loop's turn number in the session, those before a resume counted |
| `Cache tax` · `expired` | what a request pays to send the context again, going on with the task: read from the cache while it holds (read price) · written to it again once it expired (write price). One line under the session lines, from the main loop's context now |
| `Model` | the model and effort the request was sent with |
| Request row (`#n`), right | context after that request · time from sending it to its last tool's answer |
| Tool row, right | how long the tool ran, a background shell's until its task ended; orange from 30s |
| `In` / `Out` | input tokens (cache included) / tokens the model wrote, from the API |
| `Wait` / `Write` | from sending to the response's first item / from there to its end; `Time` when no item of it was seen |
| `⚠` | something worth a look: a failed tool, a failed request, a cache rewrite, a prompt stopped |
| `⚠ cache written again 365k` | the cache expired, so the request wrote the whole context again (20k tokens or more, at least half its input) |
| `Cost` | an estimate from the price table in `hooks/register.tsx`, subagents included; the engine reports tokens, not money |

Tools run while the model is still writing its reply, so a request's time is not `Wait + Write` plus its tools.

An `Agent` row opens on the subagent it spawned: its context, cost and tool calls. A subagent's row under `Subagent`, running or done, names its type, model · effort and task, with its cost · time on the right. It opens its own screen, drawn as the main list is: three `Subagent` lines (requests, tool calls, time, cost, tokens, cache hit), then each run of it as a prompt row with its `#n` requests and their calls; last, whole, the prompt its spawner gave it and the report it handed back. A call opened there goes Back to it. While a subagent's transcript is in view, the pane shows that screen.

Any other tool row opens its own screen: status, time and result size, then `In` as the tool took it and `Out` whole, as the model read it. `In` is a shell's command as written, with any argument that changes its run (a timeout, a background run) as JSON under it, or another tool's arguments as JSON. A tool that answered with no text (ToolSearch, an image read) shows its result record, an image's data as its size. Colours and control characters are left out of what the screen draws, not of the file. Past 80,000 characters the screen names the file that holds the rest.

The pane lists what this process saw of the session: up to 200 prompts and 1000 requests (the main loop's and the subagents' together), 1000 tool calls, 100 subagents. `/clear`, `/resume` or an exit removes it all, the subagents' prompt and report files too. Only the session lines' figures outlive it.

## Layout

| File | Holds |
|---|---|
| `hooks/register.tsx` | the hooks module, whole: the band and its `☰` button, then the activity pane and its data |
| `hooks/activity.test.tsx` | tests of the pane and the band |
| `types/index.d.ts` | the type of every value in `$.state` |
| `statusline.js` | the status line; Node runs it every second, outside the mod, so the engine never loads it |

A plugin has one hooks module and hooks each event once without a matcher, so `session.start`, `turn.start`, `turn.step` and `turn.complete` are the band's hooks, which call the pane's `activity*` functions. It stays one file: the plugin directory reads `$` passed only to a function declared in the same file.

## Checks

```sh
npx -p typescript tsc -p .        # needs .claude-plugin/types/, which the engine writes when it loads the mod
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
