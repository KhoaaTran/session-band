// Claude Code status line (1 line): model + cwd + title. The session-band mod draws
// the rest; this script relays what the mod's API lacks, per session in
// %TEMP%/claude-prompt-cache-<id>.json: the native prompt_cache deadline and the turn count.

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let d = {};
  try {
    d = JSON.parse(raw);
  } catch (e) {}

  // Catppuccin Mocha palette (truecolor)
  const rgb = (h) => "\x1b[38;2;" + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(";") + "m";
  const C = {
    r: "\x1b[0m", dim: "\x1b[2m",
    yel: rgb("#f9e2af"), grn: rgb("#a6e3a1"), lav: rgb("#b4befe"), teal: rgb("#94e2d5"),
  };
  const sep = C.dim + " · " + C.r;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  // Runs every second: the transcript title and turn count are memoized per session in %TEMP%
  const fs = require("fs");
  const memoFile = d.session_id ? require("path").join(require("os").tmpdir(), "claude-statusline-" + d.session_id + ".json") : null;
  let memo = {};
  try {
    if (memoFile) memo = JSON.parse(fs.readFileSync(memoFile, "utf8"));
  } catch (e) {}

  const model = d.model && (d.model.display_name || d.model.id);
  const effort = d.effort && (typeof d.effort === "string" ? d.effort : d.effort.level);
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd;
  // Prefer the /rename name; otherwise the custom or AI title recorded in the transcript
  let title = d.session_name || "";
  // Turns: prompts the person sent (turnOrigin "human"), not task notifications or slash commands
  let turns = null;
  let titleKey = "";
  try {
    if (d.transcript_path) {
      const st = fs.statSync(d.transcript_path);
      titleKey = st.size + ":" + st.mtimeMs;
    }
  } catch (e) {}
  // A memo written before answeredAt existed is read again once
  if (titleKey && memo.titleKey === titleKey && "answeredAt" in memo) {
    title = title || memo.title || "";
    turns = num(memo.turns);
  } else if (d.transcript_path) {
    try {
      const t = fs.readFileSync(d.transcript_path, "utf8");
      const last = (re) => {
        let m, v = "";
        while ((m = re.exec(t))) v = m[1];
        return v;
      };
      let found = last(/"customTitle":"((?:[^"\\]|\\.)*)"/g) || last(/"aiTitle":"((?:[^"\\]|\\.)*)"/g);
      if (found) found = JSON.parse('"' + found + '"');
      memo.title = found;
      title = title || found;
      turns = (t.match(/"turnOrigin":"human"/g) || []).length;
      memo.turns = turns;
      // When the last answer ended: a resumed session has no prompt_cache until it answers again
      const answeredAt = Date.parse(last(/"subtype":"turn_duration"[^\n]*?"timestamp":"([^"]+)"/g));
      memo.answeredAt = isFinite(answeredAt) ? answeredAt : null;
    } catch (e) {}
    memo.titleKey = titleKey;
  }
  try {
    if (memoFile) fs.writeFileSync(memoFile, JSON.stringify(memo));
  } catch (e) {}
  // This machine's own segments, outside the repo: ~/.claude/statusline.local.js, when it
  // exists, exports (input, colors) => string, drawn last; absent, nothing is added.
  let local = "";
  try {
    const extra = require(require("path").join(require("os").homedir(), ".claude", "statusline.local.js"));
    local = (typeof extra === "function" && extra(d, C)) || "";
  } catch (e) {}

  // Codex-style head: model effort · cwd · title
  const head = [
    model ? C.yel + model + (effort ? " " + effort : "") + C.r : "",
    cwd ? C.grn + cwd + C.r : "",
    title ? C.lav + title + C.r : "",
    local,
  ].filter(Boolean).join(sep);

  // Relay to the session-band mod; without a prompt_cache (a resumed session before its first
  // answer), a deadline estimated from the transcript's last answer and a 1h TTL
  if (d.session_id) {
    const pc = d.prompt_cache;
    const answeredAt = num(memo.answeredAt);
    const bridge = Object.assign(
      { turns },
      pc
        ? { ttl: pc.ttl || "1h", expires_at: num(pc.expires_at), warm: pc.warm !== false, caching_observed: pc.caching_observed !== false }
        : answeredAt
          ? { ttl: "1h", expires_at: Math.floor(answeredAt / 1000) + 3600, warm: true, caching_observed: true }
          : {}
    );
    try {
      fs.writeFileSync(require("path").join(require("os").tmpdir(), "claude-prompt-cache-" + d.session_id + ".json"), JSON.stringify(bridge));
    } catch (e) {}
  }

  // Share the latest limits and real context-window sizes with ~/.claude/watch-status.js
  const size = num((d.context_window || {}).context_window_size);
  if (d.rate_limits || size) {
    try {
      const file = require("path").join(require("os").homedir(), ".claude", "rate-limits-cache.json");
      let prev = {};
      try {
        prev = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {}
      const models = Object.assign({}, prev.models);
      if (size && d.model && d.model.id) models[d.model.id.replace(/\[.*\]$/, "")] = size;
      fs.writeFileSync(
        file,
        JSON.stringify(d.rate_limits ? { saved_at: Date.now() / 1000, rate_limits: d.rate_limits, models } : Object.assign({}, prev, { models }))
      );
    } catch (e) {}
  }

  process.stdout.write(head);
});
