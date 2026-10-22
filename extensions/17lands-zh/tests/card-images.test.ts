import { describe, expect, test } from 'bun:test';
import { cardImagesIn, chineseImageUrl, replaceImages } from '../src/card-images';

const id = '9e72f397-2384-40f1-882b-f627664d97df';
const english = `https://cards.scryfall.io/large/front/9/e/${id}.jpg?1788878107`;
const chinese = `https://images.mtgch.com/zhs/large/front/9/e/${id}.webp`;

describe('exact printing image mapping', () => {
  test('keeps the printing ID and ignores Scryfall cache timestamps', () => {
    expect(chineseImageUrl(english)).toBe(chinese);
    expect(chineseImageUrl(english.replace('/large/', '/png/').replace('.jpg', '.png'))).toBe(chinese);
    expect(chineseImageUrl(english.replace('/large/', '/display/').replace('.jpg', '.webp'))).toBe(chinese);
  });

  test('keeps the back face separate from the front', () => {
    expect(chineseImageUrl(english.replace('/front/', '/back/'))).toBe(chinese.replace('/front/', '/back/'));
  });

  test('does not rewrite artwork crops, arbitrary hosts or nested URLs', () => {
    for (const url of [
      english.replace('/large/', '/art_crop/'),
      english.replace('cards.scryfall.io', 'cards.scryfall.io.example.com'),
      `https://example.com/?image=${english}`,
      chinese,
      'data:image/png;base64,abc',
    ]) expect(chineseImageUrl(url)).toBeUndefined();
  });

  test('replaces responsive and inline background URLs without changing descriptors or CSS', () => {
    const normal = english.replace('/large/', '/normal/');
    const srcset = `${normal} 1x, ${english} 2x`;
    expect(replaceImages(srcset, cardImagesIn(srcset))).toBe(`${chinese} 1x, ${chinese} 2x`);
    const style = `background-image: url("${english}"); width: 200px;`;
    expect(replaceImages(style, cardImagesIn(style))).toBe(`background-image: url("${chinese}"); width: 200px;`);
  });
});
