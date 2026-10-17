import { path, originalFs as fs, ipcRenderer } from "../../platforms/platform";
import { useEffect, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";



import { renderMarkdown } from "../compat/markdown-parser";
import { Modal, Notice } from "../compat/ui";
import { t } from "../i18n";
import { useT } from "../i18n/react";
import { listThemes } from "./custom-css";
import type { SettingsEnvironment } from "./settings/controls";
import { installTheme, type CommunityTheme } from "./themes";
import { SearchInput, cx } from "./ui";

type Kind = "plugin" | "theme";
interface Listing { id: string; name: string; author: string; description: string; repo: string; screenshot?: string }
const REGISTRY = "https://raw.githubusercontent.com/obsidianmd/obsidian-releases/HEAD/";

async function download(url: string): Promise<string> {
  const response = await ipcRenderer.invoke("community:fetch", url) as { status: number; text: string };
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  return response.text;
}
const validRepo = (repo: string) => /^[\w.-]+\/[\w.-]+$/.test(repo);

async function loadListings(kind: Kind): Promise<Listing[]> {
  const raw: unknown = JSON.parse(await download(REGISTRY + (kind === "plugin" ? "community-plugins.json" : "community-css-themes.json")));
  if (!Array.isArray(raw)) throw new Error("registry");
  return raw.filter(item => item && typeof item.name === "string" && typeof item.repo === "string" && validRepo(item.repo))
    .map(item => ({ id: typeof item.id === "string" ? item.id : item.name, name: item.name, author: String(item.author ?? ""), description: String(item.description ?? ""), repo: item.repo, screenshot: typeof item.screenshot === "string" ? item.screenshot : undefined }));
}

function Browser({ kind, environment }: { kind: Kind; environment: SettingsEnvironment }) {
  const t = useT();
  const { config, host, vault } = environment;
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Listing | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [readme, setReadme] = useState<string | null>(null);

  const refreshInstalled = () => void (kind === "theme" ? listThemes(config.configDir)
    : fs.promises.readdir(path.join(config.configDir, "plugins")).catch(() => [] as string[])).then(names => setInstalled(new Set(names)));
  useEffect(() => { refreshInstalled(); void loadListings(kind).then(setListings).catch(() => setFailed(true)); }, [kind]);
  useEffect(() => {
    setReadme(null);
    if (!selected) return;
    let cancelled = false;
    void download(`https://raw.githubusercontent.com/${selected.repo}/HEAD/README.md`).then(text => { if (!cancelled) setReadme(text); }).catch(() => { if (!cancelled) setReadme(""); });
    return () => { cancelled = true; };
  }, [selected]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (listings ?? []).filter(item => !needle || `${item.name} ${item.author} ${item.description}`.toLowerCase().includes(needle)).slice(0, 200);
  }, [listings, query]);
  const isInstalled = (item: Listing) => installed.has(kind === "theme" ? item.name : item.id);

  const install = async (item: Listing) => {
    setBusy(true);
    try {
      if (kind === "theme") {
        await installTheme(vault.path, item as CommunityTheme);
        config.set("cssTheme", item.name);
      } else {
        new Notice(t("setting.third-party-plugin.msg-installing-plugin", { name: item.name }));
        const base = `https://github.com/${item.repo}/releases/latest/download/`;
        const [manifest, main, styles] = await Promise.all([download(base + "manifest.json"), download(base + "main.js"), download(base + "styles.css").catch(() => "")]);
        await host.pluginLoader.install(vault.path, item.id, { manifest: JSON.parse(manifest), main, styles }, false);
        new Notice(t("setting.third-party-plugin.msg-successfully-installed-plugin", { name: item.name }));
      }
      refreshInstalled(); window.dispatchEvent(new Event("custom-css-changed"));
    } catch (error) {
      console.error(error);
      new Notice(t(kind === "plugin" ? "setting.third-party-plugin.msg-failed-to-install-plugin" : "plugins.custom-css.msg-failed-to-install-theme", { name: item.name }));
    } finally { setBusy(false); }
  };
  const uninstall = async (item: Listing) => {
    setBusy(true);
    try {
      if (kind === "theme") { if (config.get("cssTheme") === item.name) config.set("cssTheme", ""); await fs.promises.rm(path.join(config.configDir, "themes", item.name), { recursive: true, force: true }); }
      else { await host.pluginLoader.setEnabled(vault.path, item.id, false); await fs.promises.rm(path.join(config.configDir, "plugins", item.id), { recursive: true, force: true }); }
      refreshInstalled();
    } catch { new Notice(t("setting.third-party-plugin.msg-failed-to-uninstall-plugin", { id: item.id })); }
    finally { setBusy(false); }
  };

  return <>
    <div className="modal-sidebar community-modal-sidebar">
      <div className="community-modal-controls">
        <div className="setting-item"><div className="setting-item-control">
          <SearchInput value={query} onChange={setQuery} autoFocus placeholder={t(kind === "plugin" ? "setting.third-party-plugin.placeholder-community-plugins" : "plugins.custom-css.prompt-filter")} />
        </div></div>
      </div>
      <div className="community-modal-search-summary u-muted">{listings ? t("setting.third-party-plugin.label-search-summary", { pluginCount: t(kind === "plugin" ? "nouns.plugin-with-count" : "nouns.theme-with-count", { count: shown.length }) }) : ""}</div>
      <div className="community-modal-search-results-wrapper">
        <div className="community-modal-search-results">
          {shown.map(item => <div key={item.id} className={cx("community-item", selected?.id === item.id && "is-selected")} onClick={() => setSelected(item)}>
            {kind === "theme" && item.screenshot && <div className="community-item-screenshot"><img alt={item.name} loading="lazy" src={`https://raw.githubusercontent.com/${item.repo}/HEAD/${item.screenshot}`} /></div>}
            <div className="community-item-name">{item.name}{isInstalled(item) && <span className="flair mod-pop">{t("setting.third-party-plugin.label-installed")}</span>}</div>
            <div className="community-item-author">{t("setting.third-party-plugin.label-by-author")}{item.author}</div>
            <div className="community-item-desc">{item.description}</div>
          </div>)}
        </div>
        {(!listings || !shown.length) && <div className="community-modal-search-results-status"><div className="community-modal-search-results-status-content">
          {failed ? t("setting.third-party-plugin.msg-failed-load-plugins") : !listings ? t("dialogue.msg-loading") : t("setting.third-party-plugin.label-no-results-found")}
        </div></div>}
      </div>
    </div>
    <div className="community-modal-details" style={selected ? undefined : { display: "none" }}>
      {selected && <>
        <div className="community-modal-info">
          <div className="community-modal-info-name">{selected.name}{isInstalled(selected) && <span className="flair mod-pop">{t("setting.third-party-plugin.label-installed")}</span>}</div>
          <div className="community-modal-info-author">{t("setting.third-party-plugin.label-by-author")}{selected.author}</div>
          <div className="community-modal-info-repo">{t("setting.third-party-plugin.label-repository")}<a href={`https://github.com/${selected.repo}`} target="_blank" rel="noopener nofollow">{selected.repo}</a></div>
          <div className="community-modal-info-desc">{selected.description}</div>
        </div>
        <div className="community-modal-button-container">
          {isInstalled(selected)
            ? <button className="mod-danger" disabled={busy} onClick={() => void uninstall(selected)}>{t("setting.third-party-plugin.label-uninstall")}</button>
            : <button className="mod-cta" disabled={busy} onClick={() => void install(selected)}>{t(kind === "theme" ? "plugins.custom-css.label-install-and-use" : "setting.third-party-plugin.button-install")}</button>}
        </div>
        <hr />
        <div className="community-modal-readme markdown-rendered" ref={el => { if (el && readme !== null) { if (readme) renderMarkdown(readme, el); else el.textContent = t("setting.third-party-plugin.label-no-readme"); } }}>{readme === null ? t("dialogue.msg-loading") : null}</div>
      </>}
    </div>
  </>;
}

/** Opens the community directory for plugins or themes. */
export function openCommunityModal(kind: Kind, environment: SettingsEnvironment, onClose?: () => void): void {
  let root: Root | null = null;
  class CommunityModal extends Modal {
    override onOpen() {
      this.modalEl.classList.add("mod-community-modal", "mod-sidebar-layout", kind === "plugin" ? "mod-community-plugin" : "mod-community-theme");
      this.setTitle(t(kind === "plugin" ? "setting.third-party-plugin.name" : "setting.appearance.option-community-themes"));
      this.contentEl.style.display = "contents";
      root = createRoot(this.contentEl);
      root.render(<Browser kind={kind} environment={environment} />);
    }
    override onClose() { root?.unmount(); root = null; onClose?.(); }
  }
  new CommunityModal(environment.host.app).open();
}
