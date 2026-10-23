import process from "node:process";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

if (process.argv.at(-1) === "--grandchild-only") {
  setInterval(() => {}, 1000);
} else {
  const grandchild = spawn(process.execPath, [
    import.meta.filename,
    "--grandchild-only",
  ]);
  await writeFile(`${process.pid}.tree-test-pids`, String(grandchild.pid));
  setInterval(() => {}, 1000);
}
