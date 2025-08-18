// services/dataSync/dividendCalculator.js - FIXED VERSION - Proper Yield on Cost calculation
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
   * Calculate comprehensive dividend data for a position - FIXED VERSION with proper YoC
   */
  async calculateDividendData(accountId, personName, symbolId, symbol, shares, avgCost, symbolInfo) {
    try {
      // Get dividend activities for this symbol
      const dividendActivities = await this.getDividendActivities(accountId, personName, symbol);
      
      // Calculate historical dividend metrics
      const historicalMetrics = this.calculateHistoricalMetrics(dividendActivities);
      
      // Get symbol dividend information
      const symbolDividendInfo = this.extractSymbolDividendInfo(symbolInfo);
      
      // FIXED: Calculate projected dividends with proper frequency handling
      const projectedMetrics = this.calculateProjectedDividends(
        shares, 
        avgCost, 
        symbolDividendInfo, 
        dividendActivities
      );
      
      // FIXED: Calculate yield on cost properly
      const yieldMetrics = this.calculateYieldOnCost(
        shares, 
        avgCost, 
        historicalMetrics.totalReceived,
        projectedMetrics.annualDividendPerShare,
        projectedMetrics.annualDividend
      );
      
      // Log calculation for debugging
      if (projectedMetrics.annualDividend > 0) {
        logger.debug(`Dividend calculation for ${symbol}:`, {
          symbol,
          shares,
          avgCost,
          annualDividend: projectedMetrics.annualDividend,
          annualDividendPerShare: projectedMetrics.annualDividendPerShare,
          yieldOnCost: yieldMetrics.yieldOnCost,
          totalCost: shares * avgCost
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
   * Get dividend activities for a specific symbol
   */
  async getDividendActivities(accountId, personName, symbol) {
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

    return activities;
  }

  /**
   * Calculate historical dividend metrics from activities
   */
  calculateHistoricalMetrics(dividendActivities) {
    const totalReceived = dividendActivities.reduce((sum, activity) => {
      const amount = Math.abs(activity.netAmount || activity.grossAmount || 0);
      return sum + amount;
    }, 0);
    
    const lastDividendActivity = dividendActivities[0];
    const lastDividendAmount = lastDividendActivity ? 
      Math.abs(lastDividendActivity.netAmount || lastDividendActivity.grossAmount || 0) : 0;
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

    const frequency = this.parseFrequency(symbolInfo.dividendFrequency);

    // FIXED: Only use dividendPerShare if we have valid frequency
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
   * Calculate projected dividend metrics - FIXED VERSION
   */
  calculateProjectedDividends(shares, avgCost, symbolDividendInfo, dividendActivities) {
    let dividendFrequency = 0;
    let annualDividendPerShare = 0;
    let annualDividend = 0;
    let monthlyDividend = 0;
    let monthlyDividendPerShare = 0;

    // FIXED: Use symbol info to calculate proper annual dividend
    if (symbolDividendInfo.dividendPerShare > 0 && symbolDividendInfo.frequency) {
      dividendFrequency = symbolDividendInfo.frequency;
      
      // FIXED: Calculate annual dividend per share based on frequency
      if (dividendFrequency === this.DIVIDEND_FREQUENCIES.MONTHLY) {
        // Monthly dividend - multiply by 12
        annualDividendPerShare = symbolDividendInfo.dividendPerShare * 12;
      } else if (dividendFrequency === this.DIVIDEND_FREQUENCIES.QUARTERLY) {
        // Quarterly dividend - multiply by 4  
        annualDividendPerShare = symbolDividendInfo.dividendPerShare * 4;
      } else if (dividendFrequency === this.DIVIDEND_FREQUENCIES.SEMI_ANNUAL) {
        // Semi-annual dividend - multiply by 2
        annualDividendPerShare = symbolDividendInfo.dividendPerShare * 2;
      } else if (dividendFrequency === this.DIVIDEND_FREQUENCIES.ANNUAL) {
        // Annual dividend - use as is
        annualDividendPerShare = symbolDividendInfo.dividendPerShare;
      }

      // FIXED: Calculate total annual dividend for the position
      if (shares > 0 && annualDividendPerShare > 0) {
        annualDividend = annualDividendPerShare * shares;
        monthlyDividendPerShare = annualDividendPerShare / 12;
        monthlyDividend = annualDividend / 12;
      }
    }

    // FIXED: If no symbol info but we have dividend history, estimate from activities
    if (annualDividend === 0 && dividendActivities.length >= 2) {
      const estimatedFreq = this.estimateFrequencyFromHistory(dividendActivities);
      if (estimatedFreq > 0) {
        dividendFrequency = estimatedFreq;
        
        // Calculate average dividend per payment from recent activities
        const recentActivities = dividendActivities.slice(0, Math.min(4, dividendActivities.length));
        const avgDividendPerPayment = recentActivities.reduce((sum, activity) => 
          sum + Math.abs(activity.netAmount || 0), 0) / recentActivities.length;
        
        // Calculate annual dividend based on frequency
        annualDividend = avgDividendPerPayment * dividendFrequency;
        annualDividendPerShare = shares > 0 ? annualDividend / shares : 0;
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
   * Calculate yield on cost metrics - FIXED VERSION
   */
  calculateYieldOnCost(shares, avgCost, totalReceived, annualDividendPerShare, annualDividend) {
    const totalCost = avgCost * shares;
    
    // Calculate dividend return percentage using actual totalReceived
    const dividendReturnPercent = totalCost > 0 && totalReceived > 0 ? 
      (totalReceived / totalCost) * 100 : 0;
    
    // FIXED: Calculate yield on cost using projected annual dividend
    // Yield on Cost = (Annual Dividend Per Share / Average Cost Per Share) * 100
    const yieldOnCost = avgCost > 0 && annualDividendPerShare > 0 ? 
      (annualDividendPerShare / avgCost) * 100 : 0;

    // Alternative calculation using total amounts for verification
    // const yieldOnCostTotal = totalCost > 0 && annualDividend > 0 ? 
    //   (annualDividend / totalCost) * 100 : 0;

    // Calculate dividend-adjusted cost using actual totalReceived
    const dividendAdjustedCostPerShare = totalReceived > 0 && shares > 0 ? 
      Math.max(0, avgCost - (totalReceived / shares)) : avgCost;
    const dividendAdjustedCost = dividendAdjustedCostPerShare * shares;

    // FIXED: Log yield calculation for debugging
    if (yieldOnCost > 0) {
      logger.debug('Yield on Cost calculation:', {
        avgCost,
        annualDividendPerShare,
        yieldOnCost: yieldOnCost.toFixed(2) + '%',
        totalCost,
        annualDividend
      });
    }

    return {
      dividendReturnPercent,
      yieldOnCost,
      dividendAdjustedCost,
      dividendAdjustedCostPerShare
    };
  }

  /**
   * Estimate dividend frequency from payment history
   */
  estimateFrequencyFromHistory(dividendActivities) {
    if (dividendActivities.length < 2) {
      return 0;
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

    return 0; // Beyond ~13 months between payments - treat as non-regular
  }

  /**
   * Get default dividend data structure
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
   * FIXED: Force recalculate dividends for all positions
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
          
          // FIXED: Also update dividendPerShare and isDividendStock at position level
          const isDividendStock = newDividendData.annualDividend > 0;
          const dividendPerShare = newDividendData.annualDividendPerShare || 0;
          
          // Update position
          await Position.findByIdAndUpdate(position._id, {
            dividendData: newDividendData,
            isDividendStock,
            dividendPerShare,
            updatedAt: new Date()
          });
          
          if (newDividendData.yieldOnCost > 0) {
            logger.debug(`Updated ${position.symbol}: YoC = ${newDividendData.yieldOnCost.toFixed(2)}%, Annual = $${newDividendData.annualDividend.toFixed(2)}`);
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