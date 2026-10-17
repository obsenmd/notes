import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileManager, type FileManagerEntry } from "@cubone/react-file-manager";
import fileManagerStyles from "@cubone/react-file-manager/dist/style.css?inline";
import { fs, path } from "./web-node";

function validName(name: string): string {
  const value = name.trim();
  if (!value || value === "." || value === ".." || /[\\/\0]/.test(value)) throw new Error("Enter a file or folder name without slashes.");
  return value;
}
function downloadFile(filename: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(fs.readFileSync(filename))]));
  const link = document.createElement("a"); link.href = url; link.download = path.basename(filename); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function FilePreview({ filename }: { filename: string }) {
  const extension = path.extname(filename).toLowerCase();
  const [url, setUrl] = useState("");
  useEffect(() => {
    const types: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm" };
    const resource = URL.createObjectURL(new Blob([new Uint8Array(fs.readFileSync(filename))], { type: types[extension] ?? "application/octet-stream" }));
    setUrl(resource); return () => URL.revokeObjectURL(resource);
  }, [filename, extension]);
  if (/^\.(md|txt|json|css|js|ts|csv|yaml|yml|canvas|base|html|xml|log)$/.test(extension)) return <pre style={{ whiteSpace: "pre-wrap", maxHeight: "55vh", overflow: "auto", textAlign: "left" }}>{fs.readFileSync(filename, "utf8")}</pre>;
  if (/^\.(png|jpe?g|gif|webp|svg)$/.test(extension)) return <img src={url} alt={path.basename(filename)} style={{ maxWidth: "100%", maxHeight: "55vh" }} />;
  if (extension === ".pdf") return <iframe title={path.basename(filename)} src={url} style={{ width: "100%", height: "55vh", border: 0 }} />;
  if (/^\.(mp3|wav)$/.test(extension)) return <audio src={url} controls />;
  if (/^\.(mp4|webm)$/.test(extension)) return <video src={url} controls style={{ maxWidth: "100%" }} />;
  return <button onClick={() => downloadFile(filename)}>Download {path.basename(filename)}</button>;
}
function BrowserFileManager({ initialRoot, initialDirectory }: { initialRoot: string; initialDirectory: string }) {
  const [root, setRoot] = useState(initialRoot);
  const [directory, setDirectory] = useState(initialDirectory);
  const [files, setFiles] = useState<FileManagerEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  const absolute = useCallback((relative: string) => {
    const filename = path.resolve(root, "." + (relative.startsWith("/") ? relative : "/" + relative));
    if (filename !== root && !filename.startsWith(root + "/")) throw new Error("Choose a path inside this folder.");
    return filename;
  }, [root]);
  const refresh = useCallback(() => {
    const entries: FileManagerEntry[] = [];
    const visit = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isFile()) continue;
        const filename = path.join(folder, entry.name), stat = fs.statSync(filename);
        entries.push({ name: entry.name, path: "/" + path.relative(root, filename), isDirectory: entry.isDirectory(), updatedAt: stat.mtime.toISOString(), size: stat.size });
        if (entry.isDirectory()) visit(filename);
      }
    };
    visit(root); setFiles(entries);
  }, [root]);
  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = fs.watch(root, { recursive: true }, () => { clearTimeout(timer); timer = setTimeout(refresh, 50); });
    return () => { clearTimeout(timer); watcher.close(); };
  }, [root, refresh]);
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const importFiles = async (selected: File[]) => {
    for (const file of selected) {
      const target = path.join(absolute(directory), validName(file.name));
      if (fs.existsSync(target)) throw new Error(`${file.name} already exists.`);
      await fs.promises.writeFile(target, new Uint8Array(await file.arrayBuffer()));
    }
  };
  const openFolder = () => {
    const selected = window.showDirectoryPicker({ mode: "readwrite", id: "obsen-file-manager" });
    void run(async () => {
      const [{ mountHandle }, handle] = await Promise.all([import("./web"), selected]);
      const mounted = await mountHandle(handle); setDirectory(""); setRoot(mounted);
    });
  };
  return <>
    <header>
      <strong>{path.basename(root) || "Files"}</strong>
      <span className="actions">
        {"showDirectoryPicker" in window && <button onClick={openFolder} disabled={busy}>Open folder</button>}
        <button disabled={busy} onClick={() => upload.current?.click()}>Import files</button>
      </span>
    </header>
    <input ref={upload} type="file" multiple hidden onChange={event => { const chosen = [...(event.target.files ?? [])]; void run(() => importFiles(chosen)); event.target.value = ""; }} />
    {error && <p role="alert" className="error">{error}</p>}
    <FileManager key={root} files={files} initialPath={directory} height="min(65vh, 650px)" layout="list" collapsibleNav fontFamily="var(--font-interface, system-ui)" primaryColor="var(--interactive-accent, #6155b4)" isLoading={busy}
      permissions={{ upload: false }}
      onFolderChange={setDirectory}
      onRefresh={refresh}
      onError={cause => setError(cause.message)}
      onCreateFolder={(name, parent) => void run(async () => { await fs.promises.mkdir(path.join(absolute(parent?.path ?? ""), validName(name))); })}
      onRename={(file, name) => void run(async () => {
        const source = absolute(file.path), target = path.join(path.dirname(source), validName(name));
        if (source === target) return;
        if (fs.existsSync(target)) throw new Error(`${name} already exists.`);
        await fs.promises.rename(source, target);
      })}
      onDelete={selected => void run(async () => { for (const file of selected) await fs.promises.rm(absolute(file.path), { recursive: true }); })}
      onPaste={(selected, destination, operation) => void run(async () => {
        const folder = absolute(destination?.path ?? "");
        for (const file of selected) {
          const source = absolute(file.path), target = path.join(folder, file.name);
          if (source === target || target.startsWith(source + "/")) throw new Error("Choose a different destination folder.");
          if (fs.existsSync(target)) throw new Error(`${file.name} already exists.`);
          if (operation === "move") await fs.promises.rename(source, target);
          else await fs.promises.cp(source, target, { recursive: true, errorOnExist: true, force: false });
        }
      })}
      onDownload={selected => void run(async () => {
        if (selected.length === 1 && !selected[0].isDirectory) { downloadFile(absolute(selected[0].path)); return; }
        const { zipSync } = await import("fflate"), entries: Record<string, Uint8Array> = {};
        const add = (filename: string, relative: string) => {
          if (fs.statSync(filename).isDirectory()) { entries[relative + "/"] = new Uint8Array(); for (const child of fs.readdirSync(filename)) add(path.join(filename, child), path.join(relative, child)); }
          else entries[relative] = new Uint8Array(fs.readFileSync(filename));
        };
        for (const file of selected) add(absolute(file.path), file.name);
        const url = URL.createObjectURL(new Blob([new Uint8Array(zipSync(entries))], { type: "application/zip" }));
        const link = document.createElement("a"); link.href = url; link.download = (selected.length === 1 ? selected[0].name : "Files") + ".zip"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}
      filePreviewComponent={file => <FilePreview filename={absolute(file.path)} />}
    />
  </>;
}
export function showFileManager(filename: string): void {
  const directory = fs.existsSync(filename) && fs.statSync(filename).isDirectory() ? filename : path.dirname(filename);
  const activeRoot = (window as unknown as { app?: { vault?: { adapter?: { basePath?: string } } } }).app?.vault?.adapter?.basePath;
  const rootPath = activeRoot && (directory === activeRoot || directory.startsWith(activeRoot + "/")) ? activeRoot : directory;
  const dialog = document.createElement("dialog"); dialog.className = "platform-file-manager";
  Object.assign(dialog.style, { width: "min(1100px, 94vw)", maxWidth: "94vw", padding: "16px", background: "var(--background-primary)", color: "var(--text-normal)", border: "1px solid var(--background-modifier-border)", borderRadius: "8px" });
  const close = document.createElement("button"); close.textContent = "Close"; close.style.cssFloat = "right"; close.onclick = () => dialog.close();
  const host = document.createElement("div"), shadow = host.attachShadow({ mode: "open" }), style = document.createElement("style"), container = document.createElement("div");
  style.textContent = fileManagerStyles + `\n:host{display:block;color-scheme:light}.file-explorer{color:#202020}header{display:flex;align-items:center;justify-content:space-between;padding:8px 0 14px}.actions{display:flex;gap:8px}header button{padding:5px 12px;cursor:pointer}.error{color:var(--text-error,#e35);padding:8px}pre{font-family:var(--font-monospace,monospace)}iframe{border:0}`;
  shadow.append(style, container); dialog.append(close, host); document.body.append(dialog);
  const reactRoot = createRoot(container);
  reactRoot.render(<BrowserFileManager initialRoot={rootPath} initialDirectory={directory === rootPath ? "" : "/" + path.relative(rootPath, directory)} />);
  dialog.addEventListener("close", () => { reactRoot.unmount(); dialog.remove(); }, { once: true });
  dialog.showModal();
}
