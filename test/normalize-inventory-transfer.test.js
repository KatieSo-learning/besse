'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { normalizeInventoryTransferItems } = require('../lib/normalize-inventory-transfer-items.js');

const MATERIALS = ['paper', 'plastic', 'metal', 'glass', 'wood'];

test('grade B/C without kind: rejected (ambiguous bucket)', () => {
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'paper', grade: 'B', tonnes: 1 }], MATERIALS),
    []
  );
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'metal', grade: 'C', tonnes: 2.5 }], MATERIALS),
    []
  );
});

test('grade B/C with explicit kind: accepted', () => {
  const w = normalizeInventoryTransferItems(
    [{ material: 'paper', grade: 'B', tonnes: 1, kind: 'waste' }],
    MATERIALS
  );
  assert.strictEqual(w.length, 1);
  assert.deepStrictEqual(w[0], { material: 'paper', grade: 'B', tonnes: 1, kind: 'waste' });

  const m = normalizeInventoryTransferItems(
    [{ material: 'glass', grade: 'C', tonnes: 3, kind: 'material' }],
    MATERIALS
  );
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].kind, 'material');
});

test('grade A / F without kind: backward-compatible inference', () => {
  const a = normalizeInventoryTransferItems([{ material: 'wood', grade: 'A', tonnes: 0.5 }], MATERIALS);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].kind, 'material');

  const f = normalizeInventoryTransferItems([{ material: 'plastic', grade: 'F', tonnes: 10 }], MATERIALS);
  assert.strictEqual(f.length, 1);
  assert.strictEqual(f[0].kind, 'waste');
});

test('requireExplicitKind: B/C with kind still accepted', () => {
  const rows = normalizeInventoryTransferItems(
    [{ material: 'paper', grade: 'B', tonnes: 1, kind: 'material' }],
    MATERIALS,
    { requireExplicitKind: true }
  );
  assert.strictEqual(rows.length, 1);
});

test('requireExplicitKind: A/F without kind rejected', () => {
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'paper', grade: 'A', tonnes: 1 }], MATERIALS, {
      requireExplicitKind: true
    }),
    []
  );
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'paper', grade: 'F', tonnes: 1 }], MATERIALS, {
      requireExplicitKind: true
    }),
    []
  );
});

test('requireExplicitKind: A/F with explicit kind accepted', () => {
  const a = normalizeInventoryTransferItems(
    [{ material: 'metal', grade: 'A', tonnes: 2, kind: 'material' }],
    MATERIALS,
    { requireExplicitKind: true }
  );
  assert.strictEqual(a.length, 1);

  const f = normalizeInventoryTransferItems(
    [{ material: 'metal', grade: 'F', tonnes: 2, kind: 'waste' }],
    MATERIALS,
    { requireExplicitKind: true }
  );
  assert.strictEqual(f.length, 1);
});

test('invalid material or zero tonnes filtered', () => {
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'invalid', grade: 'B', tonnes: 1, kind: 'waste' }], MATERIALS),
    []
  );
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'paper', grade: 'B', tonnes: 0, kind: 'waste' }], MATERIALS),
    []
  );
});

test('waste row with grade A rejected', () => {
  assert.deepStrictEqual(
    normalizeInventoryTransferItems([{ material: 'paper', grade: 'A', tonnes: 1, kind: 'waste' }], MATERIALS),
    []
  );
});
