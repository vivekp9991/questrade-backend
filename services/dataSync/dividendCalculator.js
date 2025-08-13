// services/dataSync/dividendCalculator.js - Dividend Calculation Logic
const Activity = require('../../models/Activity');
const logger = require('../../utils/logger');

class DividendCalculator {
  constructor() {
    this.DIVIDEND_FREQUENCIES = {
      MONTHLY: 12,
      QUARTERLY: 4,
      SEMI_ANNUAL: 2,
      ANNUAL: 1
    };
  }

  /**
   * Calculate comprehensive dividend data for a position
   */
  async calculateDividendData(accountId, personName, symbolId, symbol, shares, avgCost, symbolInfo) {
    try {
      // Get dividend activities for this symbol
      const dividendActivities = await this.getDividendActivities(accountId, personName, symbol);
      
      // Calculate historical dividend metrics
      const historicalMetrics = this.calculateHistoricalMetrics(dividendActivities);
      
      // Get symbol dividend information
      const symbolDividendInfo = this.extractSymbolDividendInfo(symbolInfo);
      
      // Calculate projected dividends
      const projectedMetrics = this.calculateProjectedDividends(
        shares, 
        avgCost, 
        symbolDividendInfo, 
        dividendActivities
      );
      
      // Calculate yield and return metrics
      const yieldMetrics = this.calculateYieldMetrics(
        shares, 
        avgCost, 
        historicalMetrics.totalReceived, 
        projectedMetrics.annualDividendPerShare
      );
      
      // Combine all metrics
      return {
        ...historicalMetrics,
        ...projectedMetrics,
        ...yieldMetrics
      };

    } catch (error) {
      logger.error(`Error calculating dividend data for ${symbol}:`, error);
      return this.getDefaultDividendData(shares, avgCost);
    }
  }

  /**
   * Get dividend activities for a specific symbol
   */
  async getDividendActivities(accountId, personName, symbol) {
    return await Activity.find({
      accountId,
      personName,
      symbol,
      type: 'Dividend'
    }).sort({ transactionDate: -1 });
  }

  /**
   * Calculate historical dividend metrics from activities
   */
  calculateHistoricalMetrics(dividendActivities) {
    const totalReceived = dividendActivities.reduce((sum, activity) => 
      sum + Math.abs(activity.netAmount || 0), 0);
    
    const lastDividendActivity = dividendActivities[0];
    const lastDividendAmount = lastDividendActivity ? Math.abs(lastDividendActivity.netAmount) : 0;
    const lastDividendDate = lastDividendActivity ? lastDividendActivity.transactionDate : null;

    return {
      totalReceived,
      lastDividendAmount,
      lastDividendDate
    };
  }

  /**
   * Extract dividend information from symbol data
   */
  extractSymbolDividendInfo(symbolInfo) {
    if (!symbolInfo) {
      return {
        dividendPerShare: 0,
        annualDividend: 0,
        frequency: null
      };
    }

    const dividendPerShare = symbolInfo.dividendPerShare || symbolInfo.dividend || 0;
    const frequency = this.parseFrequency(symbolInfo.dividendFrequency);

    return {
      dividendPerShare,
      annualDividend: symbolInfo.dividend || 0,
      frequency
    };
  }

  /**
   * Parse dividend frequency from symbol data
   */
  parseFrequency(frequencyString) {
    if (!frequencyString) return null;
    
    const freq = frequencyString.toLowerCase();
    if (freq.includes('quarterly')) return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    if (freq.includes('monthly')) return this.DIVIDEND_FREQUENCIES.MONTHLY;
    if (freq.includes('semi') || freq.includes('biannual')) return this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL;
    if (freq.includes('annual')) return this.DIVIDEND_FREQUENCIES.ANNUAL;
    
    return this.DIVIDEND_FREQUENCIES.QUARTERLY; // Default
  }

  /**
   * Estimate dividend frequency from payment history
   */
  estimateFrequencyFromHistory(dividendActivities) {
    if (dividendActivities.length < 2) {
      return this.DIVIDEND_FREQUENCIES.QUARTERLY; // Default
    }

    // Calculate average time between payments
    const timeDiffs = [];
    for (let i = 0; i < dividendActivities.length - 1; i++) {
      const timeDiff = new Date(dividendActivities[i].transactionDate) - 
                      new Date(dividendActivities[i + 1].transactionDate);
      const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
      timeDiffs.push(daysDiff);
    }

    const avgDays = timeDiffs.reduce((sum, days) => sum + days, 0) / timeDiffs.length;

    // Determine frequency based on average days
    if (avgDays <= 40) return this.DIVIDEND_FREQUENCIES.MONTHLY;
    if (avgDays <= 120) return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    if (avgDays <= 200) return this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL;
    return this.DIVIDEND_FREQUENCIES.ANNUAL;
  }

  /**
   * Calculate projected dividend metrics
   */
  calculateProjectedDividends(shares, avgCost, symbolDividendInfo, dividendActivities) {
    let dividendFrequency = 0;
    let annualDividendPerShare = 0;
    let annualDividend = 0;
    let monthlyDividend = 0;
    let monthlyDividendPerShare = 0;

    if (symbolDividendInfo.dividendPerShare > 0 && shares > 0) {
      // Use symbol frequency or estimate from history
      dividendFrequency = symbolDividendInfo.frequency || 
                         this.estimateFrequencyFromHistory(dividendActivities);

      // Calculate projected dividends
      annualDividendPerShare = symbolDividendInfo.dividendPerShare * dividendFrequency;
      annualDividend = annualDividendPerShare * shares;
      monthlyDividendPerShare = annualDividendPerShare / 12;
      monthlyDividend = annualDividend / 12;
    }

    return {
      dividendFrequency,
      annualDividend,
      annualDividendPerShare,
      monthlyDividend,
      monthlyDividendPerShare
    };
  }

  /**
   * Calculate yield and return metrics
   */
  calculateYieldMetrics(shares, avgCost, totalReceived, annualDividendPerShare) {
    const totalCost = avgCost * shares;
    
    // Calculate dividend return percentage (historical)
    const dividendReturnPercent = totalCost > 0 ? (totalReceived / totalCost) * 100 : 0;
    
    // Calculate yield on cost (projected)
    const yieldOnCost = avgCost > 0 && annualDividendPerShare > 0 ? 
      (annualDividendPerShare / avgCost) * 100 : 0;

    // Calculate dividend-adjusted cost
    const dividendAdjustedCostPerShare = totalReceived > 0 && shares > 0 ? 
      avgCost - (totalReceived / shares) : avgCost;
    const dividendAdjustedCost = dividendAdjustedCostPerShare * shares;

    return {
      dividendReturnPercent,
      yieldOnCost,
      dividendAdjustedCost,
      dividendAdjustedCostPerShare
    };
  }

  /**
   * Get default dividend data structure (for non-dividend stocks or on error)
   */
  getDefaultDividendData(shares, avgCost) {
    return {
      totalReceived: 0,
      lastDividendAmount: 0,
      lastDividendDate: null,
      dividendReturnPercent: 0,
      yieldOnCost: 0,
      dividendAdjustedCost: avgCost * shares,
      dividendAdjustedCostPerShare: avgCost,
      monthlyDividend: 0,
      monthlyDividendPerShare: 0,
      annualDividend: 0,
      annualDividendPerShare: 0,
      dividendFrequency: 0
    };
  }

  /**
   * Validate dividend calculation results
   */
  validateDividendData(dividendData, symbol) {
    const warnings = [];

    // Check for negative values
    if (dividendData.totalReceived < 0) {
      warnings.push(`Negative totalReceived for ${symbol}`);
    }

    if (dividendData.annualDividend < 0) {
      warnings.push(`Negative annualDividend for ${symbol}`);
    }

    // Check for unrealistic yield values
    if (dividendData.yieldOnCost > 50) {
      warnings.push(`Unusually high yield on cost (${dividendData.yieldOnCost.toFixed(2)}%) for ${symbol}`);
    }

    // Check for unrealistic frequency
    if (dividendData.dividendFrequency > 12) {
      warnings.push(`Unrealistic dividend frequency (${dividendData.dividendFrequency}) for ${symbol}`);
    }

    if (warnings.length > 0) {
      logger.warn(`Dividend data validation warnings for ${symbol}:`, warnings);
    }

    return {
      isValid: warnings.length === 0,
      warnings
    };
  }

  /**
   * Calculate dividend growth rate from historical data
   */
  calculateDividendGrowthRate(dividendActivities) {
    if (dividendActivities.length < 4) {
      return null; // Need at least 4 payments to calculate meaningful growth
    }

    // Group dividends by year
    const dividendsByYear = {};
    dividendActivities.forEach(activity => {
      const year = new Date(activity.transactionDate).getFullYear();
      if (!dividendsByYear[year]) {
        dividendsByYear[year] = 0;
      }
      dividendsByYear[year] += Math.abs(activity.netAmount);
    });

    const years = Object.keys(dividendsByYear).sort().map(Number);
    if (years.length < 2) {
      return null;
    }

    // Calculate year-over-year growth rates
    const growthRates = [];
    for (let i = 1; i < years.length; i++) {
      const currentYear = years[i];
      const previousYear = years[i - 1];
      const currentAmount = dividendsByYear[currentYear];
      const previousAmount = dividendsByYear[previousYear];

      if (previousAmount > 0) {
        const growthRate = ((currentAmount - previousAmount) / previousAmount) * 100;
        growthRates.push(growthRate);
      }
    }

    if (growthRates.length === 0) {
      return null;
    }

    // Return average growth rate
    const avgGrowthRate = growthRates.reduce((sum, rate) => sum + rate, 0) / growthRates.length;
    return {
      averageGrowthRate: avgGrowthRate,
      yearlyGrowthRates: growthRates,
      yearsOfData: years.length
    };
  }

  /**
   * Get dividend calendar for a symbol
   */
  async getDividendCalendar(accountId, personName, symbol, months = 12) {
    try {
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - months);

      const dividends = await Activity.find({
        accountId,
        personName,
        symbol,
        type: 'Dividend',
        transactionDate: { $gte: startDate }
      }).sort({ transactionDate: -1 });

      return dividends.map(dividend => ({
        date: dividend.transactionDate,
        amount: Math.abs(dividend.netAmount),
        quantity: dividend.quantity,
        dividendPerShare: dividend.quantity > 0 ? 
          Math.abs(dividend.netAmount) / dividend.quantity : 0,
        description: dividend.description
      }));
    } catch (error) {
      logger.error(`Error getting dividend calendar for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * Predict next dividend payment based on historical data
   */
  predictNextDividend(dividendActivities, dividendFrequency) {
    if (dividendActivities.length === 0 || !dividendFrequency) {
      return null;
    }

    const lastPayment = dividendActivities[0];
    const lastPaymentDate = new Date(lastPayment.transactionDate);
    
    // Calculate months between payments
    const monthsBetweenPayments = 12 / dividendFrequency;
    
    // Predict next payment date
    const nextPaymentDate = new Date(lastPaymentDate);
    nextPaymentDate.setMonth(nextPaymentDate.getMonth() + monthsBetweenPayments);

    // Estimate amount based on recent payments
    const recentPayments = dividendActivities.slice(0, Math.min(4, dividendActivities.length));
    const avgAmount = recentPayments.reduce((sum, payment) => 
      sum + Math.abs(payment.netAmount), 0) / recentPayments.length;

    return {
      estimatedDate: nextPaymentDate,
      estimatedAmount: avgAmount,
      confidence: recentPayments.length >= 2 ? 'high' : 'low'
    };
  }
}

module.exports = DividendCalculator;