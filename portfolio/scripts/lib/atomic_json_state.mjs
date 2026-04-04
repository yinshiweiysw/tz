import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readJsonOrDefault(filePath, fallback = null) {
  if (!filePath) {
    return fallback;
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(filePath, payload) {
  if (!filePath) {
    return;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function updateJsonFileAtomically(filePath, mutator, fallback = {}) {
  const current = await readJsonOrDefault(filePath, fallback);
  const next = await Promise.resolve(mutator(current));
  await writeJsonAtomic(filePath, next);
  return next;
}
