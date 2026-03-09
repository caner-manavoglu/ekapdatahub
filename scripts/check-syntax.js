#!/usr/bin/env node

const { execFileSync, spawnSync } = require("child_process");

function listTrackedJavaScriptFiles() {
  const output = execFileSync("git", ["ls-files", "-z", "--", "*.js"], {
    encoding: "utf8",
  });

  return output
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean);
}

function main() {
  let files = [];
  try {
    files = listTrackedJavaScriptFiles();
  } catch (error) {
    console.error("JS dosyalari listelenemedi (git ls-files).");
    console.error(error.message || error);
    process.exit(1);
  }

  if (files.length === 0) {
    console.log("Kontrol edilecek JS dosyasi bulunamadi.");
    return;
  }

  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
    });

    if (result.status !== 0) {
      failures.push({
        file,
        stderr: (result.stderr || "").trim(),
      });
    }
  }

  if (failures.length > 0) {
    console.error("JS syntax kontrolu basarisiz:");
    for (const failure of failures) {
      console.error(`- ${failure.file}`);
      if (failure.stderr) {
        console.error(failure.stderr);
      }
    }
    process.exit(1);
  }

  console.log(`JS syntax kontrolu basarili (${files.length} dosya).`);
}

main();
