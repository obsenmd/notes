import i18next from "i18next";
import en from "../../assets/obsidian/locales/en.json";
import appEn from "../locales/app/en.json";

/** Namespace used by the reference resource files. */
export const NAMESPACE = "default";
export const FALLBACK_LANGUAGE = "en";
const LANGUAGE_STORAGE_KEY = "language";

type Resources = { [key: string]: string | Resources };
export type TranslationValues = Record<string, unknown>;

interface Brand { original: string; name: string; overrides: Map<string, string> }
const brand: Brand = { original: "Obsidian", name: "Obsidian", overrides: new Map() };

/** Reads the `[key]` / `translation=` sections of brand.txt. */
export function parseBrand(source: string): void {
  brand.overrides.clear();
  let section = "";
  for (const line of source.split(/\r?\n/)) {
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) { section = heading[1]; continue; }
    const field = line.match(/^([^=]+)=(.*)$/);
    if (!field) continue;
    if (section === "brand") {
      if (field[1] === "original") brand.original = field[2];
      if (field[1] === "translation") brand.name = field[2];
    } else if (field[1] === "translation") brand.overrides.set(section, field[2]);
  }
}

// Branding is applied to resources, so interpolated user values are never rewritten.
function applyBrand(resources: Resources): Resources {
  const output: Resources = {};
  for (const [key, value] of Object.entries(resources)) {
    output[key] = typeof value === "string" ? value.split(brand.original).join(brand.name) : applyBrand(value);
  }
  return output;
}

function addLanguage(language: string, resources: Resources): void {
  i18next.addResourceBundle(language, NAMESPACE, applyBrand(resources), true, true);
  for (const [key, value] of brand.overrides) i18next.addResource(language, NAMESPACE, key, value);
}

export interface I18nOptions {
  /** Contents of brand.txt. */
  brand?: string;
  language?: string;
  /** Returns the parsed resource file for a language, or null when it is not shipped. */
  loadLanguage?: (language: string) => Resources | null | Promise<Resources | null>;
}

let loadLanguage: I18nOptions["loadLanguage"];

/** Synchronous so that non-React runtime code can translate during module setup. */
export function initI18n(options: I18nOptions = {}): typeof i18next {
  if (options.brand !== undefined) parseBrand(options.brand);
  loadLanguage = options.loadLanguage;
  if (!i18next.isInitialized) {
    void i18next.init({
      lng: FALLBACK_LANGUAGE, fallbackLng: FALLBACK_LANGUAGE,
      ns: [NAMESPACE], defaultNS: NAMESPACE,
      keySeparator: ".", nsSeparator: ":",
      interpolation: {
        alwaysFormat: true, escapeValue: false,
        format: (value, format, language) => {
          if (typeof value === "number") return value.toLocaleString(language);
          if (typeof value === "string" && format === "lowercase") return value.toLocaleLowerCase(language);
          if (typeof value === "string" && format === "capitalize") return value.charAt(0).toLocaleUpperCase(language) + value.slice(1);
          return String(value);
        },
      },
      returnNull: false, initAsync: false, resources: {}, showSupportNotice: false,
    });
  }
  // Used by resources such as "Toggle {{color, lowercase}} highlight".
  i18next.services.formatter?.add("lowercase", value => String(value).toLocaleLowerCase(getLanguage()));
  // Copy that has no counterpart in the reference resources lives under the `obsen` key.
  addLanguage(FALLBACK_LANGUAGE, { ...(en as Resources), obsen: appEn as Resources });
  if (options.language && options.language !== FALLBACK_LANGUAGE) void setLanguage(options.language, false);
  return i18next;
}

export function getLanguage(): string { return i18next.language || FALLBACK_LANGUAGE; }

export function getStoredLanguage(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string {
  try { return storage?.getItem(LANGUAGE_STORAGE_KEY) || FALLBACK_LANGUAGE; } catch { return FALLBACK_LANGUAGE; }
}

export async function setLanguage(language: string, persist = true): Promise<void> {
  if (language !== FALLBACK_LANGUAGE && !i18next.hasResourceBundle(language, NAMESPACE)) {
    const resources = await loadLanguage?.(language);
    if (resources) addLanguage(language, resources);
  }
  await i18next.changeLanguage(language);
  if (persist) try { globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, language); } catch { /* storage is optional */ }
}

/**
 * Translates a key from the reference resources. The resource files use the
 * `key` / `key_plural` pair for every language, so the plural form is selected
 * here rather than through per-language plural categories.
 */
export function t(key: string, values?: TranslationValues): string {
  if (!i18next.isInitialized) initI18n();
  const count = values?.count;
  const resolved = typeof count === "number" && count !== 1 && i18next.exists(`${key}_plural`) ? `${key}_plural` : key;
  return (i18next.t as (key: string, options: TranslationValues) => string)(resolved, values ?? {});
}

export function hasTranslation(key: string): boolean {
  if (!i18next.isInitialized) initI18n();
  return i18next.exists(key);
}

export function brandName(): string { return brand.name; }

/** Every resource of the active language (falling back to English), keyed by dotted path. */
export function flatResources(): Record<string, string> {
  if (!i18next.isInitialized) initI18n();
  const output: Record<string, string> = {};
  const walk = (node: Resources, prefix: string) => { for (const [key, value] of Object.entries(node)) { if (typeof value === "string") output[prefix + key] = value; else walk(value, `${prefix}${key}.`); } };
  for (const language of [FALLBACK_LANGUAGE, getLanguage()]) { const bundle = i18next.getResourceBundle(language, NAMESPACE) as Resources | undefined; if (bundle) walk(bundle, ""); }
  return output;
}

export { i18next };
