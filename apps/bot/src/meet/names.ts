const nameKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\(you\)|\byou\b/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");

/** Whether Meet's label for a person is the bot itself ("Minute Flow", "MinuteFlow (You)", ...). */
export function isBotName(name: string, botNames: string[]) {
  const key = nameKey(name);
  return !key || botNames.some((b) => nameKey(b) === key);
}
