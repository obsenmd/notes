import { fsp as fs, path } from "../../platforms/platform";
interface RulePart { text: string; before: boolean; after: boolean }
interface Rule { domain: boolean; start: boolean; end: boolean; parts: RulePart[] }
const stripDomain = (url: string) => url.replace(/^https?:\/\//, "").replace(/^www\./, "");
const separator = (char: string | undefined) => char !== undefined && "/:?=&".includes(char);

/** The pinned desktop's URL rules; cosmetic, exception, option and regex rules are ignored there. */
export class AdblockRules {
  private readonly rules: Rule[] = [];
  addList(text: string): void {
    for (const raw of text.split("\n")) {
      let value = raw.trim().replace(/[\r\n]/g, "");
      if (value.length <= 3 || value.startsWith("!") || value.includes("##") || value.startsWith("@@")) continue;
      const rule: Rule = { domain: false, start: false, end: false, parts: [] };
      if (value.startsWith("||")) { rule.domain = true; value = stripDomain(value.slice(2)); }
      else if (value.startsWith("|")) { rule.start = true; value = value.slice(1); }
      else if (value.endsWith("|")) { rule.end = true; value = value.slice(0, -1); }
      if (value.includes("$") || (value.startsWith("/") && value.endsWith("/")) || value.length <= 3) continue;
      for (const fragment of value.split(/\*+/).filter(Boolean)) {
        const parts = fragment.split("^");
        parts.forEach((part, index) => { if (part) rule.parts.push({ text: part, before: index > 0, after: index + 1 < parts.length }); });
      }
      this.rules.push(rule);
    }
  }
  matches(url: string): boolean {
    let domain: string | undefined;
    return this.rules.some(rule => {
      const text = rule.domain ? domain ??= stripDomain(url) : url;
      let previous = -1;
      for (let index = 0; index < rule.parts.length; index++) {
        const part = rule.parts[index]!, at = text.indexOf(part.text, previous + 1);
        if (at <= previous || (rule.start && index === 0 && at !== 0) || (rule.end && index === rule.parts.length - 1 && at !== text.length - part.text.length)) return false;
        if (part.before && !separator(text[at - 1])) return false;
        const after = text[at + part.text.length];
        if (part.after && after !== undefined && !separator(after)) return false;
        previous = at;
      }
      return true;
    });
  }
}

export const DEFAULT_ADBLOCK_LISTS = ["https://easylist.to/easylist/easylist.txt", "https://easylist.to/easylist/easyprivacy.txt"];

/** Global list cache with the reference's day-based update interval (zero disables refresh). */
export class AdblockLists {
  rules = new AdblockRules();
  private pending = Promise.resolve();
  constructor(private readonly directory: string, private readonly fetchText: (url: string) => Promise<string>, private readonly now = Date.now) {}
  update(urls: string[], days: number): Promise<void> {
    this.pending = this.pending.catch(() => undefined).then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const rules = new AdblockRules();
      for (const url of urls) {
        const filename = path.join(this.directory, path.basename(url));
        try {
          const stat = await fs.stat(filename).catch(() => null);
          if (stat && (days === 0 || (this.now() - stat.mtimeMs) / 86400000 < days)) { rules.addList(await fs.readFile(filename, "utf8")); continue; }
          const text = await this.fetchText(url);
          await fs.writeFile(filename, text); rules.addList(text);
        } catch (error) { console.log("Failed to retrieve adblock list: " + error); }
      }
      this.rules = rules;
    });
    return this.pending;
  }
}
