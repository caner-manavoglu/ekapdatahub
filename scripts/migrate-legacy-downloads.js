#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const EKAP_V3_DIR = path.join(PROJECT_ROOT, "ekap-v3");
const TARGET_ROOT_DIR = path.join(EKAP_V3_DIR, "indirilenler");
const DOWNLOAD_TYPES = ["mahkeme", "uyusmazlik"];
const TARGET_DIRS = {
  mahkeme: path.join(TARGET_ROOT_DIR, "mahkeme"),
  uyusmazlik: path.join(TARGET_ROOT_DIR, "uyusmazlik"),
};
const LEGACY_DIRS = {
  mahkeme: path.join(EKAP_V3_DIR, "downloads-mahkeme"),
  uyusmazlik: path.join(EKAP_V3_DIR, "downloads-uyusmazlik"),
};

// Legacy migration script planned to be removed after 2026-09-30.
const MIGRATION_SUNSET_DATE = "2026-09-30";

function shouldSkipFileName(fileName) {
  if (!fileName || fileName === ".DS_Store") return true;
  if (fileName.endsWith(".crdownload")) return true;
  if (fileName.endsWith(".part")) return true;
  return false;
}

async function ensureTargetDirs() {
  await fs.promises.mkdir(TARGET_ROOT_DIR, { recursive: true });
  await Promise.all(
    DOWNLOAD_TYPES.map((type) =>
      fs.promises.mkdir(TARGET_DIRS[type], { recursive: true }),
    ),
  );
}

async function moveFileSafely(sourcePath, targetDir, originalName) {
  const parsed = path.parse(originalName);
  let nextName = originalName;
  let suffix = 1;

  while (true) {
    const targetPath = path.join(targetDir, nextName);
    try {
      await fs.promises.access(targetPath);
      nextName = `${parsed.name} (${suffix})${parsed.ext}`;
      suffix += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await fs.promises.rename(sourcePath, targetPath);
      return nextName;
    }
  }
}

async function migrateType(type) {
  const legacyDir = LEGACY_DIRS[type];
  const targetDir = TARGET_DIRS[type];
  const summary = {
    type,
    movedCount: 0,
    skippedCount: 0,
    removedLegacyDir: false,
    touched: false,
  };

  let entries = [];
  try {
    entries = await fs.promises.readdir(legacyDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return summary;
    }
    throw error;
  }

  summary.touched = true;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (shouldSkipFileName(entry.name)) {
      summary.skippedCount += 1;
      continue;
    }

    const sourcePath = path.join(legacyDir, entry.name);
    await moveFileSafely(sourcePath, targetDir, entry.name);
    summary.movedCount += 1;
  }

  try {
    await fs.promises.rmdir(legacyDir);
    summary.removedLegacyDir = true;
  } catch (_) {
    summary.removedLegacyDir = false;
  }

  return summary;
}

async function main() {
  await ensureTargetDirs();

  const summaries = [];
  for (const type of DOWNLOAD_TYPES) {
    summaries.push(await migrateType(type));
  }

  console.log(`Legacy migration check complete. Sunset: ${MIGRATION_SUNSET_DATE}`);
  for (const summary of summaries) {
    console.log(
      [
        `- ${summary.type}`,
        `moved=${summary.movedCount}`,
        `skipped=${summary.skippedCount}`,
        `legacyDirRemoved=${summary.removedLegacyDir}`,
        `legacyDirExists=${summary.touched}`,
      ].join(" "),
    );
  }
}

main().catch((error) => {
  console.error("[LEGACY_MIGRATION_ERROR]", error);
  process.exit(1);
});
