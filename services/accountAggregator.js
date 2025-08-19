// services/accountAggregator.js
const logger = require('../utils/logger');

class AccountAggregator {
  constructor(dbManager) {
    this.dbManager = dbManager;
  }

  /**
   * Aggregate positions based on view mode
   * @param {Array} positions - Raw positions from database
   * @param {string} viewMode - 'all', 'account', 'person', or 'type'
   * @param {Object} options - Additional options
   * @returns {Array} Aggregated positions
   */
  aggregatePositions(positions, viewMode = 'all', options = {}) {
    try {
      // FIXED: Include 'account' and 'person' in valid view modes
      const validViewModes = ['all', 'account', 'person', 'type'];
      if (!validViewModes.includes(viewMode)) {
        throw new Error(`Invalid view mode: ${viewMode}. Must be one of: ${validViewModes.join(', ')}`);
      }

      logger.debug(`Aggregating ${positions.length} positions with view mode: ${viewMode}`, options);

      switch (viewMode) {
        case 'all':
          return options.aggregate !== false 
            ? this.aggregateAllAccounts(positions, options)
            : this.individualPositions(positions, options);
        case 'account':
          return this.aggregateByAccount(positions, options);
        case 'person':
          return options.aggregate !== false
            ? this.aggregateByPerson(positions, options)
            : this.individualPositionsByPerson(positions, options);
        case 'type':
          return this.aggregateByType(positions, options);
        default:
          throw new Error(`Invalid view mode: ${viewMode}`);
      }
    } catch (error) {
      logger.error('Error aggregating positions:', error);
      throw error;
    }
  }

  /**
   * Aggregate all positions across all accounts
   */
  aggregateAllAccounts(positions, options = {}) {
    const aggregated = new Map();

    positions.forEach(position => {
      const key = position.symbol;
      
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          symbol: position.symbol,
          symbolId: position.symbolId,
          totalQuantity: 0,
          totalCost: 0,
          totalMarketValue: 0,
          accounts: new Set(),
          persons: new Set(),
          accountDetails: [],
          currentPrice: position.currentPrice,
          currency: position.currency,
          securityType: position.securityType,
          lastUpdated: position.lastUpdated,
          isDividendStock: position.isDividendStock || false,
          dividendYield: position.dividendYield || 0,
          annualDividend: position.annualDividend || 0
        });
      }

      const agg = aggregated.get(key);
      agg.totalQuantity += position.openQuantity || 0;
      agg.totalCost += (position.totalCost || 0);
      agg.totalMarketValue += (position.currentMarketValue || 0);
      agg.accounts.add(position.accountId);
      
      // Add person tracking
      if (position.personName) {
        agg.persons.add(position.personName);
      }
      
      agg.accountDetails.push({
        accountId: position.accountId,
        accountName: position.accountName,
        accountType: position.accountType,
        personName: position.personName,
        quantity: position.openQuantity,
        cost: position.totalCost,
        marketValue: position.currentMarketValue,
        averageEntryPrice: position.averageEntryPrice,
        unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
        unrealizedPnLPercent: position.totalCost > 0 
          ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
          : 0
      });

      // Update price if more recent
      if (position.lastUpdated > agg.lastUpdated) {
        agg.currentPrice = position.currentPrice;
        agg.lastUpdated = position.lastUpdated;
      }
    });

    // Convert to array and calculate additional metrics
    return Array.from(aggregated.values()).map(pos => {
      const avgPrice = pos.totalQuantity > 0 ? pos.totalCost / pos.totalQuantity : 0;
      const unrealizedPnL = pos.totalMarketValue - pos.totalCost;
      const unrealizedPnLPercent = pos.totalCost > 0 ? (unrealizedPnL / pos.totalCost) * 100 : 0;

      return {
        ...pos,
        accounts: Array.from(pos.accounts),
        persons: Array.from(pos.persons),
        accountCount: pos.accounts.size,
        personCount: pos.persons.size,
        averageEntryPrice: avgPrice,
        unrealizedPnL,
        unrealizedPnLPercent,
        dayPnL: 0, // This would need market data
        dayPnLPercent: 0,
        totalAnnualDividend: pos.isDividendStock ? pos.totalQuantity * pos.annualDividend : 0
      };
    });
  }

  /**
   * Return individual positions without aggregation
   */
  individualPositions(positions, options = {}) {
    return positions.map(position => ({
      symbol: position.symbol,
      symbolId: position.symbolId,
      accountId: position.accountId,
      accountName: position.accountName,
      accountType: position.accountType,
      personName: position.personName,
      quantity: position.openQuantity || 0,
      averageEntryPrice: position.averageEntryPrice || 0,
      currentPrice: position.currentPrice || 0,
      totalCost: position.totalCost || 0,
      marketValue: position.currentMarketValue || 0,
      unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
      unrealizedPnLPercent: position.totalCost > 0 
        ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
        : 0,
      dayPnL: position.dayPnL || 0,
      dayPnLPercent: position.dayPnLPercent || 0,
      currency: position.currency,
      securityType: position.securityType,
      isDividendStock: position.isDividendStock || false,
      dividendYield: position.dividendYield || 0,
      annualDividend: position.annualDividend || 0,
      lastUpdated: position.lastUpdated
    }));
  }

  /**
   * Aggregate positions by account
   */
  aggregateByAccount(positions, options = {}) {
    const { accountId } = options;
    
    // Filter by specific account if provided
    let filteredPositions = positions;
    if (accountId) {
      filteredPositions = positions.filter(p => String(p.accountId) === String(accountId));
      logger.debug(`Filtered to ${filteredPositions.length} positions for account ${accountId}`);
      
      // If specific account requested, return positions for that account
      return this.individualPositions(filteredPositions, options);
    }

    // Group by account
    const accountGroups = new Map();
    
    filteredPositions.forEach(position => {
      const accId = position.accountId;
      
      if (!accountGroups.has(accId)) {
        accountGroups.set(accId, {
          accountId: accId,
          accountName: position.accountName,
          accountType: position.accountType,
          personName: position.personName,
          positions: [],
          totalValue: 0,
          totalCost: 0,
          totalPnL: 0,
          totalPnLPercent: 0,
          cashBalances: {}
        });
      }
      
      const account = accountGroups.get(accId);
      
      const positionData = {
        symbol: position.symbol,
        symbolId: position.symbolId,
        quantity: position.openQuantity || 0,
        averageEntryPrice: position.averageEntryPrice || 0,
        currentPrice: position.currentPrice || 0,
        totalCost: position.totalCost || 0,
        marketValue: position.currentMarketValue || 0,
        unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
        unrealizedPnLPercent: position.totalCost > 0 
          ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
          : 0,
        currency: position.currency,
        securityType: position.securityType,
        isDividendStock: position.isDividendStock || false,
        dividendYield: position.dividendYield || 0,
        lastUpdated: position.lastUpdated
      };
      
      account.positions.push(positionData);
      account.totalValue += positionData.marketValue;
      account.totalCost += positionData.totalCost;
      account.totalPnL += positionData.unrealizedPnL;
    });
    
    // Calculate account-level metrics
    accountGroups.forEach(account => {
      account.totalPnLPercent = account.totalCost > 0 
        ? (account.totalPnL / account.totalCost) * 100 
        : 0;
      account.positionCount = account.positions.length;
    });
    
    return Array.from(accountGroups.values());
  }

  /**
   * Aggregate positions by person
   */
  aggregateByPerson(positions, options = {}) {
    const { personName, aggregate = true } = options;
    
    // Filter by specific person if provided
    let filteredPositions = positions;
    if (personName) {
      filteredPositions = positions.filter(p => p.personName === personName);
      logger.debug(`Filtered to ${filteredPositions.length} positions for person ${personName}`);
    }

    if (!aggregate) {
      return this.individualPositions(filteredPositions, options);
    }

    // Aggregate positions by symbol for the person
    const aggregated = new Map();

    filteredPositions.forEach(position => {
      const key = position.symbol;
      
      if (!aggregated.has(key)) {
        aggregated.set(key, {
          symbol: position.symbol,
          symbolId: position.symbolId,
          personName: position.personName,
          totalQuantity: 0,
          totalCost: 0,
          totalMarketValue: 0,
          accounts: [],
          currentPrice: position.currentPrice,
          currency: position.currency,
          securityType: position.securityType,
          lastUpdated: position.lastUpdated,
          isDividendStock: position.isDividendStock || false,
          dividendYield: position.dividendYield || 0,
          annualDividend: position.annualDividend || 0
        });
      }

      const agg = aggregated.get(key);
      agg.totalQuantity += position.openQuantity || 0;
      agg.totalCost += position.totalCost || 0;
      agg.totalMarketValue += position.currentMarketValue || 0;
      
      agg.accounts.push({
        accountId: position.accountId,
        accountName: position.accountName,
        accountType: position.accountType,
        quantity: position.openQuantity,
        cost: position.totalCost,
        marketValue: position.currentMarketValue,
        averageEntryPrice: position.averageEntryPrice
      });

      // Update price if more recent
      if (position.lastUpdated > agg.lastUpdated) {
        agg.currentPrice = position.currentPrice;
        agg.lastUpdated = position.lastUpdated;
      }
    });

    // Convert to array and calculate metrics
    return Array.from(aggregated.values()).map(pos => {
      const avgPrice = pos.totalQuantity > 0 ? pos.totalCost / pos.totalQuantity : 0;
      const unrealizedPnL = pos.totalMarketValue - pos.totalCost;
      const unrealizedPnLPercent = pos.totalCost > 0 ? (unrealizedPnL / pos.totalCost) * 100 : 0;

      return {
        ...pos,
        accountCount: pos.accounts.length,
        averageEntryPrice: avgPrice,
        unrealizedPnL,
        unrealizedPnLPercent,
        dayPnL: 0,
        dayPnLPercent: 0,
        totalAnnualDividend: pos.isDividendStock ? pos.totalQuantity * pos.annualDividend : 0
      };
    });
  }

  /**
   * Return individual positions for a person without aggregation
   */
  individualPositionsByPerson(positions, options = {}) {
    const { personName } = options;
    
    let filteredPositions = positions;
    if (personName) {
      filteredPositions = positions.filter(p => p.personName === personName);
    }

    return this.individualPositions(filteredPositions, options);
  }

  /**
   * Aggregate positions by type (stock, ETF, etc.)
   */
  aggregateByType(positions, options = {}) {
    const typeGroups = new Map();
    
    positions.forEach(position => {
      const type = position.securityType || 'Unknown';
      
      if (!typeGroups.has(type)) {
        typeGroups.set(type, {
          type,
          positions: [],
          symbols: new Set(),
          accounts: new Set(),
          persons: new Set(),
          totalValue: 0,
          totalCost: 0,
          totalPnL: 0,
          totalPnLPercent: 0
        });
      }
      
      const group = typeGroups.get(type);
      
      const positionData = {
        symbol: position.symbol,
        symbolId: position.symbolId,
        accountId: position.accountId,
        accountName: position.accountName,
        personName: position.personName,
        quantity: position.openQuantity || 0,
        averageEntryPrice: position.averageEntryPrice || 0,
        currentPrice: position.currentPrice || 0,
        totalCost: position.totalCost || 0,
        marketValue: position.currentMarketValue || 0,
        unrealizedPnL: (position.currentMarketValue || 0) - (position.totalCost || 0),
        unrealizedPnLPercent: position.totalCost > 0 
          ? ((position.currentMarketValue - position.totalCost) / position.totalCost) * 100 
          : 0,
        currency: position.currency
      };
      
      group.positions.push(positionData);
      group.symbols.add(position.symbol);
      group.accounts.add(position.accountId);
      if (position.personName) {
        group.persons.add(position.personName);
      }
      group.totalValue += positionData.marketValue;
      group.totalCost += positionData.totalCost;
      group.totalPnL += positionData.unrealizedPnL;
    });
    
    // Calculate type-level metrics
    typeGroups.forEach(group => {
      group.totalPnLPercent = group.totalCost > 0 
        ? (group.totalPnL / group.totalCost) * 100 
        : 0;
      group.positionCount = group.positions.length;
      group.symbolCount = group.symbols.size;
      group.accountCount = group.accounts.size;
      group.personCount = group.persons.size;
      group.symbols = Array.from(group.symbols);
      group.accounts = Array.from(group.accounts);
      group.persons = Array.from(group.persons);
    });
    
    return Array.from(typeGroups.values());
  }

  /**
   * Get account summary
   */
  async getAccountSummary(accountId = null, personName = null) {
    try {
      // Build filter
      const filter = {};
      if (accountId) filter.accountId = accountId;
      if (personName) filter.personName = personName;

      const accounts = await this.dbManager.getAccounts(filter);
      const positions = await this.dbManager.getPositions(filter);
      const balances = await this.dbManager.getCashBalances(filter);
      
      const summaries = accounts.map(account => {
        const accountPositions = positions.filter(p => p.accountId === account.accountId);
        const accountBalances = balances.filter(b => b.accountId === account.accountId);
        
        const totalValue = accountPositions.reduce((sum, p) => sum + (p.currentMarketValue || 0), 0);
        const totalCost = accountPositions.reduce((sum, p) => sum + (p.totalCost || 0), 0);
        const totalPnL = totalValue - totalCost;
        const totalPnLPercent = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
        
        // Group cash balances by currency
        const cashByCurrency = {};
        accountBalances.forEach(balance => {
          if (!cashByCurrency[balance.currency]) {
            cashByCurrency[balance.currency] = 0;
          }
          cashByCurrency[balance.currency] += balance.cash || 0;
        });
        
        const totalCash = Object.values(cashByCurrency).reduce((sum, cash) => sum + cash, 0);
        
        return {
          accountId: account.accountId,
          accountName: account.name,
          accountType: account.type,
          accountNumber: account.number,
          personName: account.personName,
          status: account.status,
          isPrimary: account.isPrimary,
          isBilling: account.isBilling,
          currency: account.currency,
          positionCount: accountPositions.length,
          totalValue,
          totalCost,
          totalPnL,
          totalPnLPercent,
          totalCash,
          cashBalances: cashByCurrency,
          totalAccountValue: totalValue + totalCash,
          lastUpdated: account.lastUpdated
        };
      });
      
      return accountId ? summaries[0] : summaries;
    } catch (error) {
      logger.error('Error getting account summary:', error);
      throw error;
    }
  }

  /**
   * Aggregate cash balances based on view mode
   */
  async aggregateCashBalances(balances, viewMode = 'all', options = {}) {
    try {
      switch (viewMode) {
        case 'all':
          return this.aggregateAllCashBalances(balances, options);
        case 'account':
          return this.aggregateCashByAccount(balances, options);
        case 'person':
          return this.aggregateCashByPerson(balances, options);
        default:
          return this.aggregateAllCashBalances(balances, options);
      }
    } catch (error) {
      logger.error('Error aggregating cash balances:', error);
      throw error;
    }
  }

  /**
   * Aggregate all cash balances across all accounts
   */
  aggregateAllCashBalances(balances, options = {}) {
    const { currency } = options;
    
    // Filter by currency if specified
    let filteredBalances = balances;
    if (currency) {
      filteredBalances = balances.filter(b => b.currency === currency);
    }

    // Group by currency
    const currencyGroups = new Map();
    const accountDetails = [];
    
    filteredBalances.forEach(balance => {
      const curr = balance.currency;
      
      if (!currencyGroups.has(curr)) {
        currencyGroups.set(curr, {
          currency: curr,
          totalCash: 0,
          totalMarketValue: 0,
          totalCombined: 0,
          accounts: new Set(),
          persons: new Set()
        });
      }
      
      const group = currencyGroups.get(curr);
      group.totalCash += balance.cash || 0;
      group.totalMarketValue += balance.marketValue || 0;
      group.totalCombined += balance.totalEquity || 0;
      group.accounts.add(balance.accountId);
      if (balance.personName) {
        group.persons.add(balance.personName);
      }
      
      accountDetails.push({
        accountId: balance.accountId,
        accountName: balance.accountName,
        accountType: balance.accountType,
        personName: balance.personName,
        currency: balance.currency,
        cash: balance.cash,
        marketValue: balance.marketValue,
        totalEquity: balance.totalEquity,
        buyingPower: balance.buyingPower
      });
    });
    
    const currencies = Array.from(currencyGroups.values()).map(group => ({
      ...group,
      accountCount: group.accounts.size,
      personCount: group.persons.size,
      accounts: Array.from(group.accounts),
      persons: Array.from(group.persons)
    }));
    
    // Calculate grand totals (simplified - would need exchange rates for accuracy)
    const grandTotalCash = currencies.reduce((sum, c) => sum + c.totalCash, 0);
    const grandTotalMarketValue = currencies.reduce((sum, c) => sum + c.totalMarketValue, 0);
    const grandTotalCombined = currencies.reduce((sum, c) => sum + c.totalCombined, 0);
    
    return {
      viewMode: 'all',
      currencies,
      accountDetails,
      summary: {
        totalAccounts: new Set(accountDetails.map(a => a.accountId)).size,
        totalPersons: new Set(accountDetails.map(a => a.personName).filter(p => p)).size,
        grandTotalCash,
        grandTotalMarketValue,
        grandTotalCombined
      }
    };
  }

  /**
   * Aggregate cash balances by account
   */
  aggregateCashByAccount(balances, options = {}) {
    const { accountId } = options;
    
    // Filter by specific account if provided
    let filteredBalances = balances;
    if (accountId) {
      filteredBalances = balances.filter(b => String(b.accountId) === String(accountId));
    }

    // Group by account
    const accountGroups = new Map();
    
    filteredBalances.forEach(balance => {
      const accId = balance.accountId;
      
      if (!accountGroups.has(accId)) {
        accountGroups.set(accId, {
          accountId: accId,
          accountName: balance.accountName,
          accountType: balance.accountType,
          personName: balance.personName,
          currencies: []
        });
      }
      
      const account = accountGroups.get(accId);
      account.currencies.push({
        currency: balance.currency,
        cash: balance.cash,
        marketValue: balance.marketValue,
        totalEquity: balance.totalEquity,
        buyingPower: balance.buyingPower
      });
    });
    
    return Array.from(accountGroups.values());
  }

  /**
   * Aggregate cash balances by person
   */
  aggregateCashByPerson(balances, options = {}) {
    const { personName } = options;
    
    // Filter by specific person if provided
    let filteredBalances = balances;
    if (personName) {
      filteredBalances = balances.filter(b => b.personName === personName);
    }

    // Group by person and currency
    const personGroups = new Map();
    
    filteredBalances.forEach(balance => {
      const person = balance.personName || 'Unknown';
      
      if (!personGroups.has(person)) {
        personGroups.set(person, {
          personName: person,
          accounts: new Map(),
          currencies: new Map(),
          totalCash: 0,
          totalMarketValue: 0,
          totalEquity: 0
        });
      }
      
      const personData = personGroups.get(person);
      
      // Track by account
      if (!personData.accounts.has(balance.accountId)) {
        personData.accounts.set(balance.accountId, {
          accountId: balance.accountId,
          accountName: balance.accountName,
          accountType: balance.accountType,
          balances: []
        });
      }
      
      personData.accounts.get(balance.accountId).balances.push({
        currency: balance.currency,
        cash: balance.cash,
        marketValue: balance.marketValue,
        totalEquity: balance.totalEquity
      });
      
      // Track by currency
      if (!personData.currencies.has(balance.currency)) {
        personData.currencies.set(balance.currency, {
          currency: balance.currency,
          totalCash: 0,
          totalMarketValue: 0,
          totalEquity: 0
        });
      }
      
      const currData = personData.currencies.get(balance.currency);
      currData.totalCash += balance.cash || 0;
      currData.totalMarketValue += balance.marketValue || 0;
      currData.totalEquity += balance.totalEquity || 0;
      
      personData.totalCash += balance.cash || 0;
      personData.totalMarketValue += balance.marketValue || 0;
      personData.totalEquity += balance.totalEquity || 0;
    });
    
    // Convert to array format
    return Array.from(personGroups.values()).map(person => ({
      personName: person.personName,
      accounts: Array.from(person.accounts.values()),
      currencies: Array.from(person.currencies.values()),
      accountCount: person.accounts.size,
      totalCash: person.totalCash,
      totalMarketValue: person.totalMarketValue,
      totalEquity: person.totalEquity
    }));
  }

  /**
   * Get account dropdown options for UI
   */
  async getAccountDropdownOptions() {
    try {
      const accounts = await this.dbManager.getAccounts();
      const persons = [...new Set(accounts.map(a => a.personName).filter(p => p))];
      
      const options = {
        viewModes: [
          { value: 'all', label: 'All Accounts' },
          { value: 'account', label: 'By Account' },
          { value: 'person', label: 'By Person' },
          { value: 'type', label: 'By Type' }
        ],
        accounts: accounts.map(a => ({
          value: a.accountId,
          label: `${a.accountName || a.accountId} (${a.accountType})`,
          personName: a.personName
        })),
        persons: persons.map(p => ({
          value: p,
          label: p
        }))
      };
      
      return options;
    } catch (error) {
      logger.error('Error getting account dropdown options:', error);
      throw error;
    }
  }
}

module.exports = AccountAggregator;