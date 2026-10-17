import { shell, type WebContents } from "../../platforms/platform";
const guestOwners = new WeakSet<WebContents>();
/** Guest popups use the document of their owning workspace window. */
export function installGuestURLRouting(owner: WebContents): void {
  if (guestOwners.has(owner)) return;
  guestOwners.add(owner);
  owner.on("did-attach-webview", (_event, guest) => {
    let foregroundOpen = true;
    guest.setWindowOpenHandler(({ url, frameName, disposition }) => {
      if (disposition === "foreground-tab") { if (!foregroundOpen) return { action: "deny" }; foregroundOpen = false; }
      void routeExternalURL(owner, url, disposition, frameName).catch(error => console.warn(error));
      return { action: "deny" };
    });
    guest.on("did-navigate", () => { foregroundOpen = true; });
  });
}

/** Offer native HTTP(S) opens to the renderer before falling back to the system browser. */
export async function routeExternalURL(contents: WebContents, url: string, disposition?: string, frameName?: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) return;
  if (frameName !== "_external" && !contents.isDestroyed()) {
    const leaf = disposition === "new-window" ? "window" : frameName === "split" ? "split" : "tab";
    const active = disposition === "new-window" || frameName === "split" || disposition === "foreground-tab";
    const options = { cancelable: true, detail: { url, leaf, active } };
    try {
      if (await contents.executeJavaScript(`(() => { const event = new CustomEvent('open-url', ${JSON.stringify(options)}); window.dispatchEvent(event); return event.defaultPrevented; })()`)) return;
    } catch (error) { console.warn(error); }
  }
  await shell.openExternal(url);
}
