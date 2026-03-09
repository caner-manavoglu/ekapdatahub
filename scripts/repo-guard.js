#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const MAX_TRACKED_FILE_BYTES =
  Math.max(1, Number.parseInt(process.env.MAX_TRACKED_FILE_MB || "5", 10)) * 1024 * 1024;

const FORBIDDEN_PREFIXES = [
  "ekap-v3/chrome-profile/",
  "ekap-v3/indirilenler/",
  "ekap-v3/downloads-mahkeme/",
  "ekap-v3/downloads-uyusmazlik/",
  "reports/pdfs/",
];

const FORBIDDEN_SUFFIXES = [".crdownload", ".part"];

function normalizeFilePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
  });

  return output
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeFilePath);
}

function isForbiddenPath(filePath) {
  if (FORBIDDEN_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
    return true;
  }
  if (FORBIDDEN_SUFFIXES.some((suffix) => filePath.endsWith(suffix))) {
    return true;
  }

  const baseName = path.posix.basename(filePath);
  if (baseName === ".env") {
    return true;
  }
  if (baseName.startsWith(".env.") && !baseName.endsWith(".example")) {
    return true;
  }

  return false;
}

function main() {
  let trackedFiles = [];
  try {
    trackedFiles = listTrackedFiles();
  } catch (error) {
    console.error("Repo guard calismadi (git ls-files).");
    console.error(error.message || error);
    process.exit(1);
  }

  const forbiddenFiles = [];
  const oversizedFiles = [];

  for (const filePath of trackedFiles) {
    if (isForbiddenPath(filePath)) {
      forbiddenFiles.push(filePath);
    }

    if (!fs.existsSync(filePath)) {
      continue;
    }

    const stats = fs.statSync(filePath);
    if (!stats.isFile()) {
      continue;
    }

    if (stats.size > MAX_TRACKED_FILE_BYTES) {
      oversizedFiles.push({
        filePath,
        sizeBytes: stats.size,
      });
    }
  }

  if (forbiddenFiles.length > 0 || oversizedFiles.length > 0) {
    console.error("Repo guard basarisiz.");

    if (forbiddenFiles.length > 0) {
      console.error("Yasakli/sensitive path tespit edildi:");
      for (const filePath of forbiddenFiles) {
        console.error(`- ${filePath}`);
      }
    }

    if (oversizedFiles.length > 0) {
      const limitMb = Math.round((MAX_TRACKED_FILE_BYTES / (1024 * 1024)) * 100) / 100;
      console.error(`Boyut limiti asildi (>${limitMb} MB):`);
      for (const file of oversizedFiles) {
        const sizeMb = Math.round((file.sizeBytes / (1024 * 1024)) * 100) / 100;
        console.error(`- ${file.filePath} (${sizeMb} MB)`);
      }
    }

    process.exit(1);
  }

  console.log(
    `Repo guard basarili (${trackedFiles.length} dosya, limit ${MAX_TRACKED_FILE_BYTES / (1024 * 1024)} MB).`
  );
}

main();
