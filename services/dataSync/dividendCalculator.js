// services/dataSync/dividendCalculator.js - FIXED VERSION - Properly calculates totalReceived
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
   * Calculate comprehensive dividend data for a position - FIXED VERSION
   */
  async calculateDividendData(accountId, personName, symbolId, symbol, shares, avgCost, symbolInfo) {
    try {
      // Get dividend activities for this symbol - FIXED: Properly get all dividend activities
      const dividendActivities = await this.getDividendActivities(accountId, personName, symbol);
      
      // Calculate historical dividend metrics - FIXED: Properly calculate totalReceived
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
      
      // Calculate yield and return metrics - FIXED: Use actual totalReceived
      const yieldMetrics = this.calculateYieldMetrics(
        shares, 
        avgCost, 
        historicalMetrics.totalReceived, // FIXED: Pass actual totalReceived
        projectedMetrics.annualDividendPerShare
      );
      
      // FIXED: Log dividend calculation for debugging
      if (historicalMetrics.totalReceived > 0) {
        logger.debug(`Dividend calculation for ${symbol}:`, {
          symbol,
          accountId,
          personName,
          dividendActivities: dividendActivities.length,
          totalReceived: historicalMetrics.totalReceived,
          projectedAnnual: projectedMetrics.annualDividend
        });
      }
      
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
   * Get dividend activities for a specific symbol - FIXED VERSION
   */
  async getDividendActivities(accountId, personName, symbol) {
    // FIXED: More comprehensive query to find all dividend activities
    const activities = await Activity.find({
      $and: [
        { accountId },
        { personName },
        { symbol },
        { 
          $or: [
            { type: 'Dividend' },
            { isDividend: true },
            { rawType: { $regex: /dividend/i } }
          ]
        }
      ]
    }).sort({ transactionDate: -1 });

    // FIXED: Log found activities for debugging
    if (activities.length > 0) {
      logger.debug(`Found ${activities.length} dividend activities for ${symbol} in account ${accountId}`);
    }

    return activities;
  }

  /**
   * Calculate historical dividend metrics from activities - FIXED VERSION
   */
  calculateHistoricalMetrics(dividendActivities) {
    // FIXED: Properly sum all dividend amounts received
    const totalReceived = dividendActivities.reduce((sum, activity) => {
      // FIXED: Handle different amount fields and ensure positive values
      const amount = Math.abs(activity.netAmount || activity.grossAmount || 0);
      return sum + amount;
    }, 0);
    
    const lastDividendActivity = dividendActivities[0];
    const lastDividendAmount = lastDividendActivity ? 
      Math.abs(lastDividendActivity.netAmount || lastDividendActivity.grossAmount || 0) : 0;
    const lastDividendDate = lastDividendActivity ? lastDividendActivity.transactionDate : null;

    // FIXED: Log calculation details
    if (totalReceived > 0) {
      logger.debug('Historical dividend metrics calculated:', {
        totalActivities: dividendActivities.length,
        totalReceived,
        lastDividendAmount,
        lastDividendDate
      });
    }

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

    const frequency = this.parseFrequency(symbolInfo.dividendFrequency);

    // Only trust dividendPerShare if dividend frequency is provided
    const dividendPerShare = (frequency === this.DIVIDEND_FREQUENCIES.MONTHLY ||
                             frequency === this.DIVIDEND_FREQUENCIES.QUARTERLY)
      ? (symbolInfo.dividendPerShare || symbolInfo.dividend || 0)
      : 0;

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
    
    // Unknown frequency - treat as null rather than assuming quarterly
    return null;
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
    if (avgDays <= 400) return this.DIVIDEND_FREQUENCIES.ANNUAL;

    // Beyond ~13 months between payments - treat as non-regular
    return 0;
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

      // Only treat as dividend stock if frequency is monthly or quarterly
      if (dividendFrequency === this.DIVIDEND_FREQUENCIES.MONTHLY ||
          dividendFrequency === this.DIVIDEND_FREQUENCIES.QUARTERLY) {
        // Calculate projected dividends
        annualDividendPerShare = symbolDividendInfo.dividendPerShare * dividendFrequency;
        annualDividend = annualDividendPerShare * shares;
        monthlyDividendPerShare = annualDividendPerShare / 12;
        monthlyDividend = annualDividend / 12;
      } else {
        dividendFrequency = 0;
      }
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
   * Calculate yield and return metrics - FIXED VERSION
   */
  calculateYieldMetrics(shares, avgCost, totalReceived, annualDividendPerShare) {
    const totalCost = avgCost * shares;
    
    // FIXED: Calculate dividend return percentage using actual totalReceived
    const dividendReturnPercent = totalCost > 0 && totalReceived > 0 ? 
      (totalReceived / totalCost) * 100 : 0;
    
    // Calculate yield on cost (projected)
    const yieldOnCost = avgCost > 0 && annualDividendPerShare > 0 ? 
      (annualDividendPerShare / avgCost) * 100 : 0;

    // FIXED: Calculate dividend-adjusted cost using actual totalReceived
    const dividendAdjustedCostPerShare = totalReceived > 0 && shares > 0 ? 
      Math.max(0, avgCost - (totalReceived / shares)) : avgCost;
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

  /**
   * ADDED: Force recalculate dividends for all positions
   */
  async recalculateAllDividends(personName) {
    try {
      const Position = require('../../models/Position');
      const Symbol = require('../../models/Symbol');
      
      const positions = await Position.find({ personName });
      let updated = 0;
      
      logger.info(`Starting dividend recalculation for ${positions.length} positions for ${personName}`);
      
      for (const position of positions) {
        try {
          // Get symbol info
          const symbol = await Symbol.findOne({ symbolId: position.symbolId });
          
          // Recalculate dividend data
          const newDividendData = await this.calculateDividendData(
            position.accountId,
            position.personName,
            position.symbolId,
            position.symbol,
            position.openQuantity,
            position.averageEntryPrice,
            symbol
          );
          
          // Update position
          await Position.findByIdAndUpdate(position._id, {
            dividendData: newDividendData,
            updatedAt: new Date()
          });
          
          if (newDividendData.totalReceived > 0) {
            logger.debug(`Updated ${position.symbol}: totalReceived = $${newDividendData.totalReceived.toFixed(2)}`);
          }
          
          updated++;
        } catch (error) {
          logger.error(`Error recalculating dividends for ${position.symbol}:`, error);
        }
      }
      
      logger.info(`Dividend recalculation completed for ${personName}: ${updated} positions updated`);
      return { updated, total: positions.length };
    } catch (error) {
      logger.error(`Error in recalculateAllDividends for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = DividendCalculator;