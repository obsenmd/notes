import { useLayoutEffect } from "react";
import { showLoadingSurface } from "./loading";

/** Shares the startup animation while a vault is being prepared. */
export function LoadingSurface({ message }: { message: string }) {
  useLayoutEffect(() => {
    const loading = showLoadingSurface(message);
    return () => loading.dispose();
  }, [message]);
  return null;
}
