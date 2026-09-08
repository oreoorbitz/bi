#!/usr/bin/env node
// emit.mjs — fixture emitter for the bi#187 spike. Replays a scripted
// coding-agent session as newline-delimited JSON-RPC over stdio — the six
// channels the real bi host already has (see README.md for shapes).
//
//   host→UI: stdout (NDJSON events + one picker/open request)
//   UI→host: stdin  (input/submit notifications, picker responses)
//
// Plain node, zero deps, NOT wired into bi. Flags:
//   --fast          all pacing delays → 0
//   --no-picker     skip the picker/open request
//   --picker-timeout-ms N   give up waiting for a picker answer (default 30000)
//
// Back-channel traffic is logged to stderr (named, never silent).

const args = new Set(process.argv.slice(2));
const fast = args.has("--fast");
const noPicker = args.has("--no-picker");
const pickerTimeoutMs = Number(
  (process.argv.find((a) => a.startsWith("--picker-timeout-ms=")) || "")
    .split("=")[1] || 30000,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, fast ? 0 : ms));

let seq = 0;
function notify(method, params) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
  );
}
function request(id, method, params) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
}

// --- back-channel reader ---------------------------------------------------
const pending = new Map(); // id -> resolve
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error(`[emit] back-channel: bad NDJSON line (dropped): ${e.message}`);
      continue;
    }
    if (msg.method === "input/submit") {
      console.error(`[emit] input/submit: ${JSON.stringify(msg.params.text)}`);
    } else if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      console.error(`[emit] back-channel: unexpected message: ${line}`);
    }
  }
});

function awaitResponse(id, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        console.error(`[emit] picker/open id=${id}: TIMED OUT after ${timeoutMs}ms (continuing)`);
        resolve(null);
      }
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer); // an answered timer must not hold the event loop open
      resolve(msg);
    });
  });
}

// --- scripted session --------------------------------------------------------
const STREAM_A =
  "I'll trace the session restore path first, then run the offline " +
  "plumbing tests so we have a green baseline before touching anything.";

const STREAM_B =
  "Tests are green. The restore bug is in the history fold — " +
  "I have three options for how to proceed.";

const TURN_MARKDOWN = [
  "# Turn summary",
  "",
  "Restored the session history fold and verified:",
  "",
  "- `baml test --project bi` — 110 passed",
  "- scrollback survives (no DECSTBM anywhere)",
  "",
  "Picked follow-up: see the picker answer on the back-channel.",
].join("\n");

async function stream(text, chunk = 12, delayMs = 40) {
  for (let i = 0; i < text.length; i += chunk) {
    notify("assistant/delta", { text: text.slice(i, i + chunk) });
    await sleep(delayMs);
  }
}

async function main() {
  notify("footer/frame", {
    provider: "anthropic",
    model: "claude-sonnet-4.5",
    thinking: "high",
    tokensIn: 12413,
    tokensOut: 0,
    cwd: "~/code/orion/orion-learn-baml",
  });
  notify("agent/event", { kind: "spinner_start", label: "Thinking…" });
  await sleep(600);

  notify("agent/event", { kind: "status", label: "Reading session files" });
  await stream(STREAM_A);
  await sleep(200);

  notify("tool/start", { id: "t1", name: "bash", summary: "baml test --project bi" });
  notify("agent/event", { kind: "status", label: "Running baml test --project bi" });
  await sleep(900);
  notify("tool/done", { id: "t1", ok: true, line: "bash: baml test --project bi (110 passed, 1.2s)" });
  await sleep(150);

  notify("agent/event", { kind: "status", label: "Composing options" });
  await stream(STREAM_B);

  if (!noPicker) {
    const id = ++seq;
    request(id, "picker/open", {
      title: "Pick a follow-up",
      items: [
        { id: "fix-181", label: "Fix bi#181 prompt glyph", description: "restore the `>` at col 2" },
        { id: "run-drills", label: "Run the pty drill family", description: "split-CSI, paste, SIGWINCH" },
        { id: "write-docs", label: "Document the seam", description: "protocol draft for bi#188" },
      ],
    });
    const answer = await awaitResponse(id, pickerTimeoutMs);
    if (answer && answer.result) {
      console.error(`[emit] picker answer: ${JSON.stringify(answer.result)}`);
      notify("agent/event", {
        kind: "status",
        label: `Follow-up chosen: ${answer.result.itemId}`,
      });
    } else if (answer && answer.error) {
      console.error(`[emit] picker cancelled: ${JSON.stringify(answer.error)}`);
      notify("agent/event", { kind: "status", label: "Picker cancelled" });
    }
  }
  await sleep(300);

  notify("agent/event", { kind: "spinner_stop", label: "" });
  notify("turn/result", { markdown: TURN_MARKDOWN });
  notify("footer/frame", {
    provider: "anthropic",
    model: "claude-sonnet-4.5",
    thinking: "high",
    tokensIn: 12987,
    tokensOut: 643,
    cwd: "~/code/orion/orion-learn-baml",
  });
  await sleep(200);
  // EOF on stdout is the session-end signal. The stdin "data" listener
  // keeps node's event loop alive, so unref stdin explicitly: the process
  // then exits naturally once stdout is flushed (process.exit() could
  // truncate the pipe).
  process.stdin.unref?.();
}

main().catch((e) => {
  console.error(`[emit] fatal: ${e.stack || e}`);
  process.exit(1);
});
