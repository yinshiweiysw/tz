import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  readJsonOrDefault,
  updateJsonFileAtomically,
  writeJsonAtomic
} from "./atomic_json_state.mjs";

test("readJsonOrDefault returns fallback for missing file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-json-state-"));
  const filePath = path.join(dir, "missing.json");
  const fallback = { ok: true };
  const result = await readJsonOrDefault(filePath, fallback);
  assert.deepEqual(result, fallback);
});

test("writeJsonAtomic writes JSON payload", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-json-state-"));
  const filePath = path.join(dir, "state.json");

  await writeJsonAtomic(filePath, { a: 1, b: "x" });

  const onDisk = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(onDisk, { a: 1, b: "x" });
});

test("updateJsonFileAtomically merges based on latest on-disk state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atomic-json-state-"));
  const filePath = path.join(dir, "state.json");

  await writeJsonAtomic(filePath, {
    canonical_entrypoints: {
      a: "/tmp/a.json"
    }
  });

  const updated = await updateJsonFileAtomically(filePath, (current) => ({
    ...current,
    canonical_entrypoints: {
      ...(current.canonical_entrypoints ?? {}),
      b: "/tmp/b.json"
    }
  }));

  assert.deepEqual(updated, {
    canonical_entrypoints: {
      a: "/tmp/a.json",
      b: "/tmp/b.json"
    }
  });

  const onDisk = JSON.parse(await readFile(filePath, "utf8"));
  assert.deepEqual(onDisk, updated);
});
