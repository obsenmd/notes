import { Buffer } from "node:buffer";

/** PNG bytes with Electron's synchronous NativeImage conversion surface. */
export class BrowserImage {
  constructor(readonly bytes: Uint8Array) {}
  toPNG(): Uint8Array { return this.bytes; }
  toDataURL(): string { return "data:image/png;base64," + Buffer.from(this.bytes).toString("base64"); }
  isEmpty(): boolean { return this.bytes.length === 0; }
}
export const nativeImage = {
  createEmpty: () => new BrowserImage(new Uint8Array()),
  createFromBuffer: (bytes: Uint8Array) => new BrowserImage(bytes),
  createFromDataURL: (url: string) => new BrowserImage(Buffer.from(url.split(",")[1] ?? "", "base64")),
};
