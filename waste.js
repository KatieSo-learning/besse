const degradationMatrix = {
  paper: {
    fromA: { B: 0.30, C: 0.40, F: 0.30 },
    fromB: { B: 0.00, C: 0.60, F: 0.40 },
    fromC: { B: 0.00, C: 0.00, F: 1.00 }
  },
  plastic: {
    fromA: { B: 0.00, C: 0.00, F: 0.00 },
    fromB: { B: 0.00, C: 0.00, F: 0.00 },
    fromC: { B: 0.00, C: 0.00, F: 0.00 }
  }
};

function calculateWaste(materialType, tonsA, tonsB, tonsC) {
  if (typeof materialType !== "string" || materialType.length === 0) {
    throw new Error("materialType must be a non-empty string");
  }

  const rates = degradationMatrix[materialType];
  if (!rates) {
    throw new Error("materialType not found in degradationMatrix");
  }

  const A = Number(tonsA || 0);
  const B = Number(tonsB || 0);
  const C = Number(tonsC || 0);

  if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(C)) {
    throw new Error("A, B, C must be finite numbers");
  }
  if (A < 0 || B < 0 || C < 0) {
    throw new Error("A, B, C must be >= 0");
  }

  const finalB = A * rates.fromA.B + B * rates.fromB.B + C * rates.fromC.B;
  const finalC = A * rates.fromA.C + B * rates.fromB.C + C * rates.fromC.C;
  const finalF = A * rates.fromA.F + B * rates.fromB.F + C * rates.fromC.F;

  return { materialType, B: finalB, C: finalC, F: finalF };
}

module.exports = { calculateWaste, degradationMatrix };
