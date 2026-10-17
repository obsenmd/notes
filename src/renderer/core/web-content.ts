import { process } from "../../../platforms/platform";
/** Readability runs against a clone so toggling reader mode preserves the page. */
export const EXTRACT_ARTICLE = "new Readability(document.cloneNode(true)).parse()";
export { htmlToMarkdown } from "./web-markdown";
import { t } from "../../i18n";

/** A page title as a file name: characters a path cannot hold are dropped or replaced. */
export function titleToFileName(title: string): string {
  const name = title.replace(/[?*]/g, "").replace(/[\\/:]/g, " - ").replace(/[\u00a0\u202f]/g, " ").normalize("NFC");
  const windows = typeof process !== "undefined" && process.platform === "win32";
  const stem = name.replace(/\.[^.]+$/, "");
  if (windows && (/[. ]$/.test(name) || /["<>|]/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem))) return t("plugins.file-explorer.label-untitled-file");
  return name;
}
