const fs = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_STATE = {
  chatId: null,
  lastTransactionCreatedAt: null,
  sentTransactionIds: [],
  transactionStatusById: {}
};

function resolveStatePath() {
  const configured = process.env.STATE_PATH?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), ".bot-state.json");
}

async function readState() {
  const statePath = resolveStatePath();
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed
    };
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return { ...DEFAULT_STATE };
    throw err;
  }
}

async function writeState(nextState) {
  const statePath = resolveStatePath();
  const tmpPath = `${statePath}.tmp`;
  const normalized = {
    ...DEFAULT_STATE,
    ...nextState
  };
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, statePath);
}

module.exports = {
  readState,
  writeState,
  resolveStatePath
};
