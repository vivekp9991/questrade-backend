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
      
      // Get symbol IDs for batch quote fetch
      const symbolIds = positions.map(p => p.symbolId);
      
      // Fetch symbol details and quotes
      const [symbolsData, quotesData] = await Promise.all([
        questradeApi.getSymbols(symbolIds.join(',')),
        questradeApi.getSnapQuote(symbolIds)
      ]);
      
      const symbolMap = {};
      const quoteMap = {};
      
      if (symbolsData.symbols) {
        symbolsData.symbols.forEach(sym => {
          symbolMap[sym.symbolId] = sym;
        });
      }
      
      if (quotesData.quotes) {
        quotesData.quotes.forEach(quote => {
          quoteMap[quote.symbolId] = quote;
        });
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
              lastPrice: quote.lastTradePrice,
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
        
        // Update symbol information
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
              yield: symbolInfo.yield,
              exDate: symbolInfo.exDate,
              dividendDate: symbolInfo.dividendDate,
              eps: symbolInfo.eps,
              pe: symbolInfo.pe,
              hasOptions: symbolInfo.hasOptions,
              lastUpdated: new Date()
            },
            { upsert: true, new: true }
          );
        }
        
        // Save market quote
        if (quote.symbol) {
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
            isSnapQuote: quote.isSnapQuote,
            snapQuoteTime: quote.snapQuoteTime
          });
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
          monthlyDividend: 0,
          annualDividend: 0
        };
      }
      
      const totalReceived = dividends.reduce((sum, div) => sum + Math.abs(div.netAmount), 0);
      const lastDividend = dividends[0];
      
      // Get position for cost basis
      const position = await Position.findOne({ accountId, symbol });
      const totalCost = position ? position.totalCost : 0;
      
      // Calculate annual dividend based on last 12 months
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      
      const recentDividends = dividends.filter(d => 
        new Date(d.transactionDate) > oneYearAgo
      );
      
      const annualDividend = recentDividends.reduce((sum, div) => 
        sum + Math.abs(div.netAmount), 0
      );
      
      const monthlyDividend = annualDividend / 12;
      const yieldOnCost = totalCost > 0 ? (annualDividend / totalCost) * 100 : 0;
      const dividendReturnPercent = totalCost > 0 ? (totalReceived / totalCost) * 100 : 0;
      const dividendAdjustedCost = totalCost - totalReceived;
      
      return {
        totalReceived,
        lastDividendAmount: Math.abs(lastDividend.netAmount),
        lastDividendDate: lastDividend.transactionDate,
        dividendReturnPercent,
        yieldOnCost,
        dividendAdjustedCost,
        monthlyDividend,
        annualDividend
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
        monthlyDividend: 0,
        annualDividend: 0
      };
    }
  }

  // Sync account activities (dividends, trades, etc.)
  async syncActivities(accountId, startDate = null, endDate = null) {
    try {
      // Default to last 30 days if no dates provided
      if (!endDate) endDate = new Date().toISOString();
      if (!startDate) {
        const start = new Date();
        start.setDate(start.getDate() - 30);
        startDate = start.toISOString();
      }
      
      const { activities } = await questradeApi.getAccountActivities(
        accountId, 
        startDate, 
        endDate
      );
      
      for (const activity of activities) {
        // Check if activity already exists
        const exists = await Activity.findOne({
          accountId,
          transactionDate: activity.transactionDate,
          symbol: activity.symbol,
          type: activity.type,
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
            type: activity.type,
            isDividend: activity.type === 'Dividend',
            dividendPerShare: activity.type === 'Dividend' && activity.quantity > 0 
              ? Math.abs(activity.netAmount) / activity.quantity 
              : 0
          });
        }
      }
      
      logger.info(`Synced ${activities.length} activities for account ${accountId}`);
      return activities;
    } catch (error) {
      logger.error(`Error syncing activities for account ${accountId}:`, error);
      throw error;
    }
  }

  // Create portfolio snapshot
  async createPortfolioSnapshot(accountId = null) {
    try {
      const query = accountId ? { accountId } : {};
      const positions = await Position.find(query);
      const accounts = await Account.find(query);
      
      if (positions.length === 0) return null;
      
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
      
      const averageYieldPercent = totalInvestment > 0 
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
      throw error;
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
        
        await Promise.all([
          this.syncPositions(accId),
          this.syncActivities(accId)
        ]);
        
        // Create snapshot after sync
        await this.createPortfolioSnapshot(accId);
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