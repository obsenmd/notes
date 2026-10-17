import { EventEmitter } from "../../platforms/platform";
export const versionModel = Object.freeze({ version: "0.1.0", apiVersion: "1.12.7", updateEndpoint: null as string | null });

/** Replace this controller when an Obsen release service is available. */
export class VersionController extends EventEmitter {
  check() { return { ...versionModel, upToDate: true, status: "up-to-date" as const }; }
  constructor() {
    super();
    this.on("check", () => {
      this.emit("check-start");
      queueMicrotask(() => { this.check(); this.emit("check-end"); });
    });
  }
}
