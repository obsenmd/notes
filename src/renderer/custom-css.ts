import { path, originalFs as fs } from "../../platforms/platform";
import type { VaultConfig } from "./config";

const safeName = (name: string) => !!name && !/[\/]/.test(name) && name !== "." && name !== "..";

/** Installed community themes: folders under `<config>/themes` that contain a `theme.css`. */
export async function listThemes(configDir: string): Promise<string[]> {
  const root = path.join(configDir, "themes");
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  const themes: string[] = [];
  for (const entry of entries) if (entry.isDirectory() && await fs.promises.access(path.join(root, entry.name, "theme.css")).then(() => true, () => false)) themes.push(entry.name);
  return themes.sort((a, b) => a.localeCompare(b));
}

/** CSS snippet names (without extension) in `<config>/snippets`. */
export async function listSnippets(configDir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(path.join(configDir, "snippets")).catch(() => [] as string[]);
  return entries.filter(name => name.toLowerCase().endsWith(".css")).map(name => name.slice(0, -4)).sort((a, b) => a.localeCompare(b));
}

async function read(file: string): Promise<string> { return fs.promises.readFile(file, "utf8").catch(() => ""); }

/** Applies the selected theme and enabled snippets to a document; a missing theme falls back to the default look. */
export async function applyCustomCss(config: VaultConfig, doc: Document = document): Promise<void> {
  const theme = config.get("cssTheme");
  const sheets: Array<[string, string]> = [];
  if (safeName(theme)) sheets.push(["theme", await read(path.join(config.configDir, "themes", theme, "theme.css"))]);
  for (const snippet of config.get("enabledCssSnippets")) if (safeName(snippet)) sheets.push([`snippet:${snippet}`, await read(path.join(config.configDir, "snippets", `${snippet}.css`))]);
  const existing = new Map([...doc.head.querySelectorAll<HTMLStyleElement>("style[data-custom-css]")].map(style => [style.dataset.customCss!, style]));
  for (const [id, css] of sheets) {
    let style = existing.get(id);
    if (!style) { style = doc.createElement("style"); style.dataset.customCss = id; doc.head.append(style); }
    if (style.textContent !== css) style.textContent = css;
    existing.delete(id);
  }
  for (const stale of existing.values()) stale.remove();
}

export function watchCustomCss(config: VaultConfig, doc: Document = document): () => void {
  const apply = () => void applyCustomCss(config, doc).catch(error => console.error("Could not apply custom CSS", error));
  apply();
  const stop = config.onChange(key => { if (key === null || key === "cssTheme" || key === "enabledCssSnippets") apply(); });
  window.addEventListener("custom-css-changed", apply);
  return () => { stop(); window.removeEventListener("custom-css-changed", apply); };
}
