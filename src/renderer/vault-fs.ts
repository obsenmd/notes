import { path, ipcRenderer } from "../../platforms/platform";
export interface ActiveVault {
  id: string;
  path: string;
  name: string;
  /** The scratch vault opened by "Open sandbox vault"; its contents do not persist. */
  sandbox?: boolean;
}

/** The vault this window was opened for, or null in the vault chooser window. */
export function getActiveVault(): ActiveVault | null {
  const vault = ipcRenderer.sendSync("vault") as ActiveVault;
  return vault?.path ? { ...vault, name: path.basename(vault.path) } : null;
}
