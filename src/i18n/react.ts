import { useTranslation } from "react-i18next";
import { NAMESPACE, i18next, t } from "./index";

/** Returns the shared translator and re-renders the caller when the language changes. */
export function useT(): typeof t {
  useTranslation(NAMESPACE, { i18n: i18next, bindI18n: "languageChanged", bindI18nStore: "added" } as Parameters<typeof useTranslation>[1]);
  return t;
}
