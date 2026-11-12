/**
 * The Swarm RPC contract between the server plugin (index.js) and the TUI plugin (tui.js),
 * following the Standard Schema v1 validator shape used by @slkiser/opencode-quota.
 */

/** RPC id, also the plugin id namespace. */
export const SWARM_RPC_ID = "veryloooong.opencode-swarm-ui";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Standard Schema v1 that runs `check` and passes the value through unchanged. OpenCode
 * validates every input and output with it; OpenCode's types only carry T for TypeScript.
 */
function schema(check) {
  return {
    "~standard": {
      version: 1,
      vendor: "opencode-swarm-ui",
      validate: (value) => {
        const issue = check(value);
        return issue ? { issues: [{ message: issue }] } : { value: value };
      },
    },
  };
}

/** The same for event data, which OpenCode requires to be an object. */
const eventSchema = schema;

/** An input with no fields of its own. */
function checkObjectInput(value) {
  return isRecord(value) ? null : "input must be an object";
}

/**
 * The snapshot both `snapshot` and the `changed` event carry:
 * `{ active: run | null, runs: run[], updatedAt: number, reportText: string }`.
 */
function checkSnapshotOutput(value) {
  if (!isRecord(value)) return "output must be an object";
  if (value.active !== null && !isRecord(value.active)) return "active must be a run or null";
  if (!Array.isArray(value.runs)) return "output must carry runs";
  if (typeof value.updatedAt !== "number") return "output must carry updatedAt";
  return typeof value.reportText === "string" ? null : "output must carry reportText";
}

function checkSelectRunInput(value) {
  if (!isRecord(value)) return "input must be an object";
  return typeof value.id === "string" ? null : "id must be a string";
}

/** `selectRun` answers `{ run: run | null, reportText: string }`. */
function checkSelectRunOutput(value) {
  if (!isRecord(value)) return "output must be an object";
  if (value.run !== null && !isRecord(value.run)) return "run must be a run or null";
  return typeof value.reportText === "string" ? null : "output must carry reportText";
}

export const SwarmRpc = {
  id: SWARM_RPC_ID,
  events: {
    changed: { schema: eventSchema(checkSnapshotOutput) },
  },
  methods: {
    snapshot: {
      input: schema(checkObjectInput),
      output: schema(checkSnapshotOutput),
    },
    selectRun: {
      input: schema(checkSelectRunInput),
      output: schema(checkSelectRunOutput),
    },
  },
};
