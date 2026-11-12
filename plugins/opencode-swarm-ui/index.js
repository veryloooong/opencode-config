/**
 * OpenCode Swarm UI — server plugin.
 *
 * Reads the swarm orchestrator's state directory (`.swarm/`: `latest.json` plus hashed
 * `swarm-<hash>.json` runs), overlays live in-memory subagent events, and serves it three
 * ways: the `SwarmRpc` snapshot/selectRun RPC (the TUI sidebar and status window), the
 * `/swarm_status` slash command (Web/Desktop), and a Unicode fleet-status box report.
 * Reports are posted with the same zero-context-pollution pattern as @slkiser/opencode-quota:
 * `delivery: "steer"`, `resume: false`, a metadata key to drop the message by, and
 * `[OpenCode Swarm status]` fences to cut it back out of compaction checkpoints.
 */
// Plugin.define is identity in OpenCode V2 (returns the { id, setup } definition), so keep a
// local shim instead of importing @opencode/plugin, which is unresolvable outside the host.
const Plugin = { define: (definition) => definition };
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SwarmRpc } from "./rpc.js";

export const SWARM_REPORT_METADATA_KEY = "opencodeSwarm";
export const SWARM_REPORT_START = "[OpenCode Swarm status]";
export const SWARM_REPORT_END = "[End of OpenCode Swarm status]";
/** Compaction checkpoints copy message text without metadata; the fences cut reports back out. */
const SWARM_REPORT_BLOCKS = /\[OpenCode Swarm status\][\s\S]*?\[End of OpenCode Swarm status\]/g;

const SWARM_DIR = ".swarm";
const RUN_FILE = /^swarm-([0-9A-Za-z]+)\.json$/;
const REPORT_WIDTH = 80;

const STAGES = [
  ["recon", "Recon"],
  ["plan", "Plan"],
  ["execute", "Execute"],
  ["verify", "Verify"],
  ["commit", "Commit"],
];
const STATUS_BADGE = {
  running: "● RUNNING",
  completed: "✓ COMPLETED",
  failed: "✗ FAILED",
  idle: "○ IDLE",
};
const STATUS_ICON = { running: "●", completed: "✓", failed: "✗", idle: "○" };
const TASK_ICON = { done: "✓", running: "●", failed: "✗", pending: "○" };
const RUN_STATUSES = new Set(["running", "completed", "failed", "idle"]);
const TASK_STATUSES = new Set(["done", "running", "pending", "failed"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function num(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 8-char hex SHA-256 of the objective (plus optional salt) — the swarm run id. */
export function computeSwarmHash(objective, salt = "") {
  return crypto
    .createHash("sha256")
    .update(`${salt}${String(objective)}`)
    .digest("hex")
    .slice(0, 8);
}

/** ISO-8601 strings (as written by commands/swarm.md) and numeric epoch ms both accepted. */
function parseTime(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackMs;
}

function normalizeTask(task, waveNum = undefined) {
  const record = isRecord(task) ? task : {};
  return {
    id: str(record.id, "?"),
    agent: str(record.agent, "—"),
    status: record.status === "completed" ? "done" : TASK_STATUSES.has(record.status) ? record.status : "pending",
    wave: num(record.wave, num(waveNum, 1)),
    files: (
      Array.isArray(record.files_touched) ? record.files_touched : Array.isArray(record.files) ? record.files : []
    ).filter((file) => typeof file === "string"),
    description: str(record.description, ""),
  };
}

function normalizeRun(record, fallbackId, updatedAtMs) {
  const source = isRecord(record) ? record : {};
  const objective = str(source.objective, "(no objective recorded)");
  const id =
    str(source.id, fallbackId ?? computeSwarmHash(objective)).replace(/^#/, "").slice(0, 8).toLowerCase();
  const waveRecord = isRecord(source.wave) ? source.wave : {};
  const tasks = [
    ...(Array.isArray(source.waves)
      ? source.waves.flatMap((wave, index) => {
          const entry = isRecord(wave) ? wave : {};
          const waveNum = num(entry.wave, index + 1);
          return (Array.isArray(entry.tasks) ? entry.tasks : []).map((task) =>
            normalizeTask({ ...task, wave: entry.wave ?? index + 1 }, waveNum),
          );
        })
      : []),
    ...(Array.isArray(source.tasks) ? source.tasks.map((task) => normalizeTask(task)) : []),
  ];
  return {
    id,
    objective,
    status: RUN_STATUSES.has(source.status) ? source.status : "running",
    stage: str(source.currentStage ?? source.stage, "execute").toLowerCase(),
    stages: isRecord(source.stages) ? source.stages : undefined,
    createdAt: parseTime(source.createdAt, updatedAtMs),
    updatedAt: parseTime(source.updatedAt, updatedAtMs),
    wave: {
      current: Math.max(0, num(source.currentWave ?? waveRecord.current ?? source.wave, 0)),
      total: Math.max(
        0,
        num(source.totalWaves ?? waveRecord.total, Array.isArray(source.waves) ? source.waves.length : 0),
      ),
    },
    tasks,
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Every hashed `.swarm/swarm-<hash>.json` run, newest first. */
export function readSwarmRuns(swarmDir) {
  let names = [];
  try {
    names = fs.readdirSync(swarmDir);
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    const match = RUN_FILE.exec(name);
    if (!match) continue;
    const file = path.join(swarmDir, name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {}
    const record = readJsonFile(file);
    if (record === undefined) continue;
    runs.push(normalizeRun(record, match[1].toLowerCase(), mtimeMs));
  }
  runs.sort((a, b) => b.updatedAt - a.updatedAt);
  return runs;
}

function readLatestRun(swarmDir) {
  const record = readJsonFile(path.join(swarmDir, "latest.json"));
  return record === undefined ? null : normalizeRun(record, undefined, Date.now());
}

/** Overlays this process's live subagent tasks onto a run read from disk. */
function mergeLive(run, liveTasks) {
  if (!run || !liveTasks || liveTasks.size === 0) return run;
  const byId = new Map(run.tasks.map((task) => [task.id, task]));
  for (const task of liveTasks.values()) {
    const existing = byId.get(task.id);
    byId.set(task.id, existing ? { ...existing, ...task, files: task.files.length > 0 ? task.files : existing.files } : task);
  }
  return { ...run, tasks: [...byId.values()] };
}

/**
 * The full snapshot. `live` maps run id ("" = whatever is active) to a Map of task id → task
 * patched from live subagent events in this process.
 */
function buildSnapshot(swarmDir, live) {
  const runs = readSwarmRuns(swarmDir);
  let active = readLatestRun(swarmDir);
  if (!active) active = runs.find((run) => run.status === "running") ?? null;
  // Live events recorded under "" belong to whatever is active; under a run id to that run.
  if (active) active = mergeLive(mergeLive(active, live.get("")), live.get(active.id) ?? new Map());
  const runsWithLive = runs.map((run) => (live.has(run.id) ? mergeLive(run, live.get(run.id)) : run));
  if (active) {
    const index = runsWithLive.findIndex((run) => run.id === active.id);
    if (index >= 0) runsWithLive[index] = active;
    else runsWithLive.unshift(active);
  }
  const updatedAt = Date.now();
  const snapshot = { active, runs: runsWithLive, updatedAt };
  return { ...snapshot, reportText: formatSwarmStatusBox(snapshot) };
}

/** Records one subagent bus event as a task patch; returns true when something was stored. */
function trackLiveEvent(live, event) {
  const data = isRecord(event.data) ? event.data : {};
  const runKey =
    ["runId", "swarmId"]
      .map((key) => data[key])
      .find((value) => typeof value === "string")
      ?.replace(/^#/, "")
      .slice(0, 8)
      .toLowerCase() ?? "";
  const type = str(event.type);
  const task = normalizeTask({
    id: data.taskId ?? data.id ?? data.subagentID,
    agent: data.agent ?? data.model,
    // Event type names vary across versions; classify from the type string itself.
    status: /end|finish|complet|success/i.test(type) ? "done" : /fail|error|abort/i.test(type) ? "failed" : "running",
    wave: data.wave,
    files: data.files,
    description: data.description ?? type,
  });
  if (task.id === "?" && task.agent === "—") return false;
  const bucket = live.get(runKey) ?? new Map();
  bucket.set(task.id, task);
  live.set(runKey, bucket);
  return true;
}

/**
 * Watches `.swarm/` and calls `onChange` (debounced) when a file changes. Retries every 5s
 * while the directory does not exist, so a swarm starting later is still picked up.
 */
function watchSwarmDir(swarmDir, onChange) {
  let stopped = false;
  let watcher;
  let retryTimer;
  let debounce;
  const start = () => {
    if (stopped) return;
    try {
      watcher = fs.watch(swarmDir, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          onChange();
        }, 150);
      });
      watcher.on("error", retry);
    } catch {
      retry();
    }
  };
  const retry = () => {
    watcher?.close();
    watcher = undefined;
    if (!stopped) retryTimer = setTimeout(start, 5_000);
  };
  start();
  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
  };
}

// ---------------------------------------------------------------------------------------------
// The Unicode fleet-status box
// ---------------------------------------------------------------------------------------------

function truncate(text, width) {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}
function pad(text, width) {
  return truncate(text, width).padEnd(width);
}
function formatTime(ms) {
  return num(ms) > 0 ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—";
}
function timeAgo(ms) {
  const seconds = Math.max(0, (Date.now() - num(ms)) / 1000);
  if (seconds < 60) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Per-stage state: explicit `stages` map wins, else derived from the current stage + status. */
function stageStates(run) {
  const keys = STAGES.map(([key]) => key);
  if (isRecord(run.stages)) {
    return keys.map((key) => {
      const value = str(run.stages[key]).toLowerCase();
      if (["done", "complete", "completed"].includes(value)) return "done";
      if (["active", "running", "current"].includes(value)) return "active";
      if (["failed", "error"].includes(value)) return "failed";
      return "pending";
    });
  }
  let current = keys.indexOf(run.stage);
  // "done" is not a pipeline stage: a finished run shows every stage completed.
  if (run.stage === "done") return keys.map(() => "done");
  if (current < 0) current = 2; // a run without a stage is most likely executing
  return keys.map((_, index) => {
    if (run.status === "completed") return "done";
    if (index < current) return "done";
    if (index === current) return run.status === "failed" ? "failed" : run.status === "running" ? "active" : "pending";
    return "pending";
  });
}

/** `[✓ Recon] ━━▶ [✓ Plan] ━━▶ [● Execute] ──▶ [○ Verify] ──▶ [○ Commit]` */
function pipelineLine(run) {
  const states = stageStates(run);
  const parts = STAGES.map(([, label], index) => {
    const state = states[index];
    const icon = state === "done" ? "✓" : state === "active" ? "●" : state === "failed" ? "✗" : "○";
    return `[${icon} ${label}]`;
  });
  let line = parts[0];
  for (let index = 1; index < parts.length; index += 1) {
    line += `${states[index - 1] === "done" ? " ━━▶ " : " ──▶ "}${parts[index]}`;
  }
  return line;
}

export function barParts(done, total, width = 20) {
  const filled = total > 0 ? Math.max(0, Math.min(width, Math.round((done / total) * width))) : 0;
  return ["━".repeat(filled), "─".repeat(Math.max(0, width - filled))];
}
function progressBar(done, total, width = 20) {
  const [full, empty] = barParts(done, total, width);
  return full + empty;
}

const TABLE_HEADS = ["Task ID", "Agent", "Status", "Files"];
const TABLE_CAPS = [10, 16, 12, 5];

function taskTableRows(tasks, inner) {
  const cells = tasks.map((task) => [
    task.id,
    task.agent,
    `${TASK_ICON[task.status] ?? "○"} ${task.status}`,
    String(task.files.length),
  ]);
  const widths = TABLE_HEADS.map(
    (head, column) => Math.min(TABLE_CAPS[column], Math.max(head.length, ...cells.map((row) => row[column].length))),
  );
  const fixed = widths.reduce((total, width) => total + width + 3, 0);
  const descriptionWidth = Math.max(8, inner - fixed);
  const rows = [`${TABLE_HEADS.map((head, column) => pad(head, widths[column])).join(" | ")} | ${pad("Description", descriptionWidth)}`];
  rows.push("─".repeat(inner));
  tasks.forEach((task, index) => {
    rows.push(
      `${cells[index].map((cell, column) => pad(cell, widths[column])).join(" | ")} | ${pad(task.description, descriptionWidth)}`,
    );
  });
  return rows;
}

function waveGroups(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = num(task.wave, 0) > 0 ? num(task.wave, 0) : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  return [...groups.entries()].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

/**
 * Renders the fleet-status GUI. `snapshot` is `{ active, runs }` (a full snapshot works too);
 * `selectedId` picks a hashed run as the subject (as `/swarm_status <hash>` and the History
 * tab do) and marks it in the runs list.
 */
export function formatSwarmStatusBox(snapshot, selectedId, width = REPORT_WIDTH) {
  const runs = Array.isArray(snapshot?.runs) ? snapshot.runs : [];
  const wanted = selectedId ? String(selectedId).replace(/^#/, "").toLowerCase() : undefined;
  const selected = wanted ? runs.find((run) => run.id === wanted) : undefined;
  const subject = selected ?? (isRecord(snapshot?.active) ? snapshot.active : runs[0]);
  const inner = Math.max(40, width - 4);
  const lines = [];
  const row = (text = "") => `┃ ${pad(String(text), inner)} ┃`;
  const rule = (edge) => `${edge}${"━".repeat(width - 2)}${edge === "┏" ? "┓" : "┛"}`;

  lines.push(rule("┏"));
  if (!subject) {
    lines.push(row("No swarm state found."));
    lines.push(row(""));
    lines.push(row(`Looking for ${SWARM_DIR}/latest.json and ${SWARM_DIR}/swarm-<hash>.json files.`));
    lines.push(rule("┗"));
    return lines.join("\n");
  }

  const badge = STATUS_BADGE[subject.status] ?? `● ${String(subject.status).toUpperCase()}`;
  lines.push(row(`SWARM FLEET STATUS  [#${subject.id}]  ${badge}`));
  if (wanted && !selected) lines.push(row(`(run #${wanted} not found in ${SWARM_DIR}/ — showing the latest instead)`));
  lines.push(row("━".repeat(inner)));
  lines.push(row(`Objective  ${subject.objective}`));
  const times = [];
  if (subject.createdAt) times.push(`Created ${formatTime(subject.createdAt)}`);
  if (subject.updatedAt) times.push(`Updated ${formatTime(subject.updatedAt)} (${timeAgo(subject.updatedAt)})`);
  if (times.length > 0) lines.push(row(times.join("  ·  ")));

  lines.push(row(""));
  lines.push(row("Stages"));
  lines.push(row(pipelineLine(subject)));

  const tasks = Array.isArray(subject.tasks) ? subject.tasks : [];
  const done = tasks.filter((task) => task.status === "done").length;
  const waveLabel =
    subject.wave && subject.wave.total > 0 ? `Wave ${subject.wave.current}/${subject.wave.total}` : "Wave —";
  const percent = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;
  lines.push(row(""));
  lines.push(row(`${waveLabel}   ${progressBar(done, tasks.length)} ${percent}% (${done}/${tasks.length} tasks)`));

  for (const [wave, waveTasks] of waveGroups(tasks)) {
    lines.push(row(""));
    lines.push(row(wave === null ? "Tasks" : `Wave ${wave}`));
    for (const tableRow of taskTableRows(waveTasks, inner)) lines.push(row(tableRow));
  }

  if (runs.length > 0) {
    lines.push(row(""));
    lines.push(row(`Recent runs (${SWARM_DIR}/)`));
    for (const run of runs.slice(0, 8)) {
      const mark = run.id === subject.id ? "▸" : " ";
      lines.push(
        row(
          `${mark} #${run.id}  ${STATUS_ICON[run.status] ?? "○"} ${pad(run.status, 10)} ${pad(timeAgo(run.updatedAt), 9)} ${run.objective}`,
        ),
      );
    }
  }
  lines.push(rule("┗"));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Zero-context-pollution: strip swarm reports from every model request built from history
// ---------------------------------------------------------------------------------------------

function hasSwarmReportText(part) {
  return part.type === "text" && typeof part.text === "string" && part.text.includes(SWARM_REPORT_START);
}

/**
 * Drops swarm report messages, found by their metadata, and cuts reports out of the text of
 * the remaining user messages. The cut covers compaction checkpoints, which hold copied
 * message text without its metadata, and title requests, which get plain text only.
 */
function withoutSwarmReports(messages) {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [message];
    if (message.metadata?.[SWARM_REPORT_METADATA_KEY] !== undefined) return [];
    if (!Array.isArray(message.content) || !message.content.some(hasSwarmReportText)) return [message];
    const content = message.content.map((part) =>
      hasSwarmReportText(part) ? { ...part, text: part.text.replace(SWARM_REPORT_BLOCKS, "") } : part,
    );
    return [{ ...message, content }];
  });
}

// ---------------------------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------------------------

const swarmServerPlugin = Plugin.define({
  id: "veryloooong.opencode-swarm-ui.server",
  async setup(ctx) {
    const swarmDir = path.join(ctx.location.directory, SWARM_DIR);
    const live = new Map();
    const warn = (what, error) =>
      console.warn(`[opencode-swarm-ui] ${what}: ${error instanceof Error ? error.message : String(error)}`);

    // Awaited so the plugin is active only once the RPC is registered: OpenCode waits for
    // activation before it routes an RPC call, so the first TUI call cannot miss it.
    const registration = await ctx.rpc.register(SwarmRpc, {
      snapshot: () => buildSnapshot(swarmDir, live),
      selectRun: (input) => {
        const id = String(input.id).replace(/^#/, "").toLowerCase();
        const runs = readSwarmRuns(swarmDir);
        const run = runs.find((candidate) => candidate.id === id) ?? null;
        return {
          run,
          reportText: run
            ? formatSwarmStatusBox({ active: run, runs, updatedAt: Date.now() })
            : `No swarm run #${id} found under ${SWARM_DIR}/.`,
        };
      },
    });

    const emitChanged = () => {
      void (async () => {
        try {
          await registration.events.emit("changed", buildSnapshot(swarmDir, live));
        } catch (error) {
          warn("changed event failed", error);
        }
      })();
    };
    const stopWatch = watchSwarmDir(swarmDir, emitChanged);

    // Live subagent events (this process) overlay the file state between writes. Event type
    // names vary across OpenCode versions, so take them all and filter by name here.
    const liveEvents = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: liveEvents.signal })) {
          if (typeof event.type !== "string" || !event.type.includes("subagent")) continue;
          if (trackLiveEvent(live, event)) emitChanged();
        }
      } catch (error) {
        if (!liveEvents.signal.aborted) warn("event subscription stopped", error);
      }
    })();

    // Web and Desktop list this in their "/" menu and get the report as a chat message. The
    // TUI intercepts a typed /swarm_status and opens its status window instead.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "swarm_status",
        description: "Swarm fleet status GUI (optional argument: a run hash, /swarm_status <id>).",
        async execute(invocation) {
          const argument = str(invocation.prompt?.text).trim().split(/\s+/)[0];
          const selectedId = argument ? argument.replace(/^#/, "").toLowerCase() : undefined;
          const snapshot = buildSnapshot(swarmDir, live);
          const report = formatSwarmStatusBox(snapshot, selectedId);
          // A message admitted while the AI works is delivered into that turn at its next
          // step. Wait until the session is idle.
          await ctx.session.wait({ sessionID: invocation.sessionID });
          // resume: false admits the report without starting a model turn; "steer" delivers
          // it together with the user's next message, never on its own.
          await ctx.session.prompt({
            sessionID: invocation.sessionID,
            text: `${SWARM_REPORT_START}\n${report}\n${SWARM_REPORT_END}`,
            metadata: { [SWARM_REPORT_METADATA_KEY]: { command: "swarm_status", at: Date.now() } },
            delivery: "steer",
            resume: false,
          });
        },
      });
    });

    // Keep swarm reports out of every model request built from session history: normal
    // turns, compaction summaries, and generate requests — zero context window pollution.
    for (const hook of ["context", "compaction", "generate"]) {
      await ctx.session.hook(hook, (event) => {
        event.messages = withoutSwarmReports(event.messages);
      });
    }
    // OpenCode titles a new session from its first user message, which can be a report.
    // With nothing else to title from, skip the title request and keep the default title.
    await ctx.session.hook("title", (event) => {
      if (!event.messages.some((message) => Array.isArray(message.content) && message.content.some(hasSwarmReportText)))
        return;
      event.messages = withoutSwarmReports(event.messages);
      const textLeft = event.messages.some(
        (message) => Array.isArray(message.content) && message.content.some((part) => part.type === "text" && part.text.trim() !== ""),
      );
      if (!textLeft) event.result = "";
    });

    return () => {
      liveEvents.abort();
      stopWatch();
    };
  },
});

export default swarmServerPlugin;
