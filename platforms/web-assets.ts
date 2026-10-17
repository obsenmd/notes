/** Runtime assets are served alongside index.html in dev and production. */
export async function readAsset(relative: string): Promise<string> {
  // Use a runtime base: these are copied public files, not module asset imports.
  const moduleURL = import.meta.url;
  const response = await fetch(new URL(`../${relative}`, moduleURL));
  if (!response.ok) throw new Error(`Unable to load ${relative}: HTTP ${response.status}`);
  return response.text();
}
