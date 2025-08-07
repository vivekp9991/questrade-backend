/**
 * Calculate a summary of the portfolio for the given account.
 * If a recent snapshot exists it will be returned, otherwise
 * the summary is calculated from current positions.
 * @param {string} [accountId] optional account identifier
 * @returns {Promise<object|null>} summary information or null when no positions
 */
async function getPortfolioSummary(accountId = null) {
  try {
    const query = accountId ? { accountId } : {};
     // Try to return the most recent snapshot first
    const snapshot = await PortfolioSnapshot.findOne(query).sort({ date: -1 });
    if (snapshot) return snapshot;
     const positions = await Position.find(query);
    if (positions.length === 0) return null;
    let totalInvestment = 0;
    let currentValue = 0;
    let unrealizedPnl = 0;
    let totalDividends = 0;
    let monthlyDividendIncome = 0;
    let annualProjectedDividend = 0;
    const sectorMap = {};
    const currencyMap = {};

    for (const position of positions) {
      totalInvestment += position.totalCost || 0;
      currentValue += position.currentMarketValue || 0;
      unrealizedPnl += position.openPnl || 0;
      if (position.dividendData) {
        totalDividends += position.dividendData.totalReceived || 0;
        monthlyDividendIncome += position.dividendData.monthlyDividend || 0;
        annualProjectedDividend += position.dividendData.annualDividend || 0;
      }
        const symbol = await Symbol.findOne({ symbolId: position.symbolId });
      if (symbol) {
        const sector = symbol.securityType || 'Other';
        sectorMap[sector] = (sectorMap[sector] || 0) + (position.currentMarketValue || 0);

        const currency = symbol.currency || 'CAD';
        currencyMap[currency] = (currencyMap[currency] || 0) + (position.currentMarketValue || 0);
      }
    }
     const totalReturnValue = unrealizedPnl + totalDividends;
    const totalReturnPercent = totalInvestment > 0 ? (totalReturnValue / totalInvestment) * 100 : 0;
    const averageYieldPercent = currentValue > 0 ? (annualProjectedDividend / currentValue) * 100 : 0;
    const yieldOnCostPercent = totalInvestment > 0 ? (annualProjectedDividend / totalInvestment) * 100 : 0;

    const sectorAllocation = Object.entries(sectorMap).map(([sector, value]) => ({
      sector,
      value,
      percentage: currentValue > 0 ? (value / currentValue) * 100 : 0
    }));

    const currencyBreakdown = Object.entries(currencyMap).map(([currency, value]) => ({
      currency,
      value,
      percentage: currentValue > 0 ? (value / currentValue) * 100 : 0
    }));

    return {
      accountId,
      totalInvestment,
      currentValue,
      totalReturnValue,
      totalReturnPercent,
      unrealizedPnl,
      realizedPnl: 0,
      totalDividends,
      monthlyDividendIncome,
      annualProjectedDividend,
      averageYieldPercent,
      yieldOnCostPercent,
      numberOfPositions: positions.length,
      numberOfDividendStocks: positions.filter(p => p.dividendData && p.dividendData.annualDividend > 0).length,
      sectorAllocation,
      currencyBreakdown,
      assetAllocation: []
    };
  } catch (error) {
    // logger.error('Error calculating portfolio summary:', error);
    throw error;
  }
}
module.exports = { getPortfolioSummary };