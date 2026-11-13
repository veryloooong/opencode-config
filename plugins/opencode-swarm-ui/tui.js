import { createComponent as _$createComponent } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
/** @jsxImportSource @opentui/solid */
/**
 * OpenCode Swarm UI — TUI plugin.
 *
 * Draws the swarm state the server plugin reads from `.swarm/` as the Swarm Fleet panel in
 * the session sidebar (click the title to collapse it). The `/swarm_status` chat report is
 * served by the server plugin's context-stripping hooks, not here.
 *
 * Data comes over the Swarm RPC: the `snapshot` call on mount, every `changed` event, and a
 * 3s poll while the sidebar is open (or a swarm is running) in case an event was missed —
 * so new `.swarm/` runs are picked up even without an event.
 */
// Plugin.define is identity in OpenCode V2 (returns the { id, setup } definition), so keep a
// local shim instead of importing @opencode/plugin/tui, unresolvable outside the host.
const Plugin = { define: (definition) => definition };
import { createSignal, onCleanup, Show } from "solid-js";
import { SwarmRpc } from "./rpc.js";

const POLL_MS = 3_000;
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
/** A bar's spans, LineText-style: filled part in a visible run color, the rest muted. */
function barSpans(api, status, before, full, empty, after) {
  const theme = () => api.theme;
  const span = (text, fg) => {
    var _s = _$createElement("span");
    _$insert(_s, () => text);
    _$effect((_$p) => _$setProp(_s, "style", { fg }, _$p));
    return _s;
  };
  const filledColor =
    status === "failed"
      ? theme().text.feedback.error.base
      : status === "completed" || status === "done"
        ? theme().text.feedback.success.base
        : (theme().hue?.accent?.[500] ?? theme().text.feedback?.info?.base ?? theme().text.base);
  return [
    ...(before ? [span(before, theme().text.base)] : []),
    span(full, filledColor),
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
      // Events carry the updates; poll while a swarm runs or the sidebar is open, so a new
      // `.swarm/` run shows up even when its `changed` event was missed.
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
    const sidebarOpen = () => sidebarState()[0].open;
    // `client` is read from OpenCode's context at each use, never copied.
    const swarm = createSwarmClient(api, () => sidebarOpen());

    let disposeMount;
    const disposeApp = api.ui.slot({
      append: "app",
      render: () => {
        // OpenCode mounts this slot again when it reconnects to its server; each mount stops
        // the last one's client and registers everything again.
        disposeMount?.();
        const stopSwarm = swarm.start();
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
    return () => {
      disposeMount?.();
      disposeApp();
      disposeSidebar();
    };
  },
});
export default plugin;
