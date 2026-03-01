const assert = require("assert");
const { calculateNewBudget } = require("./finance");

function runTests() {
  assert.strictEqual(calculateNewBudget(1000000, 50000, 12500), 1037500);
  assert.strictEqual(calculateNewBudget(1000, 0, 0), 1000);
  assert.strictEqual(calculateNewBudget(500, 0, 750), -250);

  let threw = false;
  try {
    calculateNewBudget("100", 1, 1);
  } catch (error) {
    threw = true;
  }
  assert.strictEqual(threw, true);
}

runTests();
console.log("finance.test.js passed");
