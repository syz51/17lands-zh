const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const PATTERN = `https://cards\\.scryfall\\.io/(?:small|normal|large|png|border_crop|thumb|grid|display)/(front|back)/[a-f0-9]/[a-f0-9]/(${UUID})\\.(?:jpg|jpeg|png|webp)(?:\\?[^\\s"'<>),]*)?`;

export function printingIn(original: string): { id: string; face: 'front' | 'back' } | undefined {
  const match = new RegExp(`^${PATTERN}$`, 'i').exec(original);
  if (!match) return undefined;
  return { id: match[2]!.toLowerCase(), face: match[1]!.toLowerCase() as 'front' | 'back' };
}

/** The UUID identifies an exact printing; the face is preserved for double-faced cards. */
export function chineseImageUrl(original: string): string | undefined {
  const match = new RegExp(`^${PATTERN}$`, 'i').exec(original);
  if (!match) return undefined;
  const face = match[1]!.toLowerCase();
  const id = match[2]!.toLowerCase();
  return `https://images.mtgch.com/zhs/large/${face}/${id[0]}/${id[1]}/${id}.webp`;
}

export function cardImagesIn(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of value.matchAll(new RegExp(PATTERN, 'gi'))) {
    result.set(match[0], chineseImageUrl(match[0])!);
  }
  return result;
}

export function replaceImages(value: string, replacements: ReadonlyMap<string, string>): string {
  // One pass prevents one image's replacement from becoming another replacement's input.
  return value.replace(new RegExp(PATTERN, 'gi'), (url) => replacements.get(url) ?? url);
}

export function restoreImages(value: string, replacements: ReadonlyMap<string, string>): string {
  for (const [original, translated] of replacements) {
    value = value.split(translated).join(original);
  }
  return value;
}
