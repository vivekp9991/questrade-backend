// services/dataSync.js
const questradeApi = require('./questradeApi');
const Account = require('../models/Account');
const Position = require('../models/Position');
const Symbol = require('../models/Symbol');
const Activity = require('../models/Activity');
const MarketQuote = require('../models/MarketQuote');
const PortfolioSnapshot = require('../models/PortfolioSnapshot');
const logger = require('../utils/logger');

class DataSyncService {
  // Sync all accounts
  async syncAccounts() {
    try {
      const { accounts } = await questradeApi.getAccounts();
      
      for (const account of accounts) {
        await Account.findOneAndUpdate(
          { accountId: account.number },
          {
            accountId: account.number,
            type: account.type,
            number: account.number,
            status: account.status,
            isPrimary: account.isPrimary,
            isBilling: account.isBilling,
            clientAccountType: account.clientAccountType,
            syncedAt: new Date()
          },
          { upsert: true, new: true }
        );
        
        // Sync balances for each account
        await this.syncAccountBalances(account.number);
      }
      
      logger.info(`Synced ${accounts.length} accounts`);
      return accounts;
    } catch (error) {
      logger.error('Error syncing accounts:', error);
      throw error;
    }
  }

  // Sync account balances
  async syncAccountBalances(accountId) {
    try {
      const balances = await questradeApi.getAccountBalances(accountId);
      
      await Account.findOneAndUpdate(
        { accountId },
        {
          balances: {
            ...balances,
            lastUpdated: new Date()
          },
          updatedAt: new Date()
        }
      );
      
      logger.info(`Synced balances for account ${accountId}`);
      return balances;
    } catch (error) {
      logger.error(`Error syncing balances for account ${accountId}:`, error);
      throw error;
    }
  }

  // Sync positions for an account
  async syncPositions(accountId) {
    try {
      const { positions } = await questradeApi.getAccountPositions(accountId);
      
      // If no positions, return early
      if (!positions || positions.length === 0) {
        logger.info(`No positions found for account ${accountId}`);
        return [];
      }
      
      // Get symbol IDs for batch quote fetch
      const symbolIds = positions.map(p => p.symbolId).filter(id => id != null);
      
      // Only fetch if we have symbol IDs
      let symbolMap = {};
      let quoteMap = {};
      
      if (symbolIds.length > 0) {
        try {
          // Fetch symbols - using comma-separated string
          const symbolsData = await questradeApi.getSymbols(symbolIds.join(','));
          
          if (symbolsData.symbols) {
            symbolsData.symbols.forEach(sym => {
              symbolMap[sym.symbolId] = sym;
            });
          }
        } catch (error) {
          logger.warn(`Could not fetch symbol data: ${error.message}`);
        }
        
        // Try to fetch quotes - this might fail if market data access is not enabled
        try {
          const quotesData = await questradeApi.getMarketQuote(symbolIds);
          
          if (quotesData.quotes) {
            quotesData.quotes.forEach(quote => {
              quoteMap[quote.symbolId] = quote;
            });
          }
        } catch (error) {
          if (error.message.includes('OAuth scopes')) {
            logger.warn('Market data access not enabled. Enable it in your Questrade app settings.');
            logger.warn('Continuing without real-time quotes...');
          } else {
            logger.warn(`Could not fetch quote data: ${error.message}`);
          }
        }
      }
      
      // Process each position
      for (const position of positions) {
        const symbolInfo = symbolMap[position.symbolId] || {};
        const quote = quoteMap[position.symbolId] || {};
        
        // Calculate metrics
        const totalReturnValue = position.openPnl || 0;
        const totalReturnPercent = position.averageEntryPrice > 0 
          ? ((position.currentPrice - position.averageEntryPrice) / position.averageEntryPrice) * 100 
          : 0;
        
        // Get dividend data from activities
        const dividendData = await this.calculateDividendMetrics(accountId, position.symbol);
        
        await Position.findOneAndUpdate(
          { accountId, symbol: position.symbol },
          {
            accountId,
            symbol: position.symbol,
            symbolId: position.symbolId,
            openQuantity: position.openQuantity,
            closedQuantity: position.closedQuantity || 0,
            currentMarketValue: position.currentMarketValue,
            currentPrice: quote.lastTradePrice || position.currentPrice,
            averageEntryPrice: position.averageEntryPrice,
            dayPnl: position.dayPnl || 0,
            closedPnl: position.closedPnl || 0,
            openPnl: position.openPnl || 0,
            totalCost: position.totalCost,
            isRealTime: position.isRealTime,
            isUnderReorg: position.isUnderReorg || false,
            totalReturnPercent,
            totalReturnValue,
            capitalGainPercent: totalReturnPercent,
            capitalGainValue: totalReturnValue,
            dividendData,
            marketData: {
              lastPrice: quote.lastTradePrice || position.currentPrice,
              bidPrice: quote.bidPrice,
              askPrice: quote.askPrice,
              volume: quote.volume,
              dayHigh: quote.highPrice,
              dayLow: quote.lowPrice,
              fiftyTwoWeekHigh: symbolInfo.highPrice52,
              fiftyTwoWeekLow: symbolInfo.lowPrice52,
              lastUpdated: new Date()
            },
            syncedAt: new Date()
          },
          { upsert: true, new: true }
        );
        
        // Update symbol information if we have it
        if (symbolInfo.symbol) {
          await Symbol.findOneAndUpdate(
            { symbolId: position.symbolId },
            {
              symbol: symbolInfo.symbol,
              symbolId: symbolInfo.symbolId,
              description: symbolInfo.description,
              securityType: symbolInfo.securityType,
              listingExchange: symbolInfo.listingExchange,
              currency: symbolInfo.currency,
              isTradable: symbolInfo.isTradable,
              isQuotable: symbolInfo.isQuotable,
              prevDayClosePrice: symbolInfo.prevDayClosePrice,
              highPrice52: symbolInfo.highPrice52,
              lowPrice52: symbolInfo.lowPrice52,
              averageVol3Months: symbolInfo.averageVol3Months,
              averageVol20Days: symbolInfo.averageVol20Days,
              outstandingShares: symbolInfo.outstandingShares,
              marketCap: symbolInfo.marketCap,
              dividend: symbolInfo.dividend,
              dividendPerShare: symbolInfo.dividend,
              yield: symbolInfo.yield,
              exDate: symbolInfo.exDate,
              dividendDate: symbolInfo.dividendDate,
              industrySector: symbolInfo.industrySector,
              industryGroup: symbolInfo.industryGroup,
              industrySubGroup: symbolInfo.industrySubGroup,
              minTicks: symbolInfo.minTicks,
              eps: symbolInfo.eps,
              pe: symbolInfo.pe,
              hasOptions: symbolInfo.hasOptions,
              lastUpdated: new Date()
            },
            { upsert: true, new: true }
          );
        }
        
        // Save market quote if available
        if (quote.symbol) {
          try {
            await MarketQuote.create({
              symbol: quote.symbol,
              symbolId: quote.symbolId,
              bidPrice: quote.bidPrice,
              bidSize: quote.bidSize,
              askPrice: quote.askPrice,
              askSize: quote.askSize,
              lastTradePrice: quote.lastTradePrice,
              lastTradeSize: quote.lastTradeSize,
              lastTradeTick: quote.lastTradeTick,
              lastTradeTime: quote.lastTradeTime,
              volume: quote.volume,
              openPrice: quote.openPrice,
              highPrice: quote.highPrice,
              lowPrice: quote.lowPrice,
              delay: quote.delay,
              isHalted: quote.isHalted,
              VWAP: quote.VWAP,
              isSnapQuote: false,
              snapQuoteTime: new Date()
            });
          } catch (error) {
            logger.warn(`Could not save market quote: ${error.message}`);
          }
        }
      }
      
      logger.info(`Synced ${positions.length} positions for account ${accountId}`);
      return positions;
    } catch (error) {
      logger.error(`Error syncing positions for account ${accountId}:`, error);
      throw error;
    }
  }


  // Calculate dividend metrics for a position
  async calculateDividendMetrics(accountId, symbol) {
    try {
      const dividends = await Activity.find({
        accountId,
        symbol,
        type: 'Dividend'
      }).sort({ transactionDate: -1 });
      
      if (dividends.length === 0) {
        return {
          totalReceived: 0,
          lastDividendAmount: 0,
          lastDividendDate: null,
          dividendReturnPercent: 0,
          yieldOnCost: 0,
          dividendAdjustedCost: 0,
          dividendAdjustedCostPerShare: 0,
          monthlyDividend: 0,
          monthlyDividendPerShare: 0,
          annualDividend: 0,
          annualDividendPerShare: 0,
          dividendFrequency: 0
        };
      }
      
      const totalReceived = dividends.reduce((sum, div) => sum + Math.abs(div.netAmount), 0);
      const lastDividend = dividends[0];
      
      // Get position for cost basis and shares
      const position = await Position.findOne({ accountId, symbol });
      const totalCost = position ? position.totalCost : 0;
      const shares = position ? position.openQuantity : 0;
      const avgCost = shares > 0 ? totalCost / shares : 0;
      
      // Determine dividend frequency by analyzing payment patterns
      let dividendFrequency = 0; // payments per year
      let monthlyDividendTotal = 0;
      let annualDividendTotal = 0;
      let monthlyDividendPerShare = 0;
      let annualDividendPerShare = 0;
      
      if (dividends.length >= 2) {
        // Calculate average days between dividends for last year
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        
        const recentDividends = dividends.filter(d => 
          new Date(d.transactionDate) > oneYearAgo
        );
        
        if (recentDividends.length >= 2) {
          // Calculate frequency based on payment patterns
          const daysBetweenPayments = [];
          for (let i = 0; i < recentDividends.length - 1; i++) {
            const days = Math.abs(
              (new Date(recentDividends[i].transactionDate) - new Date(recentDividends[i + 1].transactionDate)) 
              / (1000 * 60 * 60 * 24)
            );
            daysBetweenPayments.push(days);
          }
          
          const avgDaysBetween = daysBetweenPayments.reduce((a, b) => a + b, 0) / daysBetweenPayments.length;
          
          // Determine frequency based on average days between payments
          if (avgDaysBetween <= 35) {
            dividendFrequency = 12; // Monthly
          } else if (avgDaysBetween <= 100) {
            dividendFrequency = 4;  // Quarterly
          } else if (avgDaysBetween <= 200) {
            dividendFrequency = 2;  // Semi-annual
          } else {
            dividendFrequency = 1;  // Annual
          }
          
          // Calculate based on most recent dividend and frequency
          const lastDividendAmount = Math.abs(lastDividend.netAmount);
          
          // Get dividend per share from the last dividend
          const lastDividendPerShare = lastDividend.quantity > 0 
            ? lastDividendAmount / lastDividend.quantity 
            : (shares > 0 ? lastDividendAmount / shares : 0);
          
          // Project annual amounts
          annualDividendPerShare = lastDividendPerShare * dividendFrequency;
          annualDividendTotal = annualDividendPerShare * shares;
          
          // Calculate monthly amounts
          monthlyDividendPerShare = annualDividendPerShare / 12;
          monthlyDividendTotal = annualDividendTotal / 12;
          
        } else {
          // If we only have one recent dividend, estimate based on that
          const lastDividendAmount = Math.abs(lastDividend.netAmount);
          const lastDividendPerShare = lastDividend.quantity > 0 
            ? lastDividendAmount / lastDividend.quantity 
            : (shares > 0 ? lastDividendAmount / shares : 0);
          
          // Assume quarterly if we can't determine
          dividendFrequency = 4;
          annualDividendPerShare = lastDividendPerShare * 4;
          annualDividendTotal = annualDividendPerShare * shares;
          monthlyDividendPerShare = annualDividendPerShare / 12;
          monthlyDividendTotal = annualDividendTotal / 12;
        }
      } else if (dividends.length === 1) {
        // Only one dividend ever - assume quarterly
        const lastDividendAmount = Math.abs(lastDividend.netAmount);
        const lastDividendPerShare = lastDividend.quantity > 0 
          ? lastDividendAmount / lastDividend.quantity 
          : (shares > 0 ? lastDividendAmount / shares : 0);
        
        dividendFrequency = 4;
        annualDividendPerShare = lastDividendPerShare * 4;
        annualDividendTotal = annualDividendPerShare * shares;
        monthlyDividendPerShare = annualDividendPerShare / 12;
        monthlyDividendTotal = annualDividendTotal / 12;
      }
      
      // Calculate yield metrics using projected annual dividend per share
      const yieldOnCost = avgCost > 0 ? (annualDividendPerShare / avgCost) * 100 : 0;
      
      // Dividend return percent is based on actual total received
      const dividendReturnPercent = totalCost > 0 ? (totalReceived / totalCost) * 100 : 0;
      
      // Dividend adjusted cost per share
      const dividendAdjustedCostPerShare = shares > 0 ? avgCost - (totalReceived / shares) : avgCost;
      const dividendAdjustedCost = dividendAdjustedCostPerShare * shares;
      
      logger.info(`Dividend metrics for ${symbol}: frequency=${dividendFrequency}, monthlyPerShare=$${monthlyDividendPerShare.toFixed(4)}, annualPerShare=$${annualDividendPerShare.toFixed(4)}`);
      
      return {
        totalReceived,
        lastDividendAmount: Math.abs(lastDividend.netAmount),
        lastDividendDate: lastDividend.transactionDate,
        dividendReturnPercent,
        yieldOnCost,
        dividendAdjustedCost,
        dividendAdjustedCostPerShare,
        monthlyDividend: monthlyDividendTotal,  // Total for all shares
        monthlyDividendPerShare,  // Per share - NEW
        annualDividend: annualDividendTotal,    // Total for all shares
        annualDividendPerShare,   // Per share - NEW
        dividendFrequency
      };
    } catch (error) {
      logger.error(`Error calculating dividend metrics for ${symbol}:`, error);
      return {
        totalReceived: 0,
        lastDividendAmount: 0,
        lastDividendDate: null,
        dividendReturnPercent: 0,
        yieldOnCost: 0,
        dividendAdjustedCost: 0,
        dividendAdjustedCostPerShare: 0,
        monthlyDividend: 0,
        monthlyDividendPerShare: 0,
        annualDividend: 0,
        annualDividendPerShare: 0,
        dividendFrequency: 0
      };
    }
  }

  // Format date for Questrade API (ISO format with timezone)
  formatQuestradeDate(date) {
    const d = new Date(date);
    // Questrade expects ISO format with timezone like: 2011-02-01T00:00:00.000000-05:00
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    
    // Use Eastern Time zone offset (-05:00 for EST, -04:00 for EDT)
    // For simplicity, we'll use -05:00 which Questrade accepts year-round
    return `${year}-${month}-${day}T00:00:00-05:00`;
  }

  // Sync account activities (dividends, trades, etc.)
  async syncActivities(accountId, startDate = null, endDate = null) {
    try {
      // Default to last 30 days if no dates provided
      if (!endDate) {
        endDate = new Date();
      }
      if (!startDate) {
        startDate = new Date();
        startDate.setDate(startDate.getDate() - 30);
      }
      
      // Format dates for Questrade API
      const formattedStartDate = this.formatQuestradeDate(startDate);
      const formattedEndDate = this.formatQuestradeDate(endDate);
      
      logger.info(`Fetching activities from ${formattedStartDate} to ${formattedEndDate}`);
      
      const { activities } = await questradeApi.getAccountActivities(
        accountId, 
        formattedStartDate, 
        formattedEndDate
      );
      
      let newActivities = 0;
      
      for (const activity of activities) {
        // Normalize activity type
        let normalizedType = 'Other';
        const rawType = activity.type || '';
        
        if (rawType.toLowerCase().includes('trade')) {
          normalizedType = 'Trade';
        } else if (rawType.toLowerCase().includes('dividend')) {
          normalizedType = 'Dividend';
        } else if (rawType.toLowerCase().includes('deposit')) {
          normalizedType = 'Deposit';
        } else if (rawType.toLowerCase().includes('withdrawal')) {
          normalizedType = 'Withdrawal';
        } else if (rawType.toLowerCase().includes('interest')) {
          normalizedType = 'Interest';
        } else if (rawType.toLowerCase().includes('transfer')) {
          normalizedType = 'Transfer';
        } else if (rawType.toLowerCase().includes('fee')) {
          normalizedType = 'Fee';
        } else if (rawType.toLowerCase().includes('tax')) {
          normalizedType = 'Tax';
        } else if (rawType.toLowerCase().includes('fx')) {
          normalizedType = 'FX';
        }
        
        // Check if activity already exists
        const exists = await Activity.findOne({
          accountId,
          transactionDate: activity.transactionDate,
          symbol: activity.symbol,
          type: normalizedType,
          netAmount: activity.netAmount
        });
        
        if (!exists) {
          await Activity.create({
            accountId,
            tradeDate: activity.tradeDate,
            transactionDate: activity.transactionDate,
            settlementDate: activity.settlementDate,
            action: activity.action,
            symbol: activity.symbol,
            symbolId: activity.symbolId,
            description: activity.description,
            currency: activity.currency,
            quantity: activity.quantity,
            price: activity.price,
            grossAmount: activity.grossAmount,
            commission: activity.commission,
            netAmount: activity.netAmount,
            type: normalizedType,
            rawType: rawType,
            isDividend: normalizedType === 'Dividend',
            dividendPerShare: normalizedType === 'Dividend' && activity.quantity > 0 
              ? Math.abs(activity.netAmount) / activity.quantity 
              : 0
          });
          newActivities++;
        }
      }
      
      logger.info(`Synced ${activities.length} activities for account ${accountId} (${newActivities} new)`);
      return activities;
    } catch (error) {
      logger.error(`Error syncing activities for account ${accountId}:`, error);
      // Don't throw - activities are not critical for basic functionality
      return [];
    }
  }

  // Create portfolio snapshot
  async createPortfolioSnapshot(accountId = null) {
    try {
      const query = accountId ? { accountId } : {};
      const positions = await Position.find(query);
      const accounts = await Account.find(query);
      
      if (positions.length === 0) {
        logger.info(`No positions to snapshot for account ${accountId || 'all'}`);
        return null;
      }
      
      // Calculate totals
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
        
        // Get symbol info for sector allocation
        const symbol = await Symbol.findOne({ symbolId: position.symbolId });
        if (symbol) {
          const sector = symbol.securityType || 'Other';
          sectorMap[sector] = (sectorMap[sector] || 0) + position.currentMarketValue;
          
          const currency = symbol.currency || 'CAD';
          currencyMap[currency] = (currencyMap[currency] || 0) + position.currentMarketValue;
        }
      }
      
      const totalReturnValue = unrealizedPnl + totalDividends;
      const totalReturnPercent = totalInvestment > 0 
        ? (totalReturnValue / totalInvestment) * 100 
        : 0;
      
      const averageYieldPercent = currentValue > 0 
        ? (annualProjectedDividend / currentValue) * 100 
        : 0;
      
      const yieldOnCostPercent = totalInvestment > 0 
        ? (annualProjectedDividend / totalInvestment) * 100 
        : 0;
      
      // Format allocations
      const sectorAllocation = Object.entries(sectorMap).map(([sector, value]) => ({
        sector,
        value,
        percentage: (value / currentValue) * 100
      }));
      
      const currencyBreakdown = Object.entries(currencyMap).map(([currency, value]) => ({
        currency,
        value,
        percentage: (value / currentValue) * 100
      }));
      
      const snapshot = await PortfolioSnapshot.create({
        accountId,
        date: new Date(),
        totalInvestment,
        currentValue,
        totalReturnValue,
        totalReturnPercent,
        unrealizedPnl,
        realizedPnl: 0, // TODO: Calculate from closed positions
        totalDividends,
        monthlyDividendIncome,
        annualProjectedDividend,
        averageYieldPercent,
        yieldOnCostPercent,
        numberOfPositions: positions.length,
        numberOfDividendStocks: positions.filter(p => 
          p.dividendData && p.dividendData.annualDividend > 0
        ).length,
        sectorAllocation,
        currencyBreakdown,
        assetAllocation: [] // TODO: Implement asset class allocation
      });
      
      logger.info(`Created portfolio snapshot for account ${accountId || 'all'}`);
      return snapshot;
    } catch (error) {
      logger.error('Error creating portfolio snapshot:', error);
      // Don't throw - snapshots are not critical
      return null;
    }
  }

  // Full sync for an account
  async fullSync(accountId = null) {
    try {
      logger.info(`Starting full sync for account ${accountId || 'all'}`);
      
      // Sync accounts
      const accounts = await this.syncAccounts();
      
      // Sync data for each account
      for (const account of accounts) {
        const accId = account.number;
        
        // Skip if specific account requested and doesn't match
        if (accountId && accountId !== accId) continue;
        
        // Sync positions (most important)
        try {
          await this.syncPositions(accId);
        } catch (error) {
          logger.error(`Failed to sync positions for ${accId}:`, error.message);
        }
        
        // Sync activities (less critical)
        try {
          await this.syncActivities(accId);
        } catch (error) {
          logger.warn(`Failed to sync activities for ${accId}:`, error.message);
        }
        
        // Create snapshot after sync
        try {
          await this.createPortfolioSnapshot(accId);
        } catch (error) {
          logger.warn(`Failed to create snapshot for ${accId}:`, error.message);
        }
      }
      
      logger.info(`Full sync completed for account ${accountId || 'all'}`);
      return { success: true, accountsSynced: accounts.length };
    } catch (error) {
      logger.error('Error during full sync:', error);
      throw error;
    }
  }
}

module.exports = new DataSyncService();