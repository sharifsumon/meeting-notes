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

const words = (name: string) => name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * Drops names that are a shorter form of another name in the list, such as one person signed in on
 * two devices as "Shariful Islam" and "Mohammed Shariful Islam". A single word only counts when
 * it is the other name's first name, so "Islam" alone isn't folded into someone else.
 */
export function dedupeNames(names: string[]): string[] {
  const unique = [...new Map(names.map((n) => [words(n).join(" "), n.trim()])).values()].filter(Boolean);
  return unique.filter((name) => {
    const w = words(name);
    return !unique.some((other) => {
      if (other === name) return false;
      const o = words(other);
      if (o.length <= w.length || !w.every((x) => o.includes(x))) return false;
      return w.length >= 2 || o[0] === w[0];
    });
  });
}

/**
 * The fullest form of a name among the participants: captions may say "Shariful Islam" while the
 * People list says "Mohammed Shariful Islam".
 */
export function fullName(name: string, participants: string[]): string {
  const merged = dedupeNames([name, ...participants]);
  if (merged.includes(name.trim())) return name;
  const w = words(name);
  return participants.find((p) => merged.includes(p.trim()) && w.every((x) => words(p).includes(x))) ?? name;
}
