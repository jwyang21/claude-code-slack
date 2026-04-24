// ═══════════════════════════════════════════════════════════════════════════
//  Claude ↔ Slack Bridge Bot (fully annotated for JavaScript beginners)
// ═══════════════════════════════════════════════════════════════════════════
//
//  WHAT IS THIS FILE?
//  ------------------
//  This is a Slack bot server written in JavaScript for Node.js. When you run
//  `npm start` (which runs `node index.js`), this program:
//
//    1. Connects to a Slack workspace via WebSocket (a live two-way channel).
//       From now on, whenever a user types a slash command like `/claude` or
//       `/tmux-connect` in Slack, the bot receives it in real time.
//
//    2. Acts as a bridge to two things on the server:
//         (a) Anthropic's Claude API — the same AI behind claude.ai. The bot
//             forwards user questions to the API and posts answers back to
//             Slack. It can also execute file-write and shell commands that
//             Claude's answer suggests, making it an "agentic" assistant.
//         (b) tmux sessions — the bot can attach to any tmux pane on the
//             server, forward keystrokes to it (e.g. to control a running
//             Claude Code agent), and capture the terminal screen.
//
//  HIGH-LEVEL FEATURES
//  -------------------
//    /claude <task>          Call Claude API + execute the returned file /
//                            shell instructions on the server (agentic mode).
//
//    /tmux-connect <n>       Attach the bot to tmux session `n`. After that,
//                            thread replies get forwarded as keystrokes to
//                            the attached tmux pane.
//
//    /tmux, /tmux-status,    Explicit control commands for the attached
//    /tmux-disconnect        tmux session (send input, capture screen, detach).
//
//    Permission auto-detect  A background loop polls the tmux screen every 3
//                            seconds. If it sees a permission prompt (like
//                            "Do you want to proceed?"), it posts Yes/No
//                            buttons to Slack so the user can approve from
//                            anywhere.
//
//  ONE-MINUTE JAVASCRIPT REFRESHER
//  --------------------------------
//  If you don't know JavaScript, here's the minimum you need:
//
//    const x = 5;                    `const` = a value that never changes.
//    let   y = 10;                   `let`   = a value that CAN change later.
//    function foo(a, b) { ... }      function definition with parameters.
//    (arg) => { ... }                arrow function = compact function syntax.
//    async function / await          async = the function may do slow work;
//                                    await = "pause here until this finishes".
//    const { a, b } = obj;           destructuring: pull fields `a` and `b`
//                                    out of an object into local variables.
//    `hello ${name}`                 template literal: ${...} gets substituted.
//    /pattern/flags                  regular expression (for text pattern matching).
//    arr.map(fn) / arr.filter(fn)    transform / keep-some-of an array.
//
// ═══════════════════════════════════════════════════════════════════════════


// ─── 1. LOAD THIRD-PARTY LIBRARIES ──────────────────────────────────────────
// `require(...)` loads a reusable piece of code (installed via `npm install`).

const { App } = require("@slack/bolt");
//   @slack/bolt is Slack's official bot framework. We destructure only the
//   `App` class out of the library.

const Anthropic = require("@anthropic-ai/sdk");
//   Official Anthropic SDK — lets us call the Claude API from JavaScript.

const dotenv = require("dotenv");
//   Reads a `.env` file and loads its contents into `process.env` so we can
//   read secret values like API tokens via `process.env.VAR_NAME`.

const fs = require("fs");
//   Built-in `fs` = "file system": read and write files on disk.

const path = require("path");
//   Built-in module for safely manipulating file paths across operating systems.

const { execSync } = require("child_process");
//   `child_process` lets this program launch other programs. `execSync` runs
//   a shell command and waits for it to finish, returning its output. Used
//   here mostly to drive `tmux`.


// ─── 2. LOAD SECRETS FROM .env ──────────────────────────────────────────────
dotenv.config();
// After this line runs, `process.env.SLACK_BOT_TOKEN`, etc. contain the
// values from the `.env` file sitting next to this script.


// ─── 3. CONFIGURATION CONSTANTS ─────────────────────────────────────────────
// Changing MODEL here changes which Claude model is used by EVERY API call
// in this file. Keeping it in one place makes the value easy to swap later.
const MODEL = "claude-opus-4-6";


// ─── 4. CREATE API CLIENTS ──────────────────────────────────────────────────
// An "API client" is an object that holds authentication and exposes methods
// for talking to a remote service.

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
//   Connection to Anthropic. We'll call `anthropic.messages.stream(...)` to
//   ask Claude questions.

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,      // Bot-user OAuth token (xoxb-...)
  appToken: process.env.SLACK_APP_TOKEN,   // App-level token for Socket Mode (xapp-...)
  socketMode: true,                        // Connect via WebSocket (no public URL needed)
});
//   Connection to Slack. Later we register handlers on `app` for slash
//   commands, thread replies, button clicks, etc.

const sessions = new Map();
//   A `Map` is a key→value store (like a dictionary). Each Slack thread with
//   an active /claude conversation gets one entry here, keyed by the string
//   "channelId:threadTs". The value holds the conversation history plus an
//   `aborted` flag.


// ─── 5. TMUX STATE (MUTABLE GLOBAL VARIABLES) ───────────────────────────────
// Only ONE tmux session can be attached at a time. Running /tmux-connect on
// a new session replaces the previous attachment.

let currentTmuxSession = null;   // e.g. "5" or "5:0.1"; null if not attached.
let tmuxPollingActive  = false;  // Is the 3-second background loop running?
let tmuxStreamChannel  = null;   // Slack channel ID where the "anchor" message lives.
let tmuxStreamTs       = null;   // Timestamp (ID) of the anchor message, used as
                                 // `thread_ts` to post inside its thread.
let tmuxLiveMsgTs      = null;   // (Legacy / mostly unused)
let lastTmuxOutput     = "";     // tmux screen content from the previous poll
                                 // — used to detect changes.
let awaitingPermission = false;  // true while a permission prompt is waiting
                                 // for a user response.


// ─── 6. PATTERNS THAT INDICATE A PERMISSION PROMPT ──────────────────────────
// Each entry is a regular expression. If ANY of these match the tmux screen
// text, we treat it as Claude Code asking for approval and post Yes/No
// buttons in Slack.
const PERMISSION_PATTERNS = [
  /Do you want to proceed\?/i,
  /This command requires approval/i,
  /Allow this action\?/i,
  /\(y\/n\)/i,
  /\[y\/N\]/i,
  /\[Y\/n\]/i,
  /1\.\s*Yes.*2\.\s*No/is,
  /Yes.*No.*\(enter number\)/is,
  /Allow Claude to/i,
  /Approve\?/i,
  /confirm.*\?/i,
  /Esc to cancel/i,
  /Tab to amend/i,
  /[❯›]\s*1\./,
];

// Returns true if `output` (the tmux screen text) contains any permission pattern.
//   arr.some(callback) → true if callback returns true for at least one element.
//   regex.test(str)    → true if `regex` matches anywhere in `str`.
function detectPermissionRequest(output) {
  return PERMISSION_PATTERNS.some(p => p.test(output));
}


// ─── 7. PARSE NUMBERED OPTIONS FROM THE SCREEN ──────────────────────────────
// Claude Code typically prints choices like:
//     1. Yes
//     2. Yes, don't ask again
//     3. No
// This function scans the screen text and returns those as an array of
// { number, label } objects. If parsing fails, it falls back to default
// Yes/No and sets `parsed: false`.
function parseOptions(output) {
  // Find the marker text. If found, only examine what comes after it
  // (so older prompts that scrolled by don't interfere).
  const promptIndex = output.search(/Do you want to proceed\?/i);
  const relevant = promptIndex !== -1 ? output.slice(promptIndex) : output;

  // Match every line that starts with a single digit 1-9 followed by ". ".
  //   matchAll → iterator of all matches
  //   [...iter] → spreads that iterator into an array
  //   [\s❯›]*  → allow whitespace or the cursor markers ❯ / › before the digit
  //   ^...$ with /gm flags → match per line
  const matches = [...relevant.matchAll(/^[\s❯›]*([1-9])\.\s+(.+)/gm)];

  if (matches.length >= 2) {
    // De-duplicate in case the same option number appears twice on screen.
    const seen = new Set();
    const unique = [];
    for (const m of matches) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        unique.push({ number: m[1], label: m[2].trim() });
      }
    }
    if (unique.length >= 2) return { options: unique, parsed: true };
  }

  // Fall back to default Yes/No.
  return {
    options: [
      { number: "1", label: "Yes" },
      { number: "2", label: "No" },
    ],
    parsed: false,
  };
}


// ─── 8. BUILD A SLACK "BLOCK KIT" MESSAGE WITH PERMISSION BUTTONS ───────────
// Slack's rich messages are composed of `blocks` — plain JavaScript objects
// describing sections, buttons, etc. This function returns the blocks array
// for a permission-request message.
function buildPermissionBlocks(output) {
  const { options, parsed } = parseOptions(output);
  const ts = Date.now();
  //   Date.now() → current time in milliseconds. We append it to every
  //   button's action_id so that if multiple permission messages live in
  //   the same thread, their action IDs stay unique (Slack requires this).

  const buttons = options.map(opt => {
    // .map() transforms each element of the options array into a button object.
    const label = `${opt.number}. ${opt.label}`;
    const truncated = label.length > 75 ? label.slice(0, 72) + "…" : label;
    //   Slack caps button text length, so we truncate long labels.
    return {
      type: "button",
      text: { type: "plain_text", text: truncated, emoji: true },
      // Buttons starting with "No" get red styling; others get green ("primary").
      style: opt.label.toLowerCase().startsWith("no") ? "danger" : "primary",
      action_id: `tmux_option_${opt.number}_${ts}`,
      value: opt.number,
    };
  });

  // Header text varies depending on whether we parsed the options successfully.
  const headerText = parsed
    ? `⚠️ *Claude is requesting permission:*`
    : `⚠️ *Claude is requesting permission:*\n_⚠️ Could not parse options — showing default Yes/No. *Check terminal directly if more options exist.*_`;

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        // Show the last 600 characters of the tmux screen in a code block so
        // the user sees the full prompt context inside Slack.
        text: `${headerText}\n\`\`\`\n${output.slice(-600)}\n\`\`\``,
      },
    },
    { type: "actions", elements: buttons },
  ];
}


// ─── 9. BACKGROUND LOOP: POLL TMUX EVERY 3 SECONDS ──────────────────────────
// Once the user runs `/tmux-connect`, this function runs forever in the
// background. Every 3 seconds it:
//     - captures the current tmux screen
//     - posts buttons to Slack if a new permission prompt appeared
//     - re-sends a reminder if a prompt has gone unanswered for >5 minutes
//     - resets the waiting flag when the prompt disappears
//
// The loop continues until `tmuxPollingActive` is set to false — this happens
// on `/tmux-disconnect` or when a new `/tmux-connect` replaces the session.
async function startTmuxPolling(client) {
  if (tmuxPollingActive) return;           // Don't start two loops at once.
  tmuxPollingActive = true;
  lastTmuxOutput = "";
  awaitingPermission = false;
  let awaitingPermissionSince = null;      // Timestamp when current prompt started.
  let claudeWasWorking = false;            // (Unused — legacy variable)
  let responseStartOutput = "";            // (Unused — legacy variable)

  while (tmuxPollingActive) {
    // Sleep 3 seconds before each iteration.
    //   new Promise(resolve => setTimeout(resolve, 3000))
    //   creates a promise that resolves after 3000 ms. Awaiting it pauses
    //   execution without blocking the event loop.
    await new Promise(r => setTimeout(r, 3000));
    if (!tmuxPollingActive) break;

    // Capture the current tmux pane contents.
    let raw;
    try {
      raw = tmuxCapture();
    } catch { break; }                     // If capture fails (session gone), exit the loop.

    // Strip ANSI escape codes (the invisible color/cursor control sequences
    // terminals use). We want clean text for regex pattern matching.
    const stripped = raw
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // CSI sequences: \x1b[...m
      .replace(/\x1b\][^\x07]*\x07/g, "");    // OSC sequences: \x1b]...BEL
    const output = stripped.trim().slice(-8000);   // Keep last 8 KB.

    // If we were waiting for a permission and the prompt is gone → reset.
    if (awaitingPermission && !detectPermissionRequest(output)) {
      awaitingPermission = false;
      awaitingPermissionSince = null;
    }

    // If still waiting and 5 minutes have elapsed → send a reminder.
    if (awaitingPermission && awaitingPermissionSince) {
      if (Date.now() - awaitingPermissionSince > 300000) {   // 300000 ms = 5 min
        await client.chat.postMessage({
          channel: tmuxStreamChannel,
          thread_ts: tmuxStreamTs,
          text: "⏰ *Reminder — Claude is still waiting for your response:*",
          blocks: buildPermissionBlocks(lastTmuxOutput),
        });
        awaitingPermissionSince = Date.now();              // Reset reminder timer.
      }
    }

    // If screen hasn't changed, nothing new to do this iteration.
    if (output === lastTmuxOutput) continue;
    lastTmuxOutput = output;

    // Detect a brand-new permission request and notify Slack.
    if (!awaitingPermission && detectPermissionRequest(output)) {
      awaitingPermission = true;
      awaitingPermissionSince = Date.now();

      // If a live-updating message exists, update it once more (legacy).
      if (tmuxLiveMsgTs) {
        try {
          await client.chat.update({
            channel: tmuxStreamChannel,
            ts: tmuxLiveMsgTs,
            text: `\`\`\`\n${output.slice(-2800)}\n\`\`\``,
          });
        } catch {}
      }

      // Post the permission-request message (with buttons) in the thread.
      await client.chat.postMessage({
        channel: tmuxStreamChannel,
        thread_ts: tmuxStreamTs,
        text: "⚠️ Claude is requesting permission",
        blocks: buildPermissionBlocks(output),
      });
    }
  }
}


// ─── 10. BUTTON CLICK HANDLER (for the dynamic permission-option buttons) ───
// Fires when a user clicks a button in Slack that has an action_id like
// "tmux_option_1_1712345678901". The regex captures the option number.
//
// To "press option N" in Claude Code's TUI, we send (N-1) DOWN arrow keys to
// move the selection cursor, then ENTER to confirm.
app.action(/^tmux_option_(\d+)_\d+$/, async ({ body, ack, client, action }) => {
  await ack();
  //   Slack requires acknowledging every interaction within 3 seconds — do
  //   it immediately, even before running any other code.
  if (!currentTmuxSession) return;

  const number = parseInt(action.value);   // "1" → 1, "2" → 2, etc.

  // Press DOWN (number - 1) times.
  for (let i = 0; i < number - 1; i++) {
    execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} Down`);
    await new Promise(r => setTimeout(r, 150));  // small gap between keys
  }
  // Then ENTER to confirm.
  execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} Enter`);

  awaitingPermission = false;              // Stop reminder loop immediately.

  // Replace the original button message with a "✅ Responded" note.
  try {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ *Responded: option ${number}*`,
      blocks: [],                          // Empty array → remove all buttons.
    });
  } catch {}
});


// ─── 11. SLASH COMMAND: /tmux-connect <session[:window.pane]> ───────────────
// Called when the user types `/tmux-connect 5` (or `/tmux-connect 5:0.1`) in
// Slack. Attaches the bot to that tmux session so subsequent thread replies
// are forwarded there.
app.command("/tmux-connect", async ({ command, ack, client }) => {
  await ack();
  const sessionId = command.text.trim();

  // No argument → show an ephemeral usage hint (visible only to caller).
  if (!sessionId) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Usage: `/tmux-connect <session-index>`\nExample: `/tmux-connect 2`",
    });
    return;
  }

  // Verify that the tmux session actually exists on the server.
  // `tmux has-session -t X` exits nonzero if session X is missing, which
  // makes execSync throw.
  try {
    execSync(`tmux has-session -t ${sessionId}`);
  } catch {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `❌ tmux session \`${sessionId}\` not found. Run \`tmux ls\` to check.`,
    });
    return;
  }

  // Stop any existing polling loop cleanly, then update global state.
  tmuxPollingActive = false;
  await new Promise(r => setTimeout(r, 500));   // Give the loop time to exit.

  currentTmuxSession = sessionId;
  tmuxStreamChannel = command.channel_id;
  awaitingPermission = false;

  // Post an "anchor" message. From here on, permission alerts, status
  // captures, etc. are posted into THIS message's thread.
  const anchorMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🔗 *Connected to tmux session \`${sessionId}\`* — monitoring for permission requests.\nUse \`/tmux-status\` to see current output anytime.`,
  });
  tmuxStreamTs = anchorMsg.ts;

  // Post a one-time snapshot of the current pane so the user sees what's running.
  try {
    const raw = tmuxCapture();
    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    const output = stripped.trim().slice(-2800);
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: tmuxStreamTs,
      text: `📺 *Current output:*\n\`\`\`\n${output}\n\`\`\``,
    });
    lastTmuxOutput = output;
  } catch {}

  // Kick off the background polling loop (permission detection etc.).
  startTmuxPolling(client);
});


// ─── 12. SLASH COMMAND: /tmux-status ────────────────────────────────────────
// Capture the tmux screen right now and post it into the anchor thread.
app.command("/tmux-status", async ({ command, ack, client }) => {
  await ack();
  if (!currentTmuxSession) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Not connected to any tmux session. Use `/tmux-connect <session-index>` first.",
    });
    return;
  }
  try {
    const raw = tmuxCapture();
    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    const output = stripped.trim().slice(-2800);
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: tmuxStreamTs,
      text: `📺 *Current output:*\n\`\`\`\n${output}\n\`\`\``,
    });
  } catch (err) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `❌ Error: ${err.message}`,
    });
  }
});


// ─── 13. SLASH COMMAND: /tmux-disconnect ────────────────────────────────────
// Stop monitoring the tmux session.
// NOTE: this does NOT detach or kill the actual tmux session on the server.
// It only makes THIS bot forget about the session. The tmux session itself
// (and anything running inside it, like Claude Code) continues as-is.
app.command("/tmux-disconnect", async ({ command, ack, client }) => {
  await ack();
  tmuxPollingActive = false;
  currentTmuxSession = null;
  await client.chat.postMessage({
    channel: command.channel_id,
    text: "🔌 *Disconnected from tmux session.*",
  });
});


// ─── 14. SLASH COMMAND: /tmux <text> ────────────────────────────────────────
// Send arbitrary keystrokes from Slack to the attached tmux pane.
// Example: `/tmux ls -la` → types "ls -la" into the pane and hits Enter.
app.command("/tmux", async ({ command, ack, client }) => {
  await ack();
  if (!currentTmuxSession) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Connect first with `/tmux-connect <session-index>`.",
    });
    return;
  }

  const input = command.text.trim();
  if (!input) return;

  awaitingPermission = false;              // User just acted; clear flag.
  tmuxSend(input);                         // Forward keystrokes to tmux.

  await client.chat.postMessage({
    channel: command.channel_id,
    thread_ts: tmuxStreamTs,
    text: `⌨️ *Sent:* \`${input}\``,
  });
});


// ─── 15. SMALL UTILITY HELPERS ──────────────────────────────────────────────

// Unique key for a Slack conversation. Threads → "channel:thread_ts",
// top-level messages → just "channel". Used to look up sessions in the Map.
function sessionKey(channelId, threadTs) {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

// Post a normal status/progress message inside a thread.
// `mrkdwn: true` enables Slack's markdown rendering (bold, italics, etc.).
async function postStatus(client, channel, threadTs, text) {
  return client.chat.postMessage({ channel, thread_ts: threadTs, text, mrkdwn: true });
}

// Split `text` into chunks of at most `maxLen` characters and return them as
// an array. Slack caps a single message at ~3000 characters, so long results
// need to be broken into multiple messages.
function chunkText(text, maxLen) {
  const chunks = [];
  while (text.length > maxLen) {
    chunks.push(text.slice(0, maxLen));
    text = text.slice(maxLen);
  }
  chunks.push(text);
  return chunks;
}

// Post a (possibly long) result message, splitting if needed, and attach
// two buttons ("New Task" / "Exit Session") at the end.
async function postWithActions(client, channel, threadTs, text) {
  const chunks = chunkText(text, 2800);
  // Post all but the last chunk as plain messages.
  for (let i = 0; i < chunks.length - 1; i++) {
    await postStatus(client, channel, threadTs, chunks[i]);
  }
  // Last chunk goes as a rich block with action buttons.
  return client.chat.postMessage({
    channel, thread_ts: threadTs, mrkdwn: true, text: "Completed!",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `✅ *Completed!*\n\n${chunks[chunks.length - 1]}` } },
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "🚀 New Task",     emoji: true }, style: "primary", action_id: "new_task",     value: JSON.stringify({ channel, threadTs }) },
        { type: "button", text: { type: "plain_text", text: "🛑 Exit Session", emoji: true }, style: "danger",  action_id: "exit_session", value: JSON.stringify({ channel, threadTs }) },
      ]},
    ],
  });
}


// ─── 16. FILE READING (USED BY /claude) ─────────────────────────────────────
// When the user types `/claude /path/to/project please review`, the bot
// auto-reads relevant files at that path and bundles them into the prompt
// so Claude has context.

// Extensions treated as "code/text we can read safely".
const CODE_EXTS = new Set([
  ".py",".js",".ts",".jsx",".tsx",".java",".cpp",".c",".h",
  ".go",".rs",".rb",".sh",".yaml",".yml",".json",".toml",
  ".md",".txt",".html",".css",".sql"
]);

// Read a file's contents, returning null on error. Files >100KB are skipped
// with a placeholder (to avoid blowing up the prompt size).
function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 100 * 1024) return `[File is too large (exceeds 100KB): ${filePath}]`;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// Walk a directory recursively, collecting up to `maxFiles` code files.
// Skips hidden folders (".*") and common build/cache folders.
function collectFiles(dirPath, maxFiles = 30) {
  const results = [];

  function walk(current) {
    if (results.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      // Skip hidden directories and common noise.
      if (entry.name.startsWith(".") ||
          ["node_modules","__pycache__",".git","dist","build"].includes(entry.name)) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);                    // recurse into subdirectory
      } else if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const content = readFileSafe(fullPath);
        if (content !== null) results.push({ path: fullPath, content });
      }
    }
  }

  walk(dirPath);
  return results;
}

// Scan a user prompt for anything that looks like an absolute path
// ("/without/spaces"), and return only the ones that actually exist on disk.
function extractPaths(text) {
  const matches = text.match(/\/[^\s`'"，,]+/g) || [];
  return matches.filter(p => {
    try {
      fs.accessSync(p);                    // throws if the path doesn't exist
      return true;
    } catch {
      return false;
    }
  });
}

// Given a list of paths, build a big markdown string embedding their contents.
// The result gets appended to the user's prompt before being sent to Claude.
function buildFileContext(paths) {
  if (paths.length === 0) return "";

  let ctx = "\n\n---\nContent of required file/directory contents:\n\n";
  for (const p of paths) {
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      ctx += `[Absent path: ${p}]\n`;
      continue;
    }
    if (stat.isDirectory()) {
      const files = collectFiles(p);
      if (files.length === 0) {
        ctx += `[Empty directory: ${p}]\n`;
        continue;
      }
      ctx += `### 📁 ${p} (${files.length} files)\n\n`;
      for (const f of files) {
        const ext = path.extname(f.path).slice(1) || "txt";
        ctx += `**${f.path}**\n\`\`\`${ext}\n${f.content}\n\`\`\`\n\n`;
      }
    } else {
      const content = readFileSafe(p);
      if (content === null) {
        ctx += `[Failed reading file: ${p}]\n`;
        continue;
      }
      const ext = path.extname(p).slice(1) || "txt";
      ctx += `**${p}**\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
    }
  }
  return ctx;
}


// ─── 17. FILE WRITING (EXECUTES <<<WRITE:...>>> BLOCKS FROM CLAUDE) ─────────
// Claude's reply can include a block like:
//     <<<WRITE:/abs/path/to/file.py>>>
//     ...file content...
//     <<<END>>>
// This function parses every such block out of the reply and actually writes
// the file to the server's disk. Returns:
//     cleaned  — the reply text with the WRITE blocks removed
//     written  — list of file paths that were saved (or error placeholders)
function parseAndApplyWrites(responseText) {
  // Regex explanation:
  //   <<<WRITE:    literal marker
  //   ([^>]+)      capture group 1: file path (any char except '>')
  //   >>>\n        close marker + newline
  //   ([\s\S]*?)   capture group 2: file content (lazy — smallest match)
  //   <<<END>>>    end marker
  //   /g           global flag — find ALL matches, not just the first.
  const writeRegex = /<<<WRITE:([^>]+)>>>\n([\s\S]*?)<<<END>>>/g;

  const written = [];
  let match;
  while ((match = writeRegex.exec(responseText)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    try {
      // Create parent directories if missing, then write the file.
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      written.push(filePath);
    } catch (e) {
      written.push(`[Failed writing: ${filePath} — ${e.message}]`);
    }
  }
  // Remove all WRITE blocks from the response so the user doesn't see duplicates.
  const cleaned = responseText.replace(/<<<WRITE:[^>]+>>>\n[\s\S]*?<<<END>>>/g, "").trim();
  return { cleaned, written };
}


// ─── 18. SHELL EXECUTION (EXECUTES <<<SHELL:...>>> BLOCKS FROM CLAUDE) ──────
// Same idea as parseAndApplyWrites, but for blocks like:
//     <<<SHELL:/working/directory>>>
//     git add . && git commit -m "fix"
//     <<<END>>>
// Commands are written to a temp script and executed with bash. `cwd`
// defaults to the bot's own working directory if no path is given.
function parseAndRunShell(responseText) {
  //   (?::(...))?  — the ":/path" part is OPTIONAL (outer ? makes the whole group optional)
  const shellRegex = /<<<SHELL(?::([^>]+))?>>>\n([\s\S]*?)<<<END>>>/g;

  const results = [];
  let match;
  while ((match = shellRegex.exec(responseText)) !== null) {
    const cwd = match[1] ? match[1].trim() : process.cwd();
    //   process.cwd() = the directory the bot was started in.
    const commands = match[2].trim();
    const tmpFile = `/tmp/claude_shell_${Date.now()}.sh`;
    try {
      fs.writeFileSync(tmpFile, commands, "utf-8");
      const output = execSync(`bash ${tmpFile}`, {
        cwd,                               // where to run the commands
        encoding: "utf-8",                 // return output as text, not Buffer
        timeout: 30000,                    // kill after 30 seconds
      });
      results.push({ commands, output: output.trim() || "(no output)", success: true });
    } catch (e) {
      // execSync throws when the command exits nonzero. We still record
      // the error output so the user can see what went wrong.
      results.push({ commands, output: (e.stderr || e.message).trim(), success: false });
    } finally {
      // Always clean up the temp file (best-effort).
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
  const cleaned = responseText.replace(/<<<SHELL(?::[^>]+)?>>>\n[\s\S]*?<<<END>>>/g, "").trim();
  return { cleaned, results };
}


// ─── 19. SYSTEM PROMPT FOR /claude ──────────────────────────────────────────
// This is the instruction Claude receives before every /claude request. It
// teaches Claude how to use the WRITE and SHELL block formats above. Without
// it, Claude would just print code in markdown fences and the bot wouldn't
// know how to actually execute anything.
const SYSTEM_PROMPT = `You are an AI coding assistant with direct file system and shell access.

CRITICAL: You MUST use these exact block formats. Never say "I cannot run commands" — you CAN.

To write/create files:
<<<WRITE:/absolute/path/to/file>>>
file content here
<<<END>>>

To run shell commands:
<<<SHELL:/working/directory>>>
command here
<<<END>>>

MANDATORY RULES:
- ALWAYS use WRITE block to create/modify files — NEVER show file content inside markdown code blocks
- ALWAYS use SHELL block for any git operation — never just show commands as text
- When asked to update a file: WRITE the full updated content, then SHELL to git add + commit + push
- Multiple WRITE and SHELL blocks are allowed in one response
- Write a short summary outside the blocks explaining what you did
- DO NOT show file contents in markdown code blocks — use WRITE blocks only`;


// ─── 20. TMUX HELPERS ───────────────────────────────────────────────────────

// Normalize a session spec into the "session:window.pane" form that
// `tmux send-keys -t ...` expects. If the user already specified
// "5:0.1" we use it as-is; otherwise we default to window 0, pane 0.
function getTmuxTarget(sessionId) {
  if (sessionId.includes(":")) return sessionId;
  return `${sessionId}:0.0`;
}

// Send text (as keyboard input) to the attached tmux pane, followed by Enter.
//
// IMPORTANT FIX: Earlier versions combined text + Enter into a single
// `send-keys` call. This sometimes caused Claude Code's TUI to receive
// the Enter mid-paste and leave the text sitting in the input box with
// nothing happening. Splitting into three steps fixes that:
//
//   1. Send text with `-l` (literal) — avoids tmux misinterpreting special
//      chars like apostrophes or non-ASCII characters.
//   2. Sleep 0.3s so Claude Code's TUI finishes absorbing the text.
//   3. Send Enter as a separate key event so it's unambiguously "submit".
function tmuxSend(text) {
  const target = getTmuxTarget(currentTmuxSession);
  // 1. Send the text as literal characters (-l ensures special chars like
  //    apostrophes, Korean, etc. are transmitted verbatim without tmux
  //    trying to interpret them).
  execSync(`tmux send-keys -t ${target} -l ${JSON.stringify(text)}`);
  // 2. Give Claude Code's TUI a moment to fully receive the text before
  //    we press Enter. Without this pause, Enter can arrive mid-paste and
  //    the input gets stuck in the box.
  execSync(`sleep 0.3`);
  // 3. Now send Enter as a separate key event so Claude Code treats it
  //    unambiguously as "submit".
  execSync(`tmux send-keys -t ${target} Enter`);
}

// Grab the current tmux pane contents (including up to 1000 lines of
// scrollback) as a plain string, with ANSI color codes stripped out.
//   -p          : print output to stdout
//   -S -1000    : include scrollback going back 1000 lines
function tmuxCapture() {
  const raw = execSync(
    `tmux capture-pane -t ${getTmuxTarget(currentTmuxSession)} -p -S -1000`,
    { encoding: "utf-8" }
  );
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}


// ─── 21. /claude CORE LOGIC — CALL CLAUDE, APPLY INSTRUCTIONS ───────────────
// This is the heart of the /claude command and its thread follow-ups.
// Workflow:
//   1. Save the session so follow-ups in the same thread inherit history.
//   2. Auto-detect any file/directory paths in the user's prompt, read
//      their contents, and append them as context.
//   3. Stream the request to Claude.
//   4. Parse <<<WRITE>>> blocks from Claude's reply → write files.
//   5. Parse <<<SHELL>>> blocks from Claude's reply → run shell commands.
//   6. Post a summary + New Task / Exit Session buttons back to Slack.
async function runTask(client, channel, threadTs, userPrompt, existingMessages = []) {
  const key = sessionKey(channel, threadTs);
  sessions.set(key, { messages: existingMessages, aborted: false });

  // If the prompt mentions any existing paths, read them and tell the user.
  const detectedPaths = extractPaths(userPrompt);
  if (detectedPaths.length > 0) {
    await postStatus(client, channel, threadTs, `📂 Path: \`${detectedPaths.join(", ")}\` — Reading files…`);
  }
  await postStatus(client, channel, threadTs, `⚙️ *Working…*\n> ${userPrompt}`);

  // Build the full prompt Claude will see: user text + file contents.
  const fileContext = buildFileContext(detectedPaths);
  const messages = [...existingMessages, { role: "user", content: userPrompt + fileContext }];

  try {
    const session = sessions.get(key);
    if (session.aborted) return;           // User pressed "Exit Session" already.

    // Ask Claude. Streaming is used so long answers are generated incrementally.
    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 24000,
      system: SYSTEM_PROMPT,
      messages,
    });

    const response = await stream.finalMessage();
    // Extract only the text blocks and join them. Fall back to placeholder
    // if the response was empty.
    const rawText = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim() || "_(no output)_";

    // Parse and execute the actionable blocks in Claude's reply.
    const { cleaned: afterWrite, written } = parseAndApplyWrites(rawText);
    const { cleaned: finalText, results: shellResults } = parseAndRunShell(afterWrite);

    // Compose the summary message.
    let summary = finalText;
    if (written.length > 0) {
      summary += `\n\n📝 *Saved files:*\n${written.map(f => `• \`${f}\``).join("\n")}`;
    }
    for (const r of shellResults) {
      const icon = r.success ? "✅" : "❌";
      summary += `\n\n${icon} *Shell output:*\n\`\`\`\n$ ${r.commands}\n${r.output}\n\`\`\``;
    }

    // Persist the conversation so thread follow-ups inherit context.
    if (sessions.has(key)) {
      sessions.get(key).messages = [...existingMessages,
        { role: "user",      content: userPrompt },
        { role: "assistant", content: rawText },
      ];
    }

    // Post final result + buttons.
    await postWithActions(client, channel, threadTs, summary || "_Completed_");
  } catch (err) {
    console.error("API error:", err);
    await postStatus(client, channel, threadTs, `❌ *Error:* ${err.message}`);
    sessions.delete(key);
  }
}


// ─── 22. SLASH COMMAND: /claude <task> ──────────────────────────────────────
// Entry point for a brand-new /claude conversation. Creates an anchor
// message (for the thread), then delegates to runTask().
app.command("/claude", async ({ command, ack, client }) => {
  await ack();
  const task = command.text.trim();
  if (!task) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Usage: `/claude <task>`\nExamples:\n• `/claude /path/to/repo review the code`\n• `/claude /path/to/repo fix bug in main.py and push`",
    });
    return;
  }
  const initMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🤖 *Claude session* — <@${command.user_id}> started this session`,
  });
  await runTask(client, command.channel_id, initMsg.ts, task);
});


// ─── 23. THREAD REPLY HANDLER ───────────────────────────────────────────────
// Fires for any message posted inside a thread. Three possible paths:
//   (A) The thread belongs to an attached tmux session → several sub-commands:
//         "tmux-status" → capture + post current screen
//         "status"      → send /status to claude-code, then capture + post
//         "? <question>"→ ask Claude API (no file/shell, short answer)
//         anything else → forward as keystrokes to the tmux pane
//   (B) The thread belongs to an active /claude session → continue with runTask
//   (C) Otherwise → ignore.
app.message(async ({ message, client }) => {
  // Ignore messages written by bots themselves, or messages not inside a thread.
  if (message.subtype === "bot_message" || !message.thread_ts) return;

  const text = message.text && message.text.trim();
  if (!text) return;

  // ── (A) Inside the tmux stream thread ──────────────────────────────────
  if (currentTmuxSession &&
      message.thread_ts === tmuxStreamTs &&
      message.channel   === tmuxStreamChannel) {

    // (A-1) "tmux-status" → capture current tmux screen and post it.
    if (text.toLowerCase() === "tmux-status") {
      try {
        const raw = tmuxCapture();
        const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
        const output = stripped.trim().slice(-2800);
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `📺 *Current output:*\n\`\`\`\n${output}\n\`\`\``,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `❌ Error: ${err.message}`,
        });
      }
      return;
    }

    // (A-2) "status" → send "/status" into claude-code, then capture the result.
    // Claude-code displays its own modal for /status; the capture includes
    // whatever is visible on the pane afterward, which may include older
    // lines preceding the modal.
    if (text.toLowerCase() === "status") {
      try {
        const output = execSync(`tmux send-keys -t ${currentTmuxSession} '/status' Enter`, { encoding: "utf-8" });
        await new Promise(r => setTimeout(r, 2000));   // wait 2s for claude-code to render
        const raw = tmuxCapture();
        const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `📊 *Status:*\n\`\`\`\n${stripped.trim().slice(-2800)}\n\`\`\``,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: tmuxStreamTs,
          text: `❌ Error: ${err.message}`,
        });
      }
      return;
    }

    // (A-3) "? <question>" → stateless Claude API query.
    // IMPORTANT: This does NOT include any tmux screen context, and the
    // result is NOT post-processed for WRITE/SHELL blocks. It's purely a
    // concise Q&A path, like asking a question on claude.ai directly.
    if (text.startsWith("?")) {
      const prompt = text.slice(1).trim();

      await postStatus(client, message.channel, message.thread_ts, `⚙️ *Working…*\n> ${prompt}`);

      try {
        const stream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: 3000,                // short answer
          system: "You are a helpful assistant. Be concise. Answer in 3-5 sentences max unless code is required.",
          messages: [{ role: "user", content: prompt }],
        });
        const response = await stream.finalMessage();
        const answer = response.content
          .filter(b => b.type === "text")
          .map(b => b.text)
          .join("\n")
          .trim();

        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.thread_ts,
          text: answer.slice(0, 2800),     // max one Slack message
          mrkdwn: true,
        });
      } catch (err) {
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.thread_ts,
          text: `❌ Error: ${err.message}`,
        });
      }
      return;
    }

    // (A-4) Anything else → forward as keystrokes into the tmux pane.
    awaitingPermission = false;
    tmuxSend(text);
    return;
  }

  // ── (B) Thread belongs to an active /claude session → continue. ────────
  const key = sessionKey(message.channel, message.thread_ts);
  const session = sessions.get(key);
  if (!session || !message.text) return;
  await runTask(client, message.channel, message.thread_ts, text, session.messages);
});


// ─── 24. NEW TASK / EXIT SESSION BUTTON HANDLERS ────────────────────────────

// "🚀 New Task" button → prompt the user to input a new task in the thread.
app.action("new_task", async ({ body, ack, client }) => {
  await ack();
  const { channel, threadTs } = JSON.parse(body.actions[0].value);
  await postStatus(client, channel, threadTs, "💬 Please input next task!");
});

// "🛑 Exit Session" button → mark the session as aborted and remove it from
// the Map. Any in-flight runTask() will notice the aborted flag and bail.
app.action("exit_session", async ({ body, ack, client }) => {
  await ack();
  const { channel, threadTs } = JSON.parse(body.actions[0].value);
  const key = sessionKey(channel, threadTs);
  const session = sessions.get(key);
  if (session) { session.aborted = true; sessions.delete(key); }
  await postStatus(client, channel, threadTs, "👋 *Session ended.* Use `/claude <task>` to start a new one.");
});


// ─── 25. SERVER STARTUP (runs once at the bottom of the file) ───────────────
// An IIFE (Immediately Invoked Function Expression) used as an `async`
// wrapper so we can `await` at the top level. It:
//   1. Starts the Slack Bolt app (opens the WebSocket connection).
//   2. Registers a global handler for uncaught exceptions — if Slack
//      disconnects unexpectedly, exit the process after 5s so the
//      outer `while true; do npm start; sleep 5; done` restart loop
//      can bring us back up cleanly.
(async () => {
  await app.start();
  console.log("⚡ Claude ↔ Slack running! (read + write + shell + tmux enabled)");

  // Auto-reconnect on unexpected crash.
  process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err.message);
    if (err.message.includes("Unhandled event")) {
      console.log("Restarting in 5 seconds...");
      setTimeout(() => process.exit(1), 5000);
    }
  });
})();
