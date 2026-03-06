import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCombinedPatch, parsePatchData } from '../src/utils/patches.ts';

test('parsePatchData tracks move targets', () => {
  const files = parsePatchData(`*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ -1 +1 @@
-old
+new
*** End Patch
`);

  assert.equal(files.length, 1);
  assert.equal(files[0].previousPath, 'src/old.ts');
  assert.equal(files[0].path, 'src/new.ts');
});

test('buildCombinedPatch drops net-zero add then delete files', () => {
  const files = buildCombinedPatch([
    `*** Begin Patch
*** Add File: scratch.txt
+hello
*** End Patch
`,
    `*** Begin Patch
*** Delete File: scratch.txt
*** End Patch
`,
  ]);

  assert.deepEqual(files, []);
});

test('buildCombinedPatch carries renamed files forward under the final path', () => {
  const files = buildCombinedPatch([
    `*** Begin Patch
*** Update File: src/old.ts
*** Move to: src/new.ts
@@ -1 +1,2 @@
 export const value = 1;
+export const moved = true;
*** End Patch
`,
    `*** Begin Patch
*** Update File: src/new.ts
@@ -1,2 +1,3 @@
 export const value = 1;
 export const moved = true;
+export const final = true;
*** End Patch
`,
  ]);

  assert.equal(files.length, 1);
  assert.equal(files[0].action, 'Move');
  assert.equal(files[0].previousPath, 'src/old.ts');
  assert.equal(files[0].path, 'src/new.ts');
  assert.equal(files[0].added, 2);
});

test('buildCombinedPatch replays sequential updates in order', () => {
  const files = buildCombinedPatch([
    `*** Begin Patch
*** Update File: demo.ts
@@ -1,1 +1,2 @@
 export const alpha = true;
+export const beta = true;
*** End Patch
`,
    `*** Begin Patch
*** Update File: demo.ts
@@ -1,2 +1,3 @@
 export const alpha = true;
 export const beta = true;
+export const gamma = true;
*** End Patch
`,
  ]);

  assert.equal(files.length, 1);
  assert.equal(files[0].action, 'Update');
  assert.equal(files[0].added, 2);
  assert.equal(files[0].removed, 0);
  assert.equal(files[0].hunks.length, 1);
  assert.equal(files[0].hunks[0].header, '@@ -1,1 +1,3 @@');
  assert.deepEqual(
    files[0].hunks[0].lines.map((line) => ({ type: line.type, oldLn: line.oldLn, newLn: line.newLn })),
    [
      { type: 'context', oldLn: 1, newLn: 1 },
      { type: 'add', oldLn: undefined, newLn: 2 },
      { type: 'add', oldLn: undefined, newLn: 3 },
    ],
  );
});
