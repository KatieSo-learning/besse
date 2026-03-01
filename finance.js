function calculateNewBudget(currentAsset, revenue, expenses) {
  if (!Number.isFinite(currentAsset) || !Number.isFinite(revenue) || !Number.isFinite(expenses)) {
    throw new Error("calculateNewBudget expects finite numbers");
  }
  return currentAsset + revenue - expenses;
}

module.exports = { calculateNewBudget };
