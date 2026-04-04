'use strict';

/**
 * Normalizes inventory transfer line items (Municipality/MRF ↔ Broker, add/remove inventory).
 *
 * Grades B and C exist in **both** `inventory.materials` and `inventory.waste`. Without an
 * explicit `kind`, those rows are ambiguous and are **dropped** (returns no item). Grade A is
 * material-only and F is waste-only, so kind may be omitted for those.
 *
 * @param {unknown[]} items
 * @param {string[]} materialsList  e.g. ['paper','plastic',…]
 * @param {{ requireExplicitKind?: boolean }} [options]  For tests / stricter clients: if true,
 *   **every** row must include `kind: 'material'|'waste'` (no A/F inference).
 */
function normalizeInventoryTransferItems(items, materialsList, options = {}) {
  const MATERIALS = materialsList;
  const requireExplicitKind = options.requireExplicitKind === true;
  if (!Array.isArray(items) || !Array.isArray(MATERIALS) || !MATERIALS.length) return [];

  return items
    .map((it) => {
      const material = String(it && it.material ? it.material : '').toLowerCase();
      const grade = String(it && it.grade ? it.grade : '').toUpperCase();
      const raw = Math.max(0, Number(it && it.tonnes != null ? it.tonnes : 0));
      const tonnes = Math.round(raw * 10) / 10;
      const rawKind = String(it && it.kind ? it.kind : '').toLowerCase();
      let kind = rawKind === 'material' || rawKind === 'waste' ? rawKind : null;

      if (!kind && !requireExplicitKind) {
        if (grade === 'A') kind = 'material';
        else if (grade === 'F') kind = 'waste';
      }

      if (!kind) return null;
      if (kind === 'material' && !['A', 'B', 'C'].includes(grade)) return null;
      if (kind === 'waste' && !['B', 'C', 'F'].includes(grade)) return null;
      return { material, grade, tonnes, kind };
    })
    .filter((it) => it && MATERIALS.includes(it.material) && it.tonnes > 0);
}

module.exports = { normalizeInventoryTransferItems };
