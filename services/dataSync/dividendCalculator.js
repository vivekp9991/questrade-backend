// services/dataSync/dividendCalculator.js - FIXED VERSION - Properly calculates all dividend metrics
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
   * Calculate comprehensive dividend data for a position - FIXED VERSION
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
        dividendActivities,
        symbolInfo
      );
      
      // Calculate yield and return metrics
      const yieldMetrics = this.calculateYieldMetrics(
        shares, 
        avgCost, 
        historicalMetrics.totalReceived,
        projectedMetrics.annualDividendPerShare,
        projectedMetrics.annualDividend
      );
      
      // Calculate current yield based on current price
      const currentYield = this.calculateCurrentYield(
        projectedMetrics.annualDividendPerShare,
        symbolInfo
      );
      
      // Log for debugging
      if (projectedMetrics.annualDividend > 0 || historicalMetrics.totalReceived > 0) {
        logger.debug(`Dividend calculation for ${symbol}:`, {
          symbol,
          accountId,
          personName,
          dividendActivities: dividendActivities.length,
          totalReceived: historicalMetrics.totalReceived,
          annualDividend: projectedMetrics.annualDividend,
          dividendPerShare: projectedMetrics.dividendPerShare,
          annualDividendPerShare: projectedMetrics.annualDividendPerShare,
          yieldOnCost: yieldMetrics.yieldOnCost,
          currentYield: currentYield
        });
      }
      
      // Combine all metrics
      return {
        ...historicalMetrics,
        ...projectedMetrics,
        ...yieldMetrics,
        currentYield: currentYield
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
    // More comprehensive query to find all dividend activities
    const activities = await Activity.find({
      $and: [
        { accountId },
        { personName },
        { symbol },
        { 
          $or: [
            { type: 'Dividend' },
            { isDividend: true },
            { rawType: { $regex: /dividend/i } },
            { action: { $regex: /dividend/i } },
            { description: { $regex: /dividend/i } }
          ]
        }
      ]
    }).sort({ transactionDate: -1 });

    if (activities.length > 0) {
      logger.debug(`Found ${activities.length} dividend activities for ${symbol} in account ${accountId}`);
    }

    return activities;
  }

  /**
   * Calculate historical dividend metrics from activities
   */
  calculateHistoricalMetrics(dividendActivities) {
    // Calculate total dividends received
    const totalReceived = dividendActivities.reduce((sum, activity) => {
      const amount = Math.abs(activity.netAmount || activity.grossAmount || 0);
      return sum + amount;
    }, 0);
    
    const lastDividendActivity = dividendActivities[0];
    const lastDividendAmount = lastDividendActivity ? 
      Math.abs(lastDividendActivity.netAmount || lastDividendActivity.grossAmount || 0) : 0;
    const lastDividendDate = lastDividendActivity ? lastDividendActivity.transactionDate : null;

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
   * Extract dividend information from symbol data - ENHANCED VERSION
   */
  extractSymbolDividendInfo(symbolInfo) {
    if (!symbolInfo) {
      return {
        dividendPerShare: 0,
        annualDividend: 0,
        frequency: null,
        yield: 0
      };
    }

    const frequency = this.parseFrequency(symbolInfo.dividendFrequency);
    
    // Get dividend per share from various possible fields
    let dividendPerShare = 0;
    if (symbolInfo.dividendPerShare && symbolInfo.dividendPerShare > 0) {
      dividendPerShare = symbolInfo.dividendPerShare;
    } else if (symbolInfo.dividend && symbolInfo.dividend > 0) {
      dividendPerShare = symbolInfo.dividend;
    }

    // Calculate annual dividend if we have frequency
    let annualDividend = 0;
    if (dividendPerShare > 0 && frequency) {
      annualDividend = dividendPerShare * frequency;
    } else if (symbolInfo.annualDividend) {
      annualDividend = symbolInfo.annualDividend;
    }

    return {
      dividendPerShare,
      annualDividend,
      frequency,
      yield: symbolInfo.yield || 0,
      exDate: symbolInfo.exDate,
      dividendDate: symbolInfo.dividendDate
    };
  }

  /**
   * Parse dividend frequency from symbol data - ENHANCED VERSION
   */
  parseFrequency(frequencyString) {
    if (!frequencyString) return null;
    
    const freq = frequencyString.toLowerCase();
    if (freq.includes('month')) return this.DIVIDEND_FREQUENCIES.MONTHLY;
    if (freq.includes('quarter')) return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    if (freq.includes('semi') || freq.includes('biannual')) return this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL;
    if (freq.includes('annual') || freq.includes('year')) return this.DIVIDEND_FREQUENCIES.ANNUAL;
    
    // Try to parse numeric frequency
    if (freq === '12') return this.DIVIDEND_FREQUENCIES.MONTHLY;
    if (freq === '4') return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    if (freq === '2') return this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL;
    if (freq === '1') return this.DIVIDEND_FREQUENCIES.ANNUAL;
    
    return null;
  }

  /**
   * Calculate projected dividend metrics - ENHANCED VERSION
   */
  calculateProjectedDividends(shares, avgCost, symbolDividendInfo, dividendActivities, symbolInfo) {
    let dividendFrequency = 0;
    let annualDividendPerShare = 0;
    let annualDividend = 0;
    let monthlyDividend = 0;
    let monthlyDividendPerShare = 0;
    let dividendPerShare = 0;

    // First try to use symbol dividend info
    if (symbolDividendInfo.dividendPerShare > 0) {
      dividendPerShare = symbolDividendInfo.dividendPerShare;
      
      // Get frequency from symbol or estimate from history
      dividendFrequency = symbolDividendInfo.frequency || 
                         this.estimateFrequencyFromHistory(dividendActivities);

      if (dividendFrequency > 0) {
        // Calculate annual dividend per share
        annualDividendPerShare = dividendPerShare * dividendFrequency;
        annualDividend = annualDividendPerShare * shares;
        monthlyDividendPerShare = annualDividendPerShare / 12;
        monthlyDividend = annualDividend / 12;
      }
    }
    
    // If no symbol data, try to estimate from historical activities
    if (annualDividendPerShare === 0 && dividendActivities.length >= 2) {
      const estimation = this.estimateFromHistoricalData(dividendActivities, shares);
      if (estimation.annualDividendPerShare > 0) {
        dividendPerShare = estimation.dividendPerShare;
        annualDividendPerShare = estimation.annualDividendPerShare;
        annualDividend = estimation.annualDividend;
        monthlyDividendPerShare = annualDividendPerShare / 12;
        monthlyDividend = annualDividend / 12;
        dividendFrequency = estimation.frequency;
      }
    }

    // Additional check: If symbolInfo has a yield, calculate from current price
    if (annualDividendPerShare === 0 && symbolInfo && symbolInfo.yield > 0 && symbolInfo.prevDayClosePrice > 0) {
      annualDividendPerShare = (symbolInfo.yield / 100) * symbolInfo.prevDayClosePrice;
      annualDividend = annualDividendPerShare * shares;
      monthlyDividendPerShare = annualDividendPerShare / 12;
      monthlyDividend = annualDividend / 12;
      dividendFrequency = this.DIVIDEND_FREQUENCIES.QUARTERLY; // Default assumption
      dividendPerShare = annualDividendPerShare / dividendFrequency;
    }

    return {
      dividendFrequency,
      annualDividend,
      annualDividendPerShare,
      monthlyDividend,
      monthlyDividendPerShare,
      dividendPerShare
    };
  }

  /**
   * Estimate dividend frequency from payment history - ENHANCED VERSION
   */
  estimateFrequencyFromHistory(dividendActivities) {
    if (dividendActivities.length < 2) {
      return this.DIVIDEND_FREQUENCIES.QUARTERLY; // Default assumption
    }

    // Calculate average time between payments
    const timeDiffs = [];
    for (let i = 0; i < Math.min(dividendActivities.length - 1, 5); i++) {
      const timeDiff = new Date(dividendActivities[i].transactionDate) - 
                      new Date(dividendActivities[i + 1].transactionDate);
      const daysDiff = timeDiff / (1000 * 60 * 60 * 24);
      if (daysDiff > 0 && daysDiff < 400) {
        timeDiffs.push(daysDiff);
      }
    }

    if (timeDiffs.length === 0) {
      return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    }

    const avgDays = timeDiffs.reduce((sum, days) => sum + days, 0) / timeDiffs.length;

    // Determine frequency based on average days
    if (avgDays <= 35) return this.DIVIDEND_FREQUENCIES.MONTHLY;
    if (avgDays <= 100) return this.DIVIDEND_FREQUENCIES.QUARTERLY;
    if (avgDays <= 200) return this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL;
    if (avgDays <= 380) return this.DIVIDEND_FREQUENCIES.ANNUAL;

    return this.DIVIDEND_FREQUENCIES.QUARTERLY; // Default
  }

  /**
   * Estimate dividend from historical data - NEW METHOD
   */
  estimateFromHistoricalData(dividendActivities, shares) {
    if (dividendActivities.length < 2) {
      return {
        dividendPerShare: 0,
        annualDividendPerShare: 0,
        annualDividend: 0,
        frequency: 0
      };
    }

    // Get the last year of dividend data
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    
    const recentDividends = dividendActivities.filter(activity => 
      new Date(activity.transactionDate) >= oneYearAgo
    );

    if (recentDividends.length === 0) {
      // Use last 4 dividends if no recent data
      recentDividends.push(...dividendActivities.slice(0, 4));
    }

    // Calculate average dividend per share from recent payments
    let totalDividendPerShare = 0;
    let validPayments = 0;

    recentDividends.forEach(activity => {
      if (activity.quantity > 0) {
        const divPerShare = Math.abs(activity.netAmount || activity.grossAmount || 0) / activity.quantity;
        if (divPerShare > 0) {
          totalDividendPerShare += divPerShare;
          validPayments++;
        }
      }
    });

    if (validPayments === 0) {
      return {
        dividendPerShare: 0,
        annualDividendPerShare: 0,
        annualDividend: 0,
        frequency: 0
      };
    }

    const avgDividendPerShare = totalDividendPerShare / validPayments;
    const frequency = this.estimateFrequencyFromHistory(dividendActivities);
    const annualDividendPerShare = avgDividendPerShare * frequency;
    const annualDividend = annualDividendPerShare * shares;

    return {
      dividendPerShare: avgDividendPerShare,
      annualDividendPerShare,
      annualDividend,
      frequency
    };
  }

  /**
   * Calculate yield and return metrics - ENHANCED VERSION
   */
  calculateYieldMetrics(shares, avgCost, totalReceived, annualDividendPerShare, annualDividend) {
    const totalCost = avgCost * shares;
    
    // Calculate dividend return percentage (historical)
    const dividendReturnPercent = totalCost > 0 && totalReceived > 0 ? 
      (totalReceived / totalCost) * 100 : 0;
    
    // Calculate yield on cost (forward-looking based on projected dividends)
    const yieldOnCost = avgCost > 0 && annualDividendPerShare > 0 ? 
      (annualDividendPerShare / avgCost) * 100 : 0;

    // Calculate dividend-adjusted cost
    let dividendAdjustedCostPerShare = avgCost;
    let dividendAdjustedCost = totalCost;
    
    if (totalReceived > 0 && shares > 0) {
      dividendAdjustedCostPerShare = Math.max(0, avgCost - (totalReceived / shares));
      dividendAdjustedCost = dividendAdjustedCostPerShare * shares;
    }

    // Calculate dividend-adjusted yield
    const dividendAdjustedYield = dividendAdjustedCostPerShare > 0 && annualDividendPerShare > 0 ?
      (annualDividendPerShare / dividendAdjustedCostPerShare) * 100 : 0;

    return {
      dividendReturnPercent,
      yieldOnCost,
      dividendAdjustedCost,
      dividendAdjustedCostPerShare,
      dividendAdjustedYield
    };
  }

  /**
   * Calculate current yield based on current price - NEW METHOD
   */
  calculateCurrentYield(annualDividendPerShare, symbolInfo) {
    if (!symbolInfo || annualDividendPerShare <= 0) {
      return 0;
    }

    // Try different price fields
    let currentPrice = 0;
    if (symbolInfo.lastTradePrice && symbolInfo.lastTradePrice > 0) {
      currentPrice = symbolInfo.lastTradePrice;
    } else if (symbolInfo.prevDayClosePrice && symbolInfo.prevDayClosePrice > 0) {
      currentPrice = symbolInfo.prevDayClosePrice;
    } else if (symbolInfo.bidPrice && symbolInfo.bidPrice > 0) {
      currentPrice = symbolInfo.bidPrice;
    }

    if (currentPrice > 0) {
      return (annualDividendPerShare / currentPrice) * 100;
    }

    // Fallback to symbol's yield field if available
    return symbolInfo.yield || 0;
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
      dividendAdjustedYield: 0,
      monthlyDividend: 0,
      monthlyDividendPerShare: 0,
      annualDividend: 0,
      annualDividendPerShare: 0,
      dividendFrequency: 0,
      dividendPerShare: 0,
      currentYield: 0
    };
  }

  /**
   * Force recalculate dividends for all positions - ENHANCED VERSION
   */
  async recalculateAllDividends(personName) {
    try {
      const Position = require('../../models/Position');
      
      const positions = await Position.find({ personName });
      let updated = 0;
      let withDividends = 0;
      
      logger.info(`Starting dividend recalculation for ${positions.length} positions for ${personName}`);
      
      for (const position of positions) {
        try {
          // Get fresh symbol info
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
          
          // Determine if this is a dividend stock
          const isDividendStock = (newDividendData.annualDividend > 0) || 
                                 (newDividendData.totalReceived > 0) ||
                                 (newDividendData.dividendPerShare > 0);
          
          // Update position
          await Position.findByIdAndUpdate(position._id, {
            dividendData: newDividendData,
            dividendPerShare: newDividendData.dividendPerShare,
            isDividendStock: isDividendStock,
            updatedAt: new Date()
          });
          
          if (newDividendData.totalReceived > 0 || newDividendData.annualDividend > 0) {
            logger.debug(`Updated ${position.symbol}: totalReceived = $${newDividendData.totalReceived.toFixed(2)}, annual = $${newDividendData.annualDividend.toFixed(2)}`);
            withDividends++;
          }
          
          updated++;
        } catch (error) {
          logger.error(`Error recalculating dividends for ${position.symbol}:`, error);
        }
      }
      
      logger.info(`Dividend recalculation completed for ${personName}: ${updated} positions updated, ${withDividends} with dividends`);
      return { updated, total: positions.length, withDividends };
    } catch (error) {
      logger.error(`Error in recalculateAllDividends for ${personName}:`, error);
      throw error;
    }
  }
}

module.exports = DividendCalculator;