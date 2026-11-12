import { createComponent as _$createComponent } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
/**
 * OpenCode Swarm UI — TUI plugin.
 *
 * Draws the swarm state the server plugin reads from `.swarm/`:
 *   - the Swarm Fleet panel in the session sidebar (click the title to collapse it),
 *   - the status window above the message box, opened by a typed /swarm_status (intercepted
 *     here, so nothing reaches the chat or the context window) or by the command palette
 *     ("Swarm: Status Window"). Tabs: [1] Active Swarm (the Unicode fleet-status box),
 *     [2] Waves & Tasks, [3] Hashed History (.swarm/) with ↑/↓ cycling the hashed runs.
 *
 * Data comes over the Swarm RPC: the `snapshot` call on mount, every `changed` event, and a
 * 2s poll while a swarm is running (or while the window is open) in case an event was missed.
 */
// Plugin.define is identity in OpenCode V2 (returns the { id, setup } definition), so keep a
// local shim instead of importing @opencode/plugin/tui, unresolvable outside the host.
const Plugin = { define: (definition) => definition };
import { createSignal, onCleanup, Show } from "solid-js";
import { SwarmRpc } from "./rpc.js";

const POLL_MS = 2_000;
/** Above OpenCode's textarea layer, which submits the prompt on Enter. */
const TYPED_COMMAND_PRIORITY = 1;
const WINDOW_KEY_PRIORITY = 10;
const WINDOW_TITLE = "Swarm Fleet Status";
const KEYS = "Swarm window";
const TABS = [
  ["active", "[1] Active Swarm"],
  ["waves", "[2] Waves & Tasks"],
  ["history", "[3] Hashed History (.swarm/)"],
];
const TASK_ICON = { done: "✓", completed: "✓", running: "●", failed: "✗", pending: "○" };
const STATUS_ICON = { running: "●", completed: "✓", failed: "✗", idle: "○" };

/** RPC calls reject with a plain `{ type, message }` object, not an Error. */
function rpcErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return String(error);
}
function reportFailure(error) {
  // OpenCode answers rpc.unavailable when no server plugin registered the swarm RPC here.
  const hint =
    typeof error === "object" && error !== null && "type" in error && error.type === "rpc.unavailable"
      ? " (the swarm server plugin is not loaded for this folder)"
      : "";
  console.warn(`[opencode-swarm-ui] failed to load swarm state: ${rpcErrorMessage(error)}${hint}`);
}

function statusColor(theme, status) {
  if (status === "running") return theme.text.action.primary.selected;
  if (status === "done" || status === "completed") return theme.text.feedback.success.base;
  if (status === "failed") return theme.text.feedback.error.base;
  return theme.text.muted;
}
function barParts(done, total, width = 16) {
  const filled = total > 0 ? Math.max(0, Math.min(width, Math.round((done / total) * width))) : 0;
  return ["━".repeat(filled), "─".repeat(Math.max(0, width - filled))];
}
function percent(done, total) {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}
/** Splits a report line holding a ━/─ task bar into its segments; null when it has no bar. */
function barSegments(line) {
  const match = /^(.*?)(━+)(─+)(.*)$/.exec(line);
  return match ? { before: match[1], full: match[2], empty: match[3], after: match[4] } : null;
}
/** A bar's spans, LineText-style: filled part in the run's color, the rest muted. */
function barSpans(api, status, before, full, empty, after) {
  const theme = () => api.theme;
  const span = (text, fg) => {
    var _s = _$createElement("span");
    _$insert(_s, () => text);
    _$effect((_$p) => _$setProp(_s, "style", { fg }, _$p));
    return _s;
  };
  return [
    ...(before ? [span(before, theme().text.base)] : []),
    span(full, statusColor(theme(), status)),
    span(empty, theme().text.muted),
    ...(after ? [span(after, theme().text.muted)] : []),
  ];
}
function stageLabel(run) {
  const stage = typeof run?.stage === "string" && run.stage ? run.stage : "execute";
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}
function waveText(run) {
  const wave = run?.wave;
  return wave && wave.total > 0 ? `${wave.current}/${wave.total}` : "—";
}

/** One plain line of a surface, in one color. */
function TextLine(props) {
  return (() => {
    var _el = _$createElement("text");
    _$setProp(_el, "wrapMode", "none");
    _$setProp(_el, "selectable", false);
    _$setProp(_el, "flexShrink", 0);
    _$insert(_el, () => props.text);
    _$effect(_$p => _$setProp(_el, "style", { fg: props.fg, bold: props.bold === true }, _$p));
    return _el;
  })();
}

/** The TUI's swarm data: the server's last snapshot in a Solid signal, redrawn on change. */
function createSwarmClient(api, wantsLivePolling) {
  const [snapshot, setSnapshot] = createSignal();
  let subscription;
  const rpc = () => api.client.rpc(SwarmRpc);
  function subscribe() {
    if (subscription) return;
    subscription = new AbortController();
    const { signal } = subscription;
    try {
      rpc().events.on(
        "changed",
        (event) => {
          if (signal.aborted) return;
          if (event.data) setSnapshot(event.data);
        },
        { signal },
      );
    } catch (error) {
      // The poll still updates.
      reportFailure(error);
    }
  }
  async function load() {
    subscribe();
    try {
      setSnapshot(await rpc().snapshot({}));
    } catch (error) {
      reportFailure(error);
    }
  }
  function start() {
    void load();
    const timer = setInterval(() => {
      const current = snapshot();
      // Events carry the updates; poll only while a swarm runs or the status window is open.
      if (!current || current.active?.status === "running" || wantsLivePolling()) void load();
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      subscription?.abort();
      subscription = undefined;
    };
  }
  return { snapshot, load, start };
}

/** The status window above the message box of a session. */
function createSwarmWindow(api, swarm) {
  const [tab, setTab] = createSignal("active");
  const [isOpen, setOpen] = createSignal(false);
  const [historyIndex, setHistoryIndex] = createSignal(0);
  const [historyReport, setHistoryReport] = createSignal("");
  let windowBox;
  let scroll;
  /** What had the keyboard before the window opened (the message box). */
  let focusBefore = null;

  function showTab(key) {
    setTab(key);
    windowBox?.focus();
    scroll?.scrollTo(0);
    if (key === "history") void showRun(historyIndex());
  }
  function switchTab(delta) {
    const index = TABS.findIndex(([key]) => key === tab());
    const [key] = TABS[(Math.max(0, index) + delta + TABS.length) % TABS.length];
    showTab(key);
  }
  /** Loads the report of hashed run `index` (wraps) for the History tab. */
  async function showRun(index) {
    const runs = swarm.snapshot()?.runs ?? [];
    if (runs.length === 0) {
      setHistoryReport("No hashed swarm runs in .swarm/ yet.");
      return;
    }
    const next = ((index % runs.length) + runs.length) % runs.length;
    setHistoryIndex(next);
    try {
      const output = await api.client.rpc(SwarmRpc).selectRun({ id: runs[next].id });
      setHistoryReport(output.reportText);
    } catch (error) {
      reportFailure(error);
    }
  }
  function refresh() {
    void swarm.load();
    if (tab() === "history") void showRun(historyIndex());
  }
  function open(next = "active") {
    if (!isOpen()) focusBefore = api.renderer.currentFocusedRenderable;
    setOpen(true);
    showTab(next);
    void swarm.load();
    // The command leaves the message box focused; take the keyboard once it has settled.
    setTimeout(() => windowBox?.focus(), 50);
  }
  function close() {
    setOpen(false);
    if (focusBefore && !focusBefore.isDestroyed) focusBefore.focus();
    focusBefore = null;
  }

  function activeLines() {
    const current = swarm.snapshot();
    if (!current) return ["Loading swarm state…"];
    return String(current.reportText ?? "").split("\n");
  }
  function waveLines() {
    const current = swarm.snapshot();
    const run = current?.active ?? current?.runs?.[0];
    if (!run) return ["No swarm run to show."];
    const tasks = Array.isArray(run.tasks) ? run.tasks : [];
    if (tasks.length === 0) return [`#${run.id} has no tasks recorded.`];
    const waves = new Map();
    for (const task of tasks) {
      const key = task.wave > 0 ? task.wave : 0;
      if (!waves.has(key)) waves.set(key, []);
      waves.get(key).push(task);
    }
    const lines = [`#${run.id}  ${STATUS_ICON[run.status] ?? "○"} ${run.status}`];
    for (const [wave, group] of [...waves.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push("", wave > 0 ? `Wave ${wave}` : "Tasks");
      for (const task of group) {
        lines.push(
          `${TASK_ICON[task.status] ?? "○"} ${task.id.padEnd(8)} ${task.agent.padEnd(14)} ${task.description}`.trimEnd(),
        );
      }
    }
    return lines;
  }
  function historyListLines() {
    const runs = swarm.snapshot()?.runs ?? [];
    if (runs.length === 0) return ["No hashed swarm runs in .swarm/ yet."];
    return runs.map(
      (run, index) =>
        `${index === historyIndex() ? "▸" : " "} #${run.id}  ${STATUS_ICON[run.status] ?? "○"} ${String(run.status).padEnd(10)} ${run.objective}`,
    );
  }
  function bodyLines() {
    const key = tab();
    if (key === "waves") return waveLines();
    if (key === "history") {
      const report = historyReport();
      return [...historyListLines(), "", ...(report ? report.split("\n") : ["(↑/↓ to load a run)"])];
    }
    return activeLines();
  }

  function Window() {
    const theme = () => api.theme;
    /** One color per line: the leading status mark wins; the History selection is accented. */
    function lineColor(line) {
      if (line.startsWith("▸")) return theme().text.action.primary.selected;
      if (line.includes("✗")) return theme().text.feedback.error.base;
      if (line.includes("●")) return theme().text.action.primary.selected;
      if (line.includes("✓")) return theme().text.feedback.success.base;
      return theme().text.base;
    }
    // Keys work only while this box has the keyboard; the message box keeps its own keys.
    api.keymap.layer(() => ({
      target: () => windowBox,
      priority: WINDOW_KEY_PRIORITY,
      commands: [
        { bind: "tab", title: "Next tab", group: KEYS, run: () => switchTab(1) },
        { bind: "shift+tab", title: "Previous tab", group: KEYS, run: () => switchTab(-1) },
        { bind: "1", title: "Active Swarm", group: KEYS, run: () => showTab("active") },
        { bind: "2", title: "Waves & Tasks", group: KEYS, run: () => showTab("waves") },
        { bind: "3", title: "Hashed History", group: KEYS, run: () => showTab("history") },
        {
          bind: "up",
          title: "Previous run (History) or line",
          group: KEYS,
          run: () => (tab() === "history" ? showRun(historyIndex() - 1) : scroll?.scrollBy(-1)),
        },
        {
          bind: "down",
          title: "Next run (History) or line",
          group: KEYS,
          run: () => (tab() === "history" ? showRun(historyIndex() + 1) : scroll?.scrollBy(1)),
        },
        { bind: "r", title: "Refresh", group: KEYS, run: refresh },
        { bind: "escape", title: "Close", group: KEYS, run: close },
      ],
    }));
    return (() => {
      var _el = _$createElement("box"),
        _bar = _$createElement("box"),
        _title = _$createElement("text"),
        _titleB = _$createElement("b"),
        _tabs = _$createElement("box"),
        _esc = _$createElement("text"),
        _body = _$createElement("box"),
        _scroll = _$createElement("scrollbox"),
        _hint = _$createElement("text");
      _$use((element) => {
        windowBox = element;
      }, _el);
      _$setProp(_el, "focusable", true);
      _$setProp(_el, "border", true);
      _$setProp(_el, "borderStyle", "rounded");
      _$setProp(_el, "paddingLeft", 1);
      _$setProp(_el, "paddingRight", 1);
      _$setProp(_el, "flexDirection", "column");
      _$setProp(_el, "onMouseDown", () => windowBox?.focus());
      _$insertNode(_el, _bar);
      _$setProp(_bar, "flexDirection", "row");
      _$setProp(_bar, "flexShrink", 0);
      _$setProp(_bar, "columnGap", 2);
      _$insertNode(_bar, _title);
      _$setProp(_title, "wrapMode", "none");
      _$setProp(_title, "selectable", false);
      _$insertNode(_title, _titleB);
      _$insertNode(_titleB, _$createTextNode(WINDOW_TITLE));
      _$insertNode(_bar, _tabs);
      _$setProp(_tabs, "flexDirection", "row");
      _$setProp(_tabs, "columnGap", 2);
      _$insert(
        _tabs,
        () =>
          TABS.map(([key, label]) =>
            (() => {
              var _tab = _$createElement("text");
              _$setProp(_tab, "wrapMode", "none");
              _$setProp(_tab, "selectable", false);
              _$insertNode(_tab, _$createTextNode(label));
              _$setProp(_tab, "onMouseUp", () => showTab(key));
              _$effect((_$p) =>
                _$setProp(
                  _tab,
                  "fg",
                  tab() === key ? theme().text.action.primary.selected : theme().text.muted,
                  _$p,
                ),
              );
              return _tab;
            })(),
          ),
        null,
      );
      _$insertNode(_bar, _esc);
      _$setProp(_esc, "selectable", false);
      _$insertNode(_esc, _$createTextNode(`esc`));
      _$effect((_$p) => _$setProp(_esc, "fg", theme().text.muted, _$p));
      _$insertNode(_el, _body);
      _$setProp(_body, "flexDirection", "column");
      _$setProp(_body, "flexGrow", 1);
      _$setProp(_body, "flexBasis", 0);
      _$setProp(_body, "minHeight", 0);
      _$setProp(_body, "overflow", "hidden");
      _$setProp(_body, "marginTop", 1);
      _$insertNode(_body, _scroll);
      _$use((element) => {
        scroll = element;
      }, _scroll);
      _$setProp(_scroll, "flexGrow", 1);
      _$setProp(_scroll, "flexBasis", 0);
      _$setProp(_scroll, "minHeight", 0);
      _$insert(
        _scroll,
        () =>
          bodyLines().map((line) => {
            const bar = barSegments(line);
            if (!bar) {
              return _$createComponent(TextLine, {
                text: line,
                get fg() {
                  return lineColor(line);
                },
              });
            }
            return (() => {
              var _barLine = _$createElement("text");
              _$setProp(_barLine, "wrapMode", "none");
              _$setProp(_barLine, "selectable", false);
              _$setProp(_barLine, "flexShrink", 0);
              const subject = swarm.snapshot()?.active ?? swarm.snapshot()?.runs?.[0];
              _$insert(_barLine, () => barSpans(api, subject?.status, bar.before, bar.full, bar.empty, bar.after));
              return _barLine;
            })();
          }),
        null,
      );
      _$insertNode(_el, _hint);
      _$setProp(_hint, "wrapMode", "none");
      _$setProp(_hint, "selectable", false);
      _$setProp(_hint, "flexShrink", 0);
      _$insertNode(_hint, _$createTextNode(`tab/1-3 switch tab · ↑/↓ cycle runs (History) · r refresh · esc close`));
      _$effect((_$p) => _$setProp(_hint, "fg", theme().text.muted, _$p));
      return _el;
    })();
  }
  return { open, isOpen, Slot: Window };
}

/** The Swarm Fleet panel in the session sidebar; click the title to collapse or expand it. */
function SwarmSidebar(props) {
  const api = props.api;
  const theme = () => api.theme;
  const run = () => {
    const current = props.swarm.snapshot();
    return current?.active ?? current?.runs?.[0];
  };
  const tasks = () => {
    const current = run();
    return Array.isArray(current?.tasks) ? current.tasks : [];
  };
  const doneCount = () => tasks().filter((task) => task.status === "done" || task.status === "completed").length;
  const taskRows = () =>
    tasks().slice(0, 12).map((task) => ({
      text: `${TASK_ICON[task.status] ?? "○"} ${task.id} ${task.agent}`.trimEnd(),
      status: task.status,
    }));
  return (() => {
    var _el = _$createElement("box"),
      _head = _$createElement("text"),
      _headB = _$createElement("b");
    _$setProp(_el, "flexDirection", "column");
    _$insertNode(_el, _head);
    _$setProp(_head, "wrapMode", "none");
    _$setProp(_head, "selectable", false);
    _$setProp(_head, "flexShrink", 0);
    _$setProp(_head, "onMouseDown", () => props.setOpen(!props.open()));
    _$insertNode(_head, _headB);
    _$insert(_headB, () => `${props.open() ? "▼" : "▶"} Swarm Fleet`);
    _$effect((_$p) => _$setProp(_head, "fg", theme().text.base, _$p));
    _$insert(
      _el,
      _$createComponent(Show, {
        get when() {
          return props.open();
        },
        get children() {
          return _$createComponent(Show, {
            get when() {
              return run();
            },
            get fallback() {
              return _$createComponent(TextLine, {
                text: "○ no swarm running",
                get fg() {
                  return theme().text.muted;
                },
              });
            },
            get children() {
              return (() => {
                var _body = _$createElement("box"),
                  _id = _$createElement("text"),
                  _stage = _$createElement("text"),
                  _bar = _$createElement("text");
                _$setProp(_body, "flexDirection", "column");
                _$insertNode(_body, _id);
                _$setProp(_id, "wrapMode", "none");
                _$setProp(_id, "selectable", false);
                _$setProp(_id, "flexShrink", 0);
                _$insert(_id, () => `#${run()?.id}  ${STATUS_ICON[run()?.status] ?? "○"} ${run()?.status}`);
                _$effect((_$p) => _$setProp(_id, "fg", statusColor(theme(), run()?.status), _$p));
                _$insertNode(_body, _stage);
                _$setProp(_stage, "wrapMode", "none");
                _$setProp(_stage, "selectable", false);
                _$setProp(_stage, "flexShrink", 0);
                _$insert(_stage, () => `Stage ${stageLabel(run())} · Wave ${waveText(run())}`);
                _$effect((_$p) => _$setProp(_stage, "fg", theme().text.muted, _$p));
                _$insertNode(_body, _bar);
                _$setProp(_bar, "wrapMode", "none");
                _$setProp(_bar, "selectable", false);
                _$setProp(_bar, "flexShrink", 0);
                _$insert(
                  _bar,
                  () =>
                    barSpans(
                      api,
                      run()?.status,
                      "",
                      ...barParts(doneCount(), tasks().length),
                      `  ${percent(doneCount(), tasks().length)}% (${doneCount()}/${tasks().length})`,
                    ),
                );
                _$insert(
                  _body,
                  () =>
                    taskRows().map((row) =>
                      _$createComponent(TextLine, {
                        text: row.text,
                        get fg() {
                          return statusColor(theme(), row.status);
                        },
                      }),
                    ),
                  null,
                );
                return _body;
              })();
            },
          });
        },
      }),
      null,
    );
    return _el;
  })();
}

const plugin = Plugin.define({
  // OpenCode names this plugin's storage files after its id (`plugin.<id>.<key>.json`), so the
  // id may hold only letters, digits, ".", "_" and "-".
  id: "veryloooong.opencode-swarm-ui",
  setup(context) {
    const api = context;
    // Plugin storage is first read when a surface draws, never during setup.
    let sidebarStore;
    const sidebarState = () => {
      sidebarStore ??= api.storage.store("sidebar", { initial: { open: true } });
      return sidebarStore;
    };
    // `client` is read from OpenCode's context at each use, never copied.
    let swarmWindow;
    const swarm = createSwarmClient(api, () => swarmWindow?.isOpen());
    swarmWindow = createSwarmWindow(api, swarm);

    let disposeMount;
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        // OpenCode mounts this slot again when it reconnects to its server; each mount stops
        // the last one's client and layers and registers everything again.
        disposeMount?.();
        const stopSwarm = swarm.start();
        api.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "swarm.status",
              title: "Swarm: Status Window",
              group: "OpenCode Swarm",
              palette: true,
              // The server lists /swarm_status for Web and Desktop; in the TUI it opens here.
              slash: { name: "swarm_status" },
              run: () => swarmWindow.open(),
            },
          ],
        }));
        // A typed /swarm_status is taken before OpenCode submits the prompt: the editor is
        // cleared and the status window opens, so nothing reaches the chat. Synchronous on
        // purpose: a returned promise counts as handled.
        api.keymap.layer(() => ({
          priority: TYPED_COMMAND_PRIORITY,
          commands: [
            {
              bind: "return",
              run: () => {
                const editor = api.renderer.currentFocusedEditor;
                const trimmed = editor?.plainText.trim() ?? "";
                if (!editor || !trimmed.startsWith("/")) return false;
                // As in OpenCode, the command name ends at the first whitespace.
                const name = trimmed.slice(1).split(/\s/, 1)[0] ?? "";
                if (name !== "swarm_status") return false;
                editor.clear();
                swarmWindow.open();
              },
            },
          ],
        }));
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          if (disposeMount === dispose) disposeMount = undefined;
          stopSwarm();
        };
        disposeMount = dispose;
        onCleanup(dispose);
        return null;
      },
    });
    const disposeSidebar = api.ui.slot({
      append: "sidebar.content",
      render: () => {
        const [state, update] = sidebarState();
        return _$createComponent(SwarmSidebar, {
          api,
          swarm,
          open: () => state.open,
          setOpen: (open) => {
            void update((draft) => {
              draft.open = open;
            }).catch(reportFailure);
          },
        });
      },
    });
    const disposeWindow = api.ui.slot({
      append: "session.composer.top",
      render: () =>
        _$createComponent(Show, {
          get when() {
            return swarmWindow.isOpen();
          },
          get children() {
            return _$createComponent(swarmWindow.Slot, {});
          },
        }),
    });
    return () => {
      disposeMount?.();
      disposeApp();
      disposeSidebar();
      disposeWindow();
    };
  },
});
export default plugin;
