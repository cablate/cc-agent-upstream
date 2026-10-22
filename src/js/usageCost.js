// An unknown price must not show as free; with a mix, the amount covers only the priced part.
export function estimatedCost(usage, translate = text => text, digits = usage.costUSD < 1 ? 4 : 2) {
  if (usage.unpriced > 0 && usage.unpriced === usage.turns) return translate('未計價');
  const amount = 'US$' + usage.costUSD.toFixed(digits);
  return usage.unpriced > 0 ? amount + ' · ' + translate('部分未計價') : amount;
}
