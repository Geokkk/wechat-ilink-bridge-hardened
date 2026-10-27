import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  accountStatePath,
  accountsDir,
  defaultStateDir,
  ensureStateDir,
  expandHome,
  resolveStateDir,
  safeAccountId
} from "../../src/state/state-dir.js";
import { pathExists, writeJsonAtomic } from "../../src/state/json-file.js";
import { appendMessageHistory, replaceMessageHistory } from "../../src/state/message-history.js";

test("expands home-prefixed paths", () => {
  assert.equal(expandHome("~/wxb", "C:\\Users\\tester"), path.join("C:\\Users\\tester", "wxb"));
});

test("resolves platform default state directories", () => {
  const homeDir = path.join("C:", "Users", "tester");

  assert.equal(
    defaultStateDir({ platform: "win32", env: { LOCALAPPDATA: path.join("C:", "Users", "tester", "AppData", "Local") }, homeDir }),
    path.join("C:", "Users", "tester", "AppData", "Local", "wxb")
  );
  assert.equal(
    defaultStateDir({ platform: "darwin", env: {}, homeDir }),
    path.join(homeDir, "Library", "Application Support", "wxb")
  );
  assert.equal(
    defaultStateDir({ platform: "linux", env: { XDG_DATA_HOME: path.join(homeDir, ".xdg") }, homeDir }),
    path.join(homeDir, ".xdg", "wxb")
  );
});

test("resolves custom state directory to an absolute path", () => {
  const cwd = path.join(os.tmpdir(), "wxb cwd");
  const stateDir = resolveStateDir({ stateDir: "相对 目录", cwd, homeDir: cwd, env: {} });

  assert.equal(stateDir, path.join(cwd, "相对 目录"));
});

test("creates the state directory and accounts subdirectory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-state-dir-"));
  try {
    const stateDir = path.join(dir, "状态 目录");
    await ensureStateDir(stateDir);

    assert.equal(await pathExists(stateDir), true);
    assert.equal(await pathExists(accountsDir(stateDir)), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sanitizes account IDs used in file paths", () => {
  assert.equal(safeAccountId("bot:../unsafe"), "bot_.._unsafe");
  assert.equal(
    accountStatePath("C:\\tmp\\wxb", "bot:../unsafe", ".json"),
    path.join("C:\\tmp\\wxb", "accounts", "bot_.._unsafe.json")
  );
});

test("ensures state directory and account files have restricted permissions on POSIX", async () => {
  if (process.platform === "win32") {
    return; // Windows: permissions not enforceable, documented in code
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "wxb-perm-"));
  try {
    const stateDir = path.join(dir, "state");
    await ensureStateDir(stateDir);
    const accountsDirPath = accountsDir(stateDir);
    const dirStat = await stat(accountsDirPath);
    // Directory should be 0700 (owner only)
    assert.equal(dirStat.mode & 0o777, 0o700);

    const accountFile = accountStatePath(stateDir, "test-bot", ".json");
    await writeJsonAtomic(accountFile, { token: "secret", accountId: "test-bot" });
    const fileStat = await stat(accountFile);
    // File should be 0600 (owner only)
    assert.equal(fileStat.mode & 0o777, 0o600);

    const historyFile = path.join(accountsDirPath, "test-bot.messages.jsonl");
    await appendMessageHistory(stateDir, "test-bot", { id: "msg1", text: "hello" });
    const historyStat = await stat(historyFile);
    assert.equal(historyStat.mode & 0o777, 0o600);

    await replaceMessageHistory(stateDir, "test-bot", [{ id: "msg2", text: "world" }]);
    const replacedStat = await stat(historyFile);
    assert.equal(replacedStat.mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
