# session-band

English · [Tiếng Việt](README.vi.md)

A Claude Code mod in two parts, with a status line to go with it:

- **The band**, always above the prompt: turn, time left on the prompt cache, output speed, context, and the 5h and weekly limits.
- **The activity pane**, opened from `☰` beside Context: each prompt, the requests it sent to the model, their tool calls and subagents.
- **The status line** (`statusline.js`) under the prompt: model and effort, folder, session title. It also hands the band the figures the mod API lacks.

![session-band in Claude Code: the band and status line on the left, the activity pane docked on the right](docs/preview.png)

<sub>An illustration of what the mod draws, not a screenshot: your terminal's font and widths apply.</sub>

## Install

Needs a Claude Code with mods (on by default from 2.1.287; written against 2.1.310), Node.js and git. Works on macOS, Linux and Windows.

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

## Use

| To | How |
|---|---|
| Open or close the pane | press `☰` beside Context (green while open), or `/activity` |
| Keyboard shortcut | `Ctrl+X Ctrl+P` from the prompt (bound at install) |
| Move into the pane | `Ctrl+X Tab`, then Tab and Enter; `Ctrl+X X` closes it |
| Widen or narrow the pane | drag its edge, or `Ctrl+X ←`/`Ctrl+X →` from inside it |
| Clear what is done | `/activity clear` |
| Preview the cache expiry notice | `/session-band demo <minutes>` |

Pressing the band's button writes nothing to the transcript. Running `/activity` (the shortcut too) leaves one command line, about ten tokens.

## Reading the pane

| Where | Means |
|---|---|
| Session lines, top | requests, tool calls and failures; time and cost; `Token`: every token the API processed, input with its cache reads and output, subagents included (each request sends the conversation again, so it far outgrows the context) · `Out`: tokens written · `Cache hit`: the share of the main loop's input read from the cache |
| `│` | splits a row: the name on the left, its figures right-aligned on the right |
| Times | seconds under a minute (`14s`), a clock from a minute (`01:39`, `1:02:40`); the right column pads them to one width so they line up |
| Prompt row, right | what the prompt cost, subagents included · its whole time; the context it left is in its summary |
| Request row (`#n`), right | context after that request · time from sending it to its last tool's answer |
| Tool row, right | how long the tool ran; orange from 30s |
| `In` / `Out` | input tokens (cache included) / tokens the model wrote, from the API |
| `Wait` / `Write` | from sending to the response's first item / from there to its end |
| `⚠` | something worth a look: a failed tool, a failed request, a cache rewrite, a prompt stopped |
| `⚠ cache written again 365k` | the cache expired, so the request wrote the whole context again (20k tokens or more, at least half its input) |
| `Cost` | an estimate from the price table in `hooks/activity.tsx`, subagents included; the engine reports tokens, not money |

Tools run while the model is still writing its reply, so a request's time is not `Wait + Write` plus its tools.

An `Agent` row opens on the subagent it spawned: its context, cost and tool calls. A failed tool row opens on the first lines of its error. While a subagent's transcript is in view, the pane shows that subagent's calls only.

The pane keeps the running session alone: up to 100 prompts, 300 requests, 1000 tool calls, 100 subagents.

## Layout

| File | Holds |
|---|---|
| `hooks/register.tsx` | the band, the hooks both parts share, the `☰` button |
| `hooks/activity.tsx` | the activity pane and its data |
| `hooks/activity.test.tsx` | tests of the pane and the band |
| `types/index.d.ts` | the type of every value in `$.state` |
| `statusline.js` | the status line; Node runs it every second, outside the mod, so the engine never loads it |

A plugin hooks each event once without a matcher, so `register.tsx` hooks `session.start`, `turn.start`, `turn.step` and `turn.complete` and calls the `activity*` functions of `activity.tsx`.

## Checks

```sh
npx -p typescript tsc -p .        # needs .claude-plugin/types/, which the engine writes when it loads the mod
claude plugin validate .
claude plugin test .
```

## License

[MIT](LICENSE)
