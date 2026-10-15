/** "abc-defg-hij" for any form of a Meet link (query string, case), else null. */
export function meetCode(url: string | null | undefined): string | null {
  return url?.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i)?.[1]?.toLowerCase() ?? null;
}
