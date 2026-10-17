import { process } from "../../platforms/platform";
import { t } from "../i18n";
import { type MetadataCache } from "./metadata-cache";
import { type TAbstractFile, TFile, TFolder, Vault, type DataWriteOptions } from "./vault";
import { type Workspace } from "./workspace";
import { normalizePath, parseYaml, stringifyYaml } from "./utilities";

/** Host preferences and UI hooks used by the file manager facade. */
export interface FileManagerOptions {
  /** Return false to cancel a deletion request. Defaults to accepting. */
  confirmDelete?: (file: TAbstractFile) => boolean | Promise<boolean>;
  /** true selects OS trash; false selects the vault's local trash. */
  useSystemTrash?: () => boolean;
  /** Directory for attachments; defaults to the source note's folder. */
  attachmentFolder?: (sourcePath: string, filename: string) => string | Promise<string>;
  /** Optional host policy for updating links after a move. */
  updateLinks?: (file: TAbstractFile, oldPath: string, newPath: string) => void | Promise<void>;
  /** "New link format" and "Use [[Wikilinks]]" from the vault settings. */
  linkSettings?: () => { newLinkFormat?: string; useMarkdownLinks?: boolean };
  /** Optional UI action used by plugin link-opening helpers. */
  openLink?: (linktext: string, sourcePath: string, newLeaf?: string | boolean) => void | Promise<void>;
}

/**
 * Plugin-facing file operations. The host supplies its preferences and UI
 * hooks; all storage mutations flow through Vault so its tree and events stay
 * synchronized.
 */
export class FileManager {
  constructor(
    readonly vault: Vault,
    readonly workspace?: Workspace,
    readonly metadataCache?: MetadataCache,
    private readonly options: FileManagerOptions = {},
  ) {}

  getNewFileParent(sourcePath: string, newFilePath?: string): TFolder {
    const destination = normalizePath(newFilePath ?? "");
    const source = this.vault.getAbstractFileByPath(sourcePath);
    const sourceParent = source instanceof TFolder ? source : source?.parent;
    const destinationParent = destination.includes("/")
      ? this.vault.getFolderByPath(destination.slice(0, destination.lastIndexOf("/")))
      : null;
    return destinationParent ?? sourceParent ?? this.vault.getRoot();
  }
  async createNewMarkdownFile(parent: TFolder, filename?: string, content = ""): Promise<TFile> {
    const base = filename?.trim().replace(/\.md$/i, "") || "Untitled";
    const prefix = parent.isRoot() ? "" : `${parent.path}/`;
    return this.vault.create(this.vault.getAvailablePath(prefix + base, "md"), content);
  }

  /**
   * Host hooks for the link update that follows a rename or move: `confirm` may decline it
   * (the "Update links" prompt), `done` reports what changed. Without a host, links always update.
   */
  linkUpdateHost?: { confirm?(links: number, files: number): boolean | Promise<boolean>; done?(links: number, files: number): void };

  async renameFile(file: TAbstractFile, newPath: string): Promise<void> {
    this.assertOwned(file);
    const oldPath = file.path;
    const normalized = normalizePath(newPath);
    const references = this.collectReferences(file);
    // Paths as they were when the references were collected.
    for (const [source, list] of references) for (const entry of [source, ...list.map(item => item.target)]) (entry as TFile & { pathBeforeMove?: string }).pathBeforeMove = entry.path;
    await this.vault.rename(file, normalized);
    await this.options.updateLinks?.(file, oldPath, normalized);
    const links = [...references.values()].reduce((sum, list) => sum + list.length, 0);
    if (!links || this.options.updateLinks) return;
    if (this.linkUpdateHost?.confirm && !(await this.linkUpdateHost.confirm(links, references.size))) return;
    let updated = 0, files = 0;
    // Renaming replaces the file objects under the moved path, so both ends are looked up again.
    const current = (entry: TFile): TFile | null => {
      const before = (entry as TFile & { pathBeforeMove?: string }).pathBeforeMove ?? entry.path;
      const now = this.vault.getAbstractFileByPath(before === oldPath ? normalized : before.startsWith(oldPath + "/") ? normalized + before.slice(oldPath.length) : before);
      return now instanceof TFile ? now : null;
    };
    for (const [staleSource, list] of references) {
      const source = current(staleSource); if (!source) continue;
      let changed = 0;
      await this.vault.process(source, content => {
        // Later references first, so earlier offsets stay valid.
        for (const reference of [...list].sort((a, b) => b.start - a.start)) {
          if (content.slice(reference.start, reference.end) !== reference.original) continue;
          const target = current(reference.target);
          const replacement = target && this.rewriteLink(reference.original, target, source.path);
          if (!replacement || replacement === reference.original) continue;
          content = content.slice(0, reference.start) + replacement + content.slice(reference.end); changed++;
        }
        return content;
      });
      if (changed) { updated += changed; files++; }
    }
    if (updated) this.linkUpdateHost?.done?.(updated, files);
  }

  /** Links and embeds in other notes that point at `file` (or at files inside it, for a folder). */
  private collectReferences(file: TAbstractFile): Map<TFile, Array<{ start: number; end: number; original: string; target: TFile }>> {
    const result = new Map<TFile, Array<{ start: number; end: number; original: string; target: TFile }>>();
    const cache = this.metadataCache; if (!cache) return result;
    const moved = new Map<string, TFile>();
    if (file instanceof TFile) moved.set(file.path, file);
    else for (const entry of this.vault.getFiles()) if (entry.path.startsWith(file.path + "/")) moved.set(entry.path, entry);
    for (const [sourcePath, targets] of Object.entries(cache.resolvedLinks)) {
      if (!Object.keys(targets).some(target => moved.has(target))) continue;
      const source = this.vault.getAbstractFileByPath(sourcePath);
      if (!(source instanceof TFile)) continue;
      const metadata = cache.getFileCache(source), list: Array<{ start: number; end: number; original: string; target: TFile }> = [];
      for (const reference of [...(metadata?.links ?? []), ...(metadata?.embeds ?? [])]) {
        const linkpath = reference.link.split("#")[0]; if (!linkpath) continue;
        let decoded = linkpath; try { decoded = decodeURIComponent(linkpath); } catch { /* not an encoded path */ }
        const target = moved.get((cache.getFirstLinkpathDest(linkpath, sourcePath) ?? cache.getFirstLinkpathDest(decoded, sourcePath))?.path ?? "");
        if (target) list.push({ start: reference.position.start.offset, end: reference.position.end.offset, original: reference.original, target });
      }
      if (list.length) result.set(source, list);
    }
    return result;
  }

  /** The same link, embed marker, subpath and alias, pointing at the target's current path. */
  private rewriteLink(original: string, target: TFile, sourcePath: string): string | null {
    const wiki = /^(!?)\[\[([^\]|#]*)(#[^\]|]*)?(\|[^\]]*)?\]\]$/.exec(original);
    if (wiki) {
      // A link written as a path stays a path; otherwise the vault's link format decides.
      const linktext = wiki[2].includes("/") && (this.options.linkSettings?.().newLinkFormat ?? "shortest") === "shortest" ? stripExtension(target.path) + (target.extension === "md" ? "" : "." + target.extension) : this.fileToLinktext(target, sourcePath);
      return wiki[1] + "[[" + linktext + (wiki[3] ?? "") + (wiki[4] ?? "") + "]]";
    }
    const markdown = /^(!?)\[([^\]]*)\]\((<?)([^)#>]*)(#[^)>]*)?(>?)\)$/.exec(original);
    if (markdown) {
      const relative = this.fileToLinktext(target, sourcePath, false);
      const url = markdown[3] ? relative : relative.split("/").map(encodeURIComponent).join("/");
      return markdown[1] + "[" + markdown[2] + "](" + markdown[3] + url + (markdown[5] ?? "") + markdown[6] + ")";
    }
    return null;
  }

  async promptForDeletion(file: TAbstractFile): Promise<boolean> {
    this.assertOwned(file);
    return this.options.confirmDelete ? Boolean(await this.options.confirmDelete(file)) : true;
  }

  async trashFile(file: TAbstractFile): Promise<void> {
    this.assertOwned(file);
    await this.vault.trash(file, this.options.useSystemTrash?.() ?? false);
  }

  /**
   * The link text for a file as seen from a note, following "New link format": the shortest
   * unambiguous name, a path relative to the note, or the path from the vault root.
   */
  fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true): string {
    const isNote = file.extension === "md";
    const path = isNote && omitMdExtension ? stripExtension(file.path) : file.path;
    const format = this.options.linkSettings?.().newLinkFormat ?? "shortest";
    if (format === "absolute") return path;
    if (format === "relative") return relativePath(dirname(normalizePath(sourcePath)), path);
    const name = file.name.toLocaleLowerCase();
    const sameName = this.vault.getFiles().filter(entry => entry.name.toLocaleLowerCase() === name);
    return sameName.length > 1 ? path : isNote && omitMdExtension ? file.basename : file.name;
  }

  generateMarkdownLink(file: TFile, sourcePath: string, subpath?: string, alias?: string): string {
    this.assertOwned(file);
    const suffix = subpath?.startsWith("#") ? subpath : subpath ? "#" + subpath : "";
    const embed = file.extension !== "md" && /^(?:png|jpe?g|gif|bmp|svg|webp|avif|mp3|wav|m4a|ogg|3gp|flac|webm|mp4|mov|mkv|ogv|pdf)$/i.test(file.extension) ? "!" : "";
    if (this.options.linkSettings?.().useMarkdownLinks) {
      const target = this.fileToLinktext(file, sourcePath, false).split("/").map(encodeURIComponent).join("/");
      return embed + "[" + (alias ?? (embed ? "" : file.basename)) + "](" + target + encodeURI(suffix) + ")";
    }
    return embed + "[[" + this.fileToLinktext(file, sourcePath) + suffix + (alias ? "|" + alias : "") + "]]";
  }

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void, options?: DataWriteOptions): Promise<void> {
    this.assertOwned(file);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") throw new Error(t("obsen.errors.frontmatter-markdown"));
    await this.vault.process(file, (data) => {
      const normalized = data.replace(/^\uFEFF/, "");
      const match = normalized.match(/^(---\s*\r?\n)([\s\S]*?)(\r?\n---\s*(?:\r?\n|$))/);
      const initial = match ? parseYaml(match[2]) : {};
      if (initial !== null && (typeof initial !== "object" || Array.isArray(initial))) {
        throw new Error(t("obsen.errors.frontmatter-mapping"));
      }
      const frontmatter = { ...(initial as Record<string, unknown> | null ?? {}) };
      fn(frontmatter);
      const yaml = stringifyYaml(frontmatter).replace(/\n+$/, "");
      if (match) return `${match[1]}${yaml}${match[3]}${normalized.slice(match[0].length)}`;
      return `---\n${yaml}\n---\n${normalized}`;
    }, options);
  }

  async getAvailablePathForAttachment(filename: string, sourcePath?: string): Promise<string> {
    const cleanName = normalizePath(filename).split("/").pop() ?? "";
    if (!cleanName || cleanName === "." || cleanName === "..") throw new Error(t("obsen.errors.attachment-filename"));
    const source = sourcePath || (this.workspace?.activeLeaf?.view.getState()?.file as string | undefined) || "";
    const configured = await this.options.attachmentFolder?.(source, cleanName);
    const folder = normalizePath(configured ?? dirname(source));
    await this.ensureFolder(folder);
    const base = folder ? `${folder}/${cleanName}` : cleanName;
    if (!await this.vault.adapter.exists(base)) return base;
    const dot = cleanName.lastIndexOf(".");
    const stem = dot > 0 ? cleanName.slice(0, dot) : cleanName;
    const ext = dot > 0 ? cleanName.slice(dot) : "";
    for (let index = 1; ; index++) {
      const candidateName = `${stem} ${index}${ext}`;
      const candidate = folder ? `${folder}/${candidateName}` : candidateName;
      if (!await this.vault.adapter.exists(candidate)) return candidate;
    }
  }

  /** Resolve a wikilink through MetadataCache using a vault-relative source. */
  resolveLink(linktext: string, sourcePath: string): TFile | null {
    const path = linktext.trim().replace(/^!?(?:\[\[)?/, "").replace(/(?:\]\])$/, "").split(/[|#]/, 1)[0];
    const metadataFile = this.metadataCache?.getFirstLinkpathDest(path, sourcePath);
    return metadataFile ? this.vault.getFileByPath(metadataFile.path) : null;
  }

  async openLinkText(linktext: string, sourcePath: string, newLeaf?: string | boolean): Promise<void> {
    if (this.options.openLink) return this.options.openLink(linktext, sourcePath, newLeaf);
    if (!this.workspace) throw new Error(t("obsen.errors.link-opening-unavailable"));
    const file = this.resolveLink(linktext, sourcePath);
    if (!file) throw new Error(t("obsen.errors.unresolved-link", { linktext }));
    const pane = newLeaf === "tab" || newLeaf === "split" || newLeaf === "window" ? newLeaf : newLeaf === true;
    const leaf = pane ? this.workspace.getLeaf(pane) : this.workspace.getMostRecentLeaf();
    if (!leaf) throw new Error(t("obsen.errors.workspace-leaf-unavailable"));
    await leaf.openFile(file);
  }

  private assertOwned(file: TAbstractFile): void {
    if (file.vault !== this.vault || this.vault.getAbstractFileByPath(file.path) !== file) {
      throw new Error(t("obsen.errors.file-not-in-vault"));
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of normalizePath(path).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (this.vault.getFolderByPath(current)) continue;
      if (this.vault.getAbstractFileByPath(current)) throw new Error(t("obsen.errors.attachment-not-folder", { current }));
      await this.vault.createFolder(current);
    }
  }
}

function stripExtension(path: string): string { return path.replace(/\.[^/.]+$/, ""); }
function dirname(path: string): string { const index = path.lastIndexOf("/"); return index < 0 ? "" : path.slice(0, index); }
function relativePath(from: string, to: string): string {
  const a = from.split("/").filter(Boolean), b = to.split("/").filter(Boolean);
  while (a.length && b.length && a[0].toLocaleLowerCase() === b[0].toLocaleLowerCase()) { a.shift(); b.shift(); }
  return [...a.map(() => ".."), ...b].join("/");
}
