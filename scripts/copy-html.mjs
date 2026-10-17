import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const output = path.join(root, "dist");
await mkdir(output, { recursive: true });
await copyFile(path.join(root, "src", "renderer", "index.html"), path.join(output, "index.html"));
