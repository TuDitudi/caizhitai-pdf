export function assetUrl(path: string): string {
  return new URL(import.meta.env.BASE_URL + path, window.location.origin).href;
}
