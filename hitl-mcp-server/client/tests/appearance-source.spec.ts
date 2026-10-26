import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Normalized pre-change CSS at 72113bd4429b086db264135cef6c8c6efdd4de25.
// This supplements the platform-specific images on every CI platform.
for (const [file, hash] of [
  ['client/src/styles.css', 'ebc69a7d667010af66e36301aa854d11e643709708511ed36bbc351bec07796f'],
  ['client/src/notifications.css', '1bd444219c72e6f9fc39a5c54ed966c451f02bf63dabc9dd7fa71736a25ad5db'],
  ['client/src/review.css', '0c2f59882a333526c2dd946a71d246811901d37016a70678bd64a601d8954ff7'],
  ['client/src/diagrams.css', '03fe1fa96af3d49274d162041f3992d0a237fd53ded448be7a67509d820f9501'],
  ['client/src/work-document.css', '40eaa8f5d97a34f7c39759b1192d8b4a7e77e68506d6e4d6642d46d9a111530a'],
  ['inbox/src/inbox.css', 'b21b1f6f087452eb6af21d339da5e45a920cf1c20ac798c0f997f3d69f113818'],
]) {
  test(`${file} retains every legacy light rule`, () => {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const legacy = text.split('/* Opt-in dark colors;')[0].replace(/\r\n/g, '\n').trimEnd();
    expect(createHash('sha256').update(legacy).digest('hex')).toBe(hash);
  });
}
