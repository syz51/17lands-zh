import { expect, test } from 'bun:test';
import { resolveApiOrigin } from '../src/api-origin';

test('API build origin allows HTTPS and fixed local mode, never credential or path injection', () => {
  expect(resolveApiOrigin()).toBe('http://127.0.0.1:17317');
  expect(resolveApiOrigin('https://cards.example.com/')).toBe('https://cards.example.com');
  for (const value of ['http://cards.example.com', 'http://127.0.0.1:8080', 'https://user:pass@cards.example.com', 'https://cards.example.com/path', 'https://cards.example.com/?key=x', 'https://cards.example.com/#x', 'file:///data']) {
    expect(() => resolveApiOrigin(value)).toThrow();
  }
});
