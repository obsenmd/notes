import { FileView } from "./file-views";
import type { TFile } from "./vault";
import type { WorkspaceLeaf } from "./workspace";

/** Native media views are available independently of the core plugin list. */
export const MEDIA_EXTENSIONS = {
  image: ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"],
  audio: ["mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus"],
  video: ["mp4", "webm", "ogv", "mov", "mkv"],
} as const;
type MediaType = keyof typeof MEDIA_EXTENSIONS;

export class MediaFileView extends FileView {
  constructor(leaf: WorkspaceLeaf, readonly type: MediaType) { super(leaf); }
  getViewType(): string { return this.type; }
  getIcon(): string { return this.type === "image" ? "lucide-image" : this.type === "audio" ? "lucide-file-audio" : "lucide-file-video"; }
  canAcceptExtension(extension: string): boolean { return (MEDIA_EXTENSIONS[this.type] as readonly string[]).includes(extension.toLowerCase()); }
  async onLoadFile(file: TFile): Promise<void> {
    this.contentEl.replaceChildren();
    const holder = this.contentEl.createDiv(`${this.type}-container`);
    const media = holder.createEl(this.type === "image" ? "img" : this.type);
    media.src = this.app.vault.getResourcePath(file);
    if (this.type !== "image") (media as HTMLMediaElement).controls = true;
  }
  async onUnloadFile(): Promise<void> {
    for (const media of this.contentEl.querySelectorAll("audio,video")) (media as HTMLMediaElement).pause();
    this.contentEl.replaceChildren();
  }
  async onRename(file: TFile): Promise<void> { await super.onRename(file); await this.onLoadFile(file); }
}
