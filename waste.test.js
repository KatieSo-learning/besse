const assert = require("assert");
const { calculateWaste } = require("./waste");

function runTests() {
  const result = calculateWaste("paper", 40, 50, 10);
  assert.strictEqual(result.B, 12);
  assert.strictEqual(result.C, 46);
  assert.strictEqual(result.F, 42);

  const result2 = calculateWaste("paper", 100, 0, 0);
  assert.strictEqual(result2.B, 30);
  assert.strictEqual(result2.C, 40);
  assert.strictEqual(result2.F, 30);

  let threw = false;
  try {
    calculateWaste("paper", -1, 0, 0);
  } catch (error) {
    threw = true;
  }
  assert.strictEqual(threw, true);
}

runTests();
console.log("waste.test.js passed");
