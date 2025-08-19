// services/dataSync/dividendCalculator.js - Enhanced Dividend Calculator with proper totalReceived calculation
const Activity = require('../../models/Activity');
const Symbol = require('../../models/Symbol');
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
      // Get ALL dividend activities for this symbol across all time
      const dividendActivities = await this.getDividendActivities(accountId, personName, symbol);
      
      // Calculate historical dividend metrics from actual activities
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
      
      // Calculate yield and return metrics using actual totalReceived
      const yieldMetrics = this.calculateYieldMetrics(
        shares, 
        avgCost, 
        historicalMetrics.totalReceived,
        projectedMetrics.annualDividendPerShare
      );
      
      // Log dividend calculation for debugging
      if (historicalMetrics.totalReceived > 0 || dividendActivities.length > 0) {
        logger.info(`Dividend calculation for ${symbol}:`, {
          symbol,
          accountId,
          personName,
          dividendActivities: dividendActivities.length,
          totalReceived: historicalMetrics.totalReceived,
          lastDividendAmount: historicalMetrics.lastDividendAmount,
          projectedAnnual: projectedMetrics.annualDividend
        });
      }
      
      // Combine all metrics
      const dividendData = {
        ...historicalMetrics,
        ...projectedMetrics,
        ...yieldMetrics
      };

      // Ensure all numeric fields are properly set
      return {
        totalReceived: dividendData.totalReceived || 0,
        lastDividendAmount: dividendData.lastDividendAmount || 0,
        lastDividendDate: dividendData.lastDividendDate || null,
        dividendReturnPercent: dividendData.dividendReturnPercent || 0,
        yieldOnCost: dividendData.yieldOnCost || 0,
        dividendAdjustedCost: dividendData.dividendAdjustedCost || (avgCost * shares),
        dividendAdjustedCostPerShare: dividendData.dividendAdjustedCostPerShare || avgCost,
        monthlyDividend: dividendData.monthlyDividend || 0,
        monthlyDividendPerShare: dividendData.monthlyDividendPerShare || 0,
        annualDividend: dividendData.annualDividend || 0,
        annualDividendPerShare: dividendData.annualDividendPerShare || 0,
        dividendFrequency: dividendData.dividendFrequency || 0
      };

    } catch (error) {
      logger.error(`Error calculating dividend data for ${symbol}:`, error);
      return this.getDefaultDividendData(shares, avgCost);
    }
  }

  /**
   * Get dividend activities for a specific symbol - ENHANCED VERSION
   */
  async getDividendActivities(accountId, personName, symbol) {
    try {
      // More comprehensive query to find ALL dividend activities
      const activities = await Activity.find({
        accountId,
        personName,
        symbol,
        $or: [
          { type: 'Dividend' },
          { type: 'Dividends' }, // Sometimes plural
          { isDividend: true },
          { rawType: { $regex: /dividend/i } },
          { action: { $regex: /dividend/i } },
          { description: { $regex: /dividend/i } }
        ]
      }).sort({ transactionDate: -1 });

      // Additional fallback: check for activities with the symbol that have positive amounts and no quantity
      if (activities.length === 0) {
        const fallbackActivities = await Activity.find({
          accountId,
          personName,
          symbol,
          netAmount: { $gt: 0 },
          quantity: { $in: [null, 0] },
          $or: [
            { type: { $nin: ['Trade', 'Trades', 'Buy', 'Sell'] } },
            { description: { $regex: /dividend|distribution|income/i } }
          ]
        }).sort({ transactionDate: -1 });

        if (fallbackActivities.length > 0) {
          logger.debug(`Found ${fallbackActivities.length} potential dividend activities for ${symbol} using fallback query`);
          activities.push(...fallbackActivities);
        }
      }

      // Log found activities for debugging
      if (activities.length > 0) {
        logger.debug(`Found ${activities.length} dividend activities for ${symbol} in account ${accountId}`, {
          firstActivity: {
            date: activities[0].transactionDate,
            amount: activities[0].netAmount,
            type: activities[0].type
          },
          totalCount: activities.length
        });
      }

      return activities;
    } catch (error) {
      logger.error(`Error fetching dividend activities for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * Calculate historical dividend metrics from activities - ENHANCED VERSION
   */
  calculateHistoricalMetrics(dividendActivities) {
    // Calculate total received from ALL dividend activities
    let totalReceived = 0;
    let lastDividendAmount = 0;
    let lastDividendDate = null;

    if (dividendActivities && dividendActivities.length > 0) {
      // Sum all dividend amounts (ensure positive values)
      totalReceived = dividendActivities.reduce((sum, activity) => {
        // Handle different amount fields and ensure positive values
        let amount = 0;
        
        // Try different fields in order of preference
        if (activity.netAmount !== undefined && activity.netAmount !== null) {
          amount = Math.abs(activity.netAmount);
        } else if (activity.grossAmount !== undefined && activity.grossAmount !== null) {
          amount = Math.abs(activity.grossAmount);
        } else if (activity.amount !== undefined && activity.amount !== null) {
          amount = Math.abs(activity.amount);
        }
        
        return sum + amount;
      }, 0);
      
      // Get last dividend info
      const lastDividendActivity = dividendActivities[0]; // Already sorted by date desc
      if (lastDividendActivity) {
        lastDividendAmount = Math.abs(
          lastDividendActivity.netAmount || 
          lastDividendActivity.grossAmount || 
          lastDividendActivity.amount || 
          0
        );
        lastDividendDate = lastDividendActivity.transactionDate;
      }

      // Log calculation details for debugging
      logger.debug('Historical dividend metrics calculated:', {
        totalActivities: dividendActivities.length,
        totalReceived: totalReceived.toFixed(2),
        lastDividendAmount: lastDividendAmount.toFixed(2),
        lastDividendDate,
        firstActivityDate: dividendActivities[dividendActivities.length - 1]?.transactionDate,
        lastActivityDate: dividendActivities[0]?.transactionDate
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
    
    return null;
  }

  /**
   * Estimate dividend frequency from payment history
   */
  estimateFrequencyFromHistory(dividendActivities) {
    if (dividendActivities.length < 2) {
      return this.DIVIDEND_FREQUENCIES.QUARTERLY; // Default assumption
    }

    // Calculate average time between payments
    const timeDiffs = [];
    for (let i = 0; i < Math.min(dividendActivities.length - 1, 10); i++) {
      const timeDiff = new Date(dividendActivities[i].transactionDate) - 
                      new Date(dividendActivities[i + 1].transactionDate);
      const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
      if (daysDiff > 0 && daysDiff < 400) { // Reasonable range
        timeDiffs.push(daysDiff);
      }
    }

    if (timeDiffs.length === 0) {
      return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    }

    const avgDays = timeDiffs.reduce((sum, days) => sum + days, 0) / timeDiffs.length;

    // Determine frequency based on average days
    if (avgDays <= 40) return this.DIVIDEND_FREQUENCIES.MONTHLY;
    if (avgDays <= 120) return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    if (avgDays <= 200) return this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL;
    if (avgDays <= 400) return this.DIVIDEND_FREQUENCIES.ANNUAL;

    return 0; // Irregular
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

    // First try to use symbol info
    if (symbolDividendInfo.dividendPerShare > 0 && shares > 0) {
      dividendFrequency = symbolDividendInfo.frequency || 
                         this.estimateFrequencyFromHistory(dividendActivities);

      if (dividendFrequency > 0) {
        annualDividendPerShare = symbolDividendInfo.dividendPerShare * dividendFrequency;
        annualDividend = annualDividendPerShare * shares;
        monthlyDividendPerShare = annualDividendPerShare / 12;
        monthlyDividend = annualDividend / 12;
      }
    } 
    // If no symbol info but we have historical data, estimate from that
    else if (dividendActivities.length >= 4 && shares > 0) {
      dividendFrequency = this.estimateFrequencyFromHistory(dividendActivities);
      
      if (dividendFrequency > 0) {
        // Calculate average dividend per payment from recent history
        const recentPayments = dividendActivities.slice(0, Math.min(dividendFrequency, dividendActivities.length));
        const avgPayment = recentPayments.reduce((sum, activity) => {
          return sum + Math.abs(activity.netAmount || activity.grossAmount || 0);
        }, 0) / recentPayments.length;

        annualDividend = avgPayment * dividendFrequency;
        annualDividendPerShare = annualDividend / shares;
        monthlyDividend = annualDividend / 12;
        monthlyDividendPerShare = annualDividendPerShare / 12;
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
   * Calculate yield and return metrics - ENHANCED VERSION
   */
  calculateYieldMetrics(shares, avgCost, totalReceived, annualDividendPerShare) {
    const totalCost = avgCost * shares;
    
    // Calculate dividend return percentage using actual totalReceived
    const dividendReturnPercent = (totalCost > 0 && totalReceived > 0) ? 
      (totalReceived / totalCost) * 100 : 0;
    
    // Calculate yield on cost (projected)
    const yieldOnCost = (avgCost > 0 && annualDividendPerShare > 0) ? 
      (annualDividendPerShare / avgCost) * 100 : 0;

    // Calculate dividend-adjusted cost using actual totalReceived
    let dividendAdjustedCostPerShare = avgCost;
    let dividendAdjustedCost = totalCost;
    
    if (totalReceived > 0 && shares > 0) {
      dividendAdjustedCostPerShare = Math.max(0, avgCost - (totalReceived / shares));
      dividendAdjustedCost = dividendAdjustedCostPerShare * shares;
    }

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
      dividendsByYear[year] += Math.abs(activity.netAmount || activity.grossAmount || 0);
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
        $or: [
          { type: 'Dividend' },
          { type: 'Dividends' },
          { isDividend: true }
        ],
        transactionDate: { $gte: startDate }
      }).sort({ transactionDate: -1 });

      return dividends.map(dividend => ({
        date: dividend.transactionDate,
        amount: Math.abs(dividend.netAmount || dividend.grossAmount || 0),
        quantity: dividend.quantity,
        dividendPerShare: dividend.quantity > 0 ? 
          Math.abs((dividend.netAmount || dividend.grossAmount || 0)) / dividend.quantity : 0,
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
      sum + Math.abs(payment.netAmount || payment.grossAmount || 0), 0) / recentPayments.length;

    return {
      estimatedDate: nextPaymentDate,
      estimatedAmount: avgAmount,
      confidence: recentPayments.length >= 2 ? 'high' : 'low'
    };
  }

  /**
   * Force recalculate dividends for all positions
   */
  async recalculateAllDividends(personName) {
    try {
      const Position = require('../../models/Position');
      const Symbol = require('../../models/Symbol');
      
      const positions = await Position.find({ personName });
      let updated = 0;
      let totalDividendsFound = 0;
      
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
            logger.info(`Updated ${position.symbol}: totalReceived = $${newDividendData.totalReceived.toFixed(2)}`);
            totalDividendsFound += newDividendData.totalReceived;
          }
          
          updated++;
        } catch (error) {
          logger.error(`Error recalculating dividends for ${position.symbol}:`, error);
        }
      }
      
      logger.info(`Dividend recalculation completed for ${personName}: ${updated} positions updated, total dividends found: $${totalDividendsFound.toFixed(2)}`);
      return { updated, total: positions.length, totalDividendsFound };
    } catch (error) {
      logger.error(`Error in recalculateAllDividends for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = DividendCalculator;