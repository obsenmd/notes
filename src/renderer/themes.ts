import { originalFs as fs, path, ipcRenderer } from "../../platforms/platform";
import { apiVersion } from "../compat/utilities";

export interface CommunityTheme { name: string; author: string; repo: string; screenshot?: string; modes?: string[] }
interface ThemeManifest { name: string; version: string; minAppVersion?: string; author: string }
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/), right = b.split(/[.-]/);
  for (let index = 0; index < 3; index++) {
    const difference = (Number(left[index]) || 0) - (Number(right[index]) || 0);
    if (difference) return difference;
  }
  return 0;
}
async function download(url: string): Promise<string> {
  const response = await ipcRenderer.invoke("community:fetch", url) as { status: number; text: string };
  if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(`Download failed (HTTP ${response.status}).`), { status: response.status });
  return response.text;
}
function raw(repo: string, filename: string, revision = "HEAD") {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid theme repository.");
  return `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(revision)}/${filename}`;
}
export async function listCommunityThemes(): Promise<CommunityTheme[]> {
  const value: unknown = JSON.parse(await download(raw("obsidianmd/obsidian-releases", "community-css-themes.json")));
  if (!Array.isArray(value)) throw new Error("Invalid theme registry.");
  return value.filter((item): item is CommunityTheme => typeof item?.name === "string" && typeof item?.repo === "string");
}
export async function selectThemeVersion(theme: CommunityTheme, manifest: ThemeManifest): Promise<string | null> {
  if (!manifest.minAppVersion || compareVersions(apiVersion, manifest.minAppVersion) >= 0) return manifest.version || null;
  const versions: unknown = JSON.parse(await download(raw(theme.repo, "versions.json")));
  if (!versions || typeof versions !== "object") return null;
  return Object.entries(versions).filter((entry): entry is [string, string] => typeof entry[1] === "string" && compareVersions(apiVersion, entry[1]) >= 0)
    .sort(([a], [b]) => compareVersions(b, a))[0]?.[0] ?? null;
}
export async function installTheme(vaultPath: string, theme: CommunityTheme): Promise<void> {
  if (!theme.name || /[\\/<>:"|?*]/.test(theme.name) || theme.name === "." || theme.name === "..") throw new Error("Invalid theme name.");
  let manifest: ThemeManifest | undefined;
  try { manifest = JSON.parse(await download(raw(theme.repo, "manifest.json"))); }
  catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  let manifestText: string, css: string;
  if (manifest) {
    const version = await selectThemeVersion(theme, manifest);
    if (!version) throw new Error(`No theme release supports API version ${apiVersion}.`);
    try {
      manifestText = await download(`https://github.com/${theme.repo}/releases/download/${encodeURIComponent(version)}/manifest.json`);
      css = await download(`https://github.com/${theme.repo}/releases/download/${encodeURIComponent(version)}/theme.css`);
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      manifestText = await download(raw(theme.repo, "manifest.json"));
      css = await download(raw(theme.repo, "theme.css"));
      if (compareVersions(apiVersion, JSON.parse(manifestText).minAppVersion || "0.0.0") < 0) throw new Error("The repository theme requires a newer API version.");
    }
    if (JSON.parse(manifestText).name !== theme.name) throw new Error("Theme manifest name does not match the registry.");
  } else {
    css = await download(raw(theme.repo, "obsidian.css"));
    manifestText = JSON.stringify({ name: theme.name, version: "0.0.0", minAppVersion: "0.16.0", author: theme.author }, null, 2);
  }
  const directory = path.join(vaultPath, ".obsidian", "themes", theme.name);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, "theme.css"), css);
  await fs.promises.writeFile(path.join(directory, "manifest.json"), manifestText);
}
