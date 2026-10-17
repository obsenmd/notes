import { http, https, Buffer } from "../../platforms/platform";
export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

export interface RequestUrlResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  json: any;
  text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
  arrayBuffer: Promise<ArrayBuffer>;
  json: Promise<any>;
  text: Promise<string>;
}

/** Make an HTTP request through Node so desktop plugins are not limited by renderer CORS. */
export function requestUrl(input: RequestUrlParam | string): RequestUrlResponsePromise {
  const options = typeof input === "string" ? { url: input } : input;
  const response = new Promise<RequestUrlResponse>((resolve, reject) => {
    let target: URL;
    try { target = new URL(options.url); } catch (error) { reject(error); return; }
    const transport = target.protocol === "https:" ? https : target.protocol === "http:" ? http : null;
    if (!transport) { reject(new Error(`Unsupported request protocol: ${target.protocol}`)); return; }
    const headers = { ...(options.headers ?? {}) };
    if (options.contentType && !Object.keys(headers).some(key => key.toLowerCase() === "content-type")) headers["Content-Type"] = options.contentType;
    const request = transport.request(target, { method: options.method ?? "GET", headers }, result => {
      const chunks: Buffer[] = [];
      result.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      result.on("error", reject);
      result.on("end", () => {
        const body = Buffer.concat(chunks);
        const text = body.toString("utf8");
        const status = result.statusCode ?? 0;
        if (options.throw !== false && status >= 400) {
          reject(Object.assign(new Error(`Request failed with status ${status}: ${target.href}`), { status, headers: result.headers }));
          return;
        }
        const responseHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(result.headers)) {
          if (value !== undefined) responseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
        }
        const arrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status, headers: responseHeaders, arrayBuffer, json, text });
      });
    });
    request.on("error", reject);
    if (options.body instanceof ArrayBuffer) request.write(Buffer.from(options.body));
    else if (options.body !== undefined) request.write(options.body);
    request.end();
  });
  return Object.assign(response, {
    arrayBuffer: response.then(value => value.arrayBuffer),
    json: response.then(value => value.json),
    text: response.then(value => value.text),
  });
}

export async function request(input: RequestUrlParam | string): Promise<string> {
  return requestUrl(input).text;
}
