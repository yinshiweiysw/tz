import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readManifestState(manifestPath) {
  if (!manifestPath) {
    return {};
  }

  try {
    return JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeManifest(manifest = {}) {
  return manifest && typeof manifest === "object" ? manifest : {};
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj ?? {}, key);
}

function normalizeLatestCompatAlias(canonicalEntrypoints = {}, entries = {}) {
  const canonical = normalizeManifest(canonicalEntrypoints);
  const incoming = normalizeManifest(entries);
  let aliasPath = null;

  if (hasOwn(incoming, "latest_compat_view")) {
    aliasPath = incoming.latest_compat_view;
  } else if (hasOwn(incoming, "latest_snapshot")) {
    aliasPath = incoming.latest_snapshot;
  } else {
    aliasPath = canonical.latest_compat_view ?? canonical.latest_snapshot ?? null;
  }

  if (typeof aliasPath === "string" && aliasPath.trim()) {
    const normalizedPath = aliasPath.trim();
    return {
      ...canonical,
      latest_compat_view: normalizedPath,
      latest_snapshot: normalizedPath
    };
  }

  return canonical;
}

function buildMergedManifest(baseManifest = {}, onDiskManifest = {}, entries = {}) {
  const base = normalizeManifest(baseManifest);
  const onDisk = normalizeManifest(onDiskManifest);
  const incomingEntries = normalizeManifest(entries);
  const mergedCanonical = {
    ...(base.canonical_entrypoints ?? {}),
    ...(onDisk.canonical_entrypoints ?? {}),
    ...incomingEntries
  };

  return {
    ...base,
    ...onDisk,
    canonical_entrypoints: normalizeLatestCompatAlias(mergedCanonical, incomingEntries)
  };
}

async function writeManifestAtomically(manifestPath, manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(manifestPath),
    `${path.basename(manifestPath)}.${process.pid}.${Date.now()}.tmp`
  );
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(tempPath, manifestPath);
}

export async function updateManifestCanonicalEntrypoints({
  manifestPath,
  baseManifest = {},
  entries = {}
} = {}) {
  if (!manifestPath) {
    return normalizeManifest(baseManifest);
  }

  const onDiskManifest = await readManifestState(manifestPath);
  const nextManifest = buildMergedManifest(baseManifest, onDiskManifest, entries);
  await writeManifestAtomically(manifestPath, nextManifest);
  return nextManifest;
}
