const { App } = require("@slack/bolt");
const Anthropic = require("@anthropic-ai/sdk");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

dotenv.config();

// ─── Model configuration ─────────────────────────────────────────────────────
// Change this value to switch Claude models across the entire file.
const MODEL = "claude-opus-4-6";

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const app = new App({ token: process.env.SLACK_BOT_TOKEN, appToken: process.env.SLACK_APP_TOKEN, socketMode: true });
const sessions = new Map();

// ─── tmux state ───────────────────────────────────────────────────────────────
let currentTmuxSession = null;
let tmuxPollingActive = false;
let tmuxStreamChannel = null;
let tmuxStreamTs = null;
let tmuxLiveMsgTs = null;
let lastTmuxOutput = "";
let awaitingPermission = false;

// ─── Permission prompt detection ──────────────────────────────────────────────
const PERMISSION_PATTERNS = [
  /Do you want to proceed\?/i,
  /This command requires approval/i,   // ← 추가
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
  /[❯›]\s*1\./,                        // ← › 추가
];

function detectPermissionRequest(output) {
  return PERMISSION_PATTERNS.some(p => p.test(output));
}

// ─── Parse numbered options from claude-code output ───────────────────────────
function parseOptions(output) {
  // Only look at the section AFTER "Do you want to proceed?"
  const promptIndex = output.search(/Do you want to proceed\?/i);
  const relevant = promptIndex !== -1 ? output.slice(promptIndex) : output;

  const matches = [...relevant.matchAll(/^[\s❯›]*([1-9])\.\s+(.+)/gm)];
  if (matches.length >= 2) {
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
  return {
    options: [
      { number: "1", label: "Yes" },
      { number: "2", label: "No" },
    ],
    parsed: false,  // fallback — actual options could not be parsed
  };
}

function buildPermissionBlocks(output) {
  const { options, parsed } = parseOptions(output);
  const ts = Date.now(); // unique suffix to avoid duplicate action_id errors
  const buttons = options.map(opt => {
    const label = `${opt.number}. ${opt.label}`;
    const truncated = label.length > 75 ? label.slice(0, 72) + "…" : label;
    return {
      type: "button",
      text: { type: "plain_text", text: truncated, emoji: true },
      style: opt.label.toLowerCase().startsWith("no") ? "danger" : "primary",
      action_id: `tmux_option_${opt.number}_${ts}`,  // ← unique per message
      value: opt.number,
    };
  });
  const headerText = parsed
    ? `⚠️ *Claude is requesting permission:*`
    : `⚠️ *Claude is requesting permission:*\n_⚠️ Could not parse options — showing default Yes/No. *Check terminal directly if more options exist.*_`;
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${headerText}\n\`\`\`\n${output.slice(-600)}\n\`\`\``,
      },
    },
    { type: "actions", elements: buttons },
  ];
}

// ─── Background polling loop ──────────────────────────────────────────────────
async function startTmuxPolling(client) {
  if (tmuxPollingActive) return;
  tmuxPollingActive = true;
  lastTmuxOutput = "";
  awaitingPermission = false;
  let awaitingPermissionSince = null;
  let claudeWasWorking = false;
  let responseStartOutput = "";

  while (tmuxPollingActive) {
    await new Promise(r => setTimeout(r, 3000));
    if (!tmuxPollingActive) break;

    let raw;
    try {
      raw = tmuxCapture();
    } catch { break; }

    const stripped = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
    const output = stripped.trim().slice(-8000);

    // Auto-reset if permission prompt disappeared
    if (awaitingPermission && !detectPermissionRequest(output)) {
      awaitingPermission = false;
      awaitingPermissionSince = null;
    }

    // Send reminder every 5 minutes if still awaiting response
    if (awaitingPermission && awaitingPermissionSince) {
      if (Date.now() - awaitingPermissionSince > 300000) {
        await client.chat.postMessage({
          channel: tmuxStreamChannel,
          thread_ts: tmuxStreamTs,
          text: "⏰ *Reminder — Claude is still waiting for your response:*",
          blocks: buildPermissionBlocks(lastTmuxOutput),
        });
        awaitingPermissionSince = Date.now();
      }
    }

    if (output === lastTmuxOutput) continue;
    lastTmuxOutput = output;

    // Track if claude-code is working
    // const isWorking = /Thinking…|Crafting…|Tempering…|Waddling…|Running…|Working…|Twisting…|thinking\)|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/.test(output);
    // const isIdle = /^[❯>]\s*/m.test(output) && !isWorking;

    // if (isWorking && !claudeWasWorking) {
    //   claudeWasWorking = true;
    //   responseStartOutput = output;
    // }

    // // Claude finished responding → send full response
    // if (claudeWasWorking && isIdle && !awaitingPermission) {
    //   claudeWasWorking = false;

    //   const newContent = output.slice(-3000);
    //   const chunks = chunkText(newContent, 2800);

    //   await client.chat.postMessage({
    //     channel: tmuxStreamChannel,
    //     thread_ts: tmuxStreamTs,
    //     text: `💬 *Claude responded:*`,
    //   });

    //   for (const chunk of chunks) {
    //     await client.chat.postMessage({
    //       channel: tmuxStreamChannel,
    //       thread_ts: tmuxStreamTs,
    //       text: `\`\`\`\n${chunk}\n\`\`\``,
    //     });
    //   }

    //   responseStartOutput = "";
    // }

    // Detect new permission request
    if (!awaitingPermission && detectPermissionRequest(output)) {
      awaitingPermission = true;
      awaitingPermissionSince = Date.now();

      if (tmuxLiveMsgTs) {
        try {
          await client.chat.update({
            channel: tmuxStreamChannel,
            ts: tmuxLiveMsgTs,
            text: `\`\`\`\n${output.slice(-2800)}\n\`\`\``,
          });
        } catch {}
      }

      await client.chat.postMessage({
        channel: tmuxStreamChannel,
        thread_ts: tmuxStreamTs,
        text: "⚠️ Claude is requesting permission",
        blocks: buildPermissionBlocks(output),
      });
    }
  }
}

// ─── Button: dynamic option handler (tmux_option_1, _2, _3 ...) ──────────────
app.action(/^tmux_option_(\d+)_\d+$/, async ({ body, ack, client, action }) => {
  await ack();
  if (!currentTmuxSession) return;

  const number = parseInt(action.value);
  for (let i = 0; i < number - 1; i++) {
    execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} Down`);
    await new Promise(r => setTimeout(r, 150));
  }
  execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} Enter`);

  awaitingPermission = false;  // immediately stop reminders

  // Replace buttons with confirmation message
  try {
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `✅ *Responded: option ${number}*`,
      blocks: [],
    });
  } catch {}
});

// ─── /tmux-connect ────────────────────────────────────────────────────────────
app.command("/tmux-connect", async ({ command, ack, client }) => {
  await ack();
  const sessionId = command.text.trim();
  if (!sessionId) {
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Usage: `/tmux-connect <session-index>`\nExample: `/tmux-connect 2`",
    });
    return;
  }

  // Verify session exists
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

  // Stop previous polling if any
  tmuxPollingActive = false;
  await new Promise(r => setTimeout(r, 500));

  currentTmuxSession = sessionId;
  tmuxStreamChannel = command.channel_id;
  awaitingPermission = false;

  // Create thread anchor message
  const anchorMsg = await client.chat.postMessage({
    channel: command.channel_id,
    text: `🔗 *Connected to tmux session \`${sessionId}\`* — monitoring for permission requests.\nUse \`/tmux-status\` to see current output anytime.`,
  });
  tmuxStreamTs = anchorMsg.ts;

  // Post current state once on connect
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

  // Start background polling (permission requests only)
  startTmuxPolling(client);
});

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

// ─── /tmux-disconnect ─────────────────────────────────────────────────────────
app.command("/tmux-disconnect", async ({ command, ack, client }) => {
  await ack();
  tmuxPollingActive = false;
  currentTmuxSession = null;
  await client.chat.postMessage({
    channel: command.channel_id,
    text: "🔌 *Disconnected from tmux session.*",
  });
});

// ─── /tmux — send input to connected session ──────────────────────────────────
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

  awaitingPermission = false;
  tmuxSend(input);

  await client.chat.postMessage({
    channel: command.channel_id,
    thread_ts: tmuxStreamTs,
    text: `⌨️ *Sent:* \`${input}\``,
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sessionKey(channelId, threadTs) { return threadTs ? `${channelId}:${threadTs}` : channelId; }

async function postStatus(client, channel, threadTs, text) {
  return client.chat.postMessage({ channel, thread_ts: threadTs, text, mrkdwn: true });
}

function chunkText(text, maxLen) {
  const chunks = [];
  while (text.length > maxLen) { chunks.push(text.slice(0, maxLen)); text = text.slice(maxLen); }
  chunks.push(text);
  return chunks;
}

async function postWithActions(client, channel, threadTs, text) {
  const chunks = chunkText(text, 2800);
  for (let i = 0; i < chunks.length - 1; i++) await postStatus(client, channel, threadTs, chunks[i]);
  return client.chat.postMessage({
    channel, thread_ts: threadTs, mrkdwn: true, text: "Completed!",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `✅ *Completed!*\n\n${chunks[chunks.length - 1]}` } },
      { type: "actions", elements: [
        { type: "button", text: { type: "plain_text", text: "🚀 New Task", emoji: true }, style: "primary", action_id: "new_task", value: JSON.stringify({ channel, threadTs }) },
        { type: "button", text: { type: "plain_text", text: "🛑 Exit Session", emoji: true }, style: "danger", action_id: "exit_session", value: JSON.stringify({ channel, threadTs }) },
      ]},
    ],
  });
}

// ─── File Reading ─────────────────────────────────────────────────────────────
const CODE_EXTS = new Set([".py",".js",".ts",".jsx",".tsx",".java",".cpp",".c",".h",".go",".rs",".rb",".sh",".yaml",".yml",".json",".toml",".md",".txt",".html",".css",".sql"]);

function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 100 * 1024) return `[File is too large (exceeds 100KB): ${filePath}]`;
    return fs.readFileSync(filePath, "utf-8");
  } catch { return null; }
}

function collectFiles(dirPath, maxFiles = 30) {
  const results = [];
  function walk(current) {
    if (results.length >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith(".") || ["node_modules","__pycache__",".git","dist","build"].includes(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const content = readFileSafe(fullPath);
        if (content !== null) results.push({ path: fullPath, content });
      }
    }
  }
  walk(dirPath);
  return results;
}

function extractPaths(text) {
  const matches = text.match(/\/[^\s`'"，,]+/g) || [];
  return matches.filter(p => { try { fs.accessSync(p); return true; } catch { return false; } });
}

function buildFileContext(paths) {
  if (paths.length === 0) return "";
  let ctx = "\n\n---\nContent of required file/directory contents:\n\n";
  for (const p of paths) {
    let stat;
    try { stat = fs.statSync(p); } catch { ctx += `[Absent path: ${p}]\n`; continue; }
    if (stat.isDirectory()) {
      const files = collectFiles(p);
      if (files.length === 0) { ctx += `[Empty directory: ${p}]\n`; continue; }
      ctx += `### 📁 ${p} (${files.length} files)\n\n`;
      for (const f of files) {
        const ext = path.extname(f.path).slice(1) || "txt";
        ctx += `**${f.path}**\n\`\`\`${ext}\n${f.content}\n\`\`\`\n\n`;
      }
    } else {
      const content = readFileSafe(p);
      if (content === null) { ctx += `[Failed reading file: ${p}]\n`; continue; }
      const ext = path.extname(p).slice(1) || "txt";
      ctx += `**${p}**\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
    }
  }
  return ctx;
}

// ─── File Writing ─────────────────────────────────────────────────────────────
function parseAndApplyWrites(responseText) {
  const writeRegex = /<<<WRITE:([^>]+)>>>\n([\s\S]*?)<<<END>>>/g;
  const written = [];
  let match;
  while ((match = writeRegex.exec(responseText)) !== null) {
    const filePath = match[1].trim();
    const content = match[2];
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, "utf-8");
      written.push(filePath);
    } catch (e) {
      written.push(`[Failed writing: ${filePath} — ${e.message}]`);
    }
  }
  const cleaned = responseText.replace(/<<<WRITE:[^>]+>>>\n[\s\S]*?<<<END>>>/g, "").trim();
  return { cleaned, written };
}

// ─── Shell Execution ──────────────────────────────────────────────────────────
function parseAndRunShell(responseText) {
  const shellRegex = /<<<SHELL(?::([^>]+))?>>>\n([\s\S]*?)<<<END>>>/g;
  const results = [];
  let match;
  while ((match = shellRegex.exec(responseText)) !== null) {
    const cwd = match[1] ? match[1].trim() : process.cwd();
    const commands = match[2].trim();
    const tmpFile = `/tmp/claude_shell_${Date.now()}.sh`;
    try {
      fs.writeFileSync(tmpFile, commands, "utf-8");
      const output = execSync(`bash ${tmpFile}`, { cwd, encoding: "utf-8", timeout: 30000 });
      results.push({ commands, output: output.trim() || "(no output)", success: true });
    } catch (e) {
      results.push({ commands, output: (e.stderr || e.message).trim(), success: false });
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
  const cleaned = responseText.replace(/<<<SHELL(?::[^>]+)?>>>\n[\s\S]*?<<<END>>>/g, "").trim();
  return { cleaned, results };
}

// ─── System Prompt ────────────────────────────────────────────────────────────
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

// ─── Claude API Call ──────────────────────────────────────────────────────────
function getTmuxTarget(sessionId) {
  // If already has window/pane spec, use as-is
  if (sessionId.includes(":")) return sessionId;
  // Otherwise default to window 0, pane 0
  return `${sessionId}:0.0`;
}

function tmuxSend(text) {
  execSync(`tmux send-keys -t ${getTmuxTarget(currentTmuxSession)} ${JSON.stringify(text)} Enter`);
}

function tmuxCapture() {
  const raw = execSync(
    `tmux capture-pane -t ${getTmuxTarget(currentTmuxSession)} -p -S -1000`,
    { encoding: "utf-8" }
  );
  return raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

async function runTask(client, channel, threadTs, userPrompt, existingMessages = []) {
  const key = sessionKey(channel, threadTs);
  sessions.set(key, { messages: existingMessages, aborted: false });

  const detectedPaths = extractPaths(userPrompt);
  if (detectedPaths.length > 0) {
    await postStatus(client, channel, threadTs, `📂 Path: \`${detectedPaths.join(", ")}\` — Reading files…`);
  }
  await postStatus(client, channel, threadTs, `⚙️ *Working…*\n> ${userPrompt}`);

  const fileContext = buildFileContext(detectedPaths);
  const messages = [...existingMessages, { role: "user", content: userPrompt + fileContext }];

  try {
    const session = sessions.get(key);
    if (session.aborted) return;

    const stream = await anthropic.messages.stream({
      model: MODEL,
      max_tokens: 24000,
      system: SYSTEM_PROMPT,
      messages,
    });

    const response = await stream.finalMessage();
    const rawText = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim() || "_(no output)_";

    const { cleaned: afterWrite, written } = parseAndApplyWrites(rawText);
    const { cleaned: finalText, results: shellResults } = parseAndRunShell(afterWrite);

    let summary = finalText;
    if (written.length > 0) {
      summary += `\n\n📝 *Saved files:*\n${written.map(f => `• \`${f}\``).join("\n")}`;
    }
    for (const r of shellResults) {
      const icon = r.success ? "✅" : "❌";
      summary += `\n\n${icon} *Shell output:*\n\`\`\`\n$ ${r.commands}\n${r.output}\n\`\`\``;
    }

    if (sessions.has(key)) {
      sessions.get(key).messages = [...existingMessages, { role: "user", content: userPrompt }, { role: "assistant", content: rawText }];
    }

    await postWithActions(client, channel, threadTs, summary || "_Completed_");
  } catch (err) {
    console.error("API error:", err);
    await postStatus(client, channel, threadTs, `❌ *Error:* ${err.message}`);
    sessions.delete(key);
  }
}

// ─── /claude command ──────────────────────────────────────────────────────────
app.command("/claude", async ({ command, ack, client }) => {
  await ack();
  const task = command.text.trim();
  if (!task) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id,
      text: "Usage: `/claude <task>`\nExamples:\n• `/claude /path/to/repo review the code`\n• `/claude /path/to/repo fix bug in main.py and push`"
    });
    return;
  }
  const initMsg = await client.chat.postMessage({ channel: command.channel_id, text: `🤖 *Claude session* — <@${command.user_id}> started this session` });
  await runTask(client, command.channel_id, initMsg.ts, task);
});

// ─── Thread replies → continue session ───────────────────────────────────────
app.message(async ({ message, client }) => {
  if (message.subtype === "bot_message" || !message.thread_ts) return;

  const text = message.text && message.text.trim();
  if (!text) return;

  // Inside tmux stream thread
  if (currentTmuxSession && message.thread_ts === tmuxStreamTs && message.channel === tmuxStreamChannel) {

    // "tmux-status" → show current output
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
    
    // "status" → show claude-code /status output
    if (text.toLowerCase() === "status") {
      try {
        const output = execSync(`tmux send-keys -t ${currentTmuxSession} '/status' Enter`, { encoding: "utf-8" });
        await new Promise(r => setTimeout(r, 2000));
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

    // "? <question>" → Claude API call (no file reading, truncated output)
    if (text.startsWith("?")) {
      const prompt = text.slice(1).trim();

      await postStatus(client, message.channel, message.thread_ts, `⚙️ *Working…*\n> ${prompt}`);

      try {
        const stream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: 3000,  // short answer
          system: "You are a helpful assistant. Be concise. Answer in 3-5 sentences max unless code is required.",
          messages: [{ role: "user", content: prompt }],
        });
        const response = await stream.finalMessage();
        const answer = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();

        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.thread_ts,
          text: answer.slice(0, 2800),  // max one message
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

    // Otherwise → send to tmux
    awaitingPermission = false;
    tmuxSend(text);
    return;
  }

  // Regular Claude API session thread
  const key = sessionKey(message.channel, message.thread_ts);
  const session = sessions.get(key);
  if (!session || !message.text) return;
  await runTask(client, message.channel, message.thread_ts, text, session.messages);
});

// ─── Button: New Task / Exit Session ─────────────────────────────────────────
app.action("new_task", async ({ body, ack, client }) => {
  await ack();
  const { channel, threadTs } = JSON.parse(body.actions[0].value);
  await postStatus(client, channel, threadTs, "💬 Please input next task!");
});

app.action("exit_session", async ({ body, ack, client }) => {
  await ack();
  const { channel, threadTs } = JSON.parse(body.actions[0].value);
  const key = sessionKey(channel, threadTs);
  const session = sessions.get(key);
  if (session) { session.aborted = true; sessions.delete(key); }
  await postStatus(client, channel, threadTs, "👋 *Session ended.* Use `/claude <task>` to start a new one.");
});

(async () => {
  await app.start();
  console.log("⚡ Claude ↔ Slack running! (read + write + shell + tmux enabled)");

  // Auto-reconnect on unexpected crash
  process.on("uncaughtException", async (err) => {
    console.error("Uncaught exception:", err.message);
    if (err.message.includes("Unhandled event")) {
      console.log("Restarting in 5 seconds...");
      setTimeout(() => process.exit(1), 5000);
    }
  });
})();
