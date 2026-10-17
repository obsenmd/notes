import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync("wasm-pack", ["build", "graph-sim-wasm", "--target", "web", "--out-dir", "../src/graph/wasm", "--out-name", "publish_graph"],
  { cwd: root, stdio: "inherit", windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
