const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000/api';

// Replace these placeholder values with real ones as needed
const placeholder = {
  accountId: '40058790',
  symbol: 'RY.TO',
  symbols: 'RY.TO,TD.TO',
  refreshToken: 'sBPZVcmNB6udi8zcwT8uqIgm2jAkFdvI0',
  startDate: '2024-01-01',
  endDate: '2024-12-31',
};

async function main() {
  const endpoints = [
    { method: 'post', url: '/auth/refresh-token' },
    { method: 'get', url: '/auth/token-status' },
    {
      method: 'post',
      url: '/auth/update-refresh-token',
      data: { token: placeholder.refreshToken },
    },
    { method: 'get', url: '/accounts/' },
    {
      method: 'post',
      url: '/accounts/',
      data: { number: '123456', type: 'TFSA' },
    },
    { method: 'get', url: `/market/quote/${placeholder.symbols}` },
    { method: 'get', url: `/market/symbols/${placeholder.symbols}` },
    {
      method: 'get',
      url: `/market/candles/${placeholder.symbol}`,
      params: {
        startTime: placeholder.startDate,
        endTime: placeholder.endDate,
      },
    },
    {
      method: 'get',
      url: '/portfolio/summary',
      params: { accountId: placeholder.accountId },
    },
    {
      method: 'get',
      url: '/portfolio/positions',
      params: { accountId: placeholder.accountId },
    },
    {
      method: 'get',
      url: `/portfolio/positions/${placeholder.symbol}`,
      params: { accountId: placeholder.accountId },
    },
    {
      method: 'get',
      url: '/portfolio/dividends/calendar',
      params: {
        accountId: placeholder.accountId,
        startDate: placeholder.startDate,
        endDate: placeholder.endDate,
      },
    },
    {
      method: 'get',
      url: '/portfolio/snapshots',
      params: {
        accountId: placeholder.accountId,
        startDate: placeholder.startDate,
        endDate: placeholder.endDate,
        limit: 5,
      },
    },
    {
      method: 'post',
      url: '/portfolio/sync',
      data: { accountId: placeholder.accountId, fullSync: false },
    },
  ];

  for (const ep of endpoints) {
    const url = `${BASE_URL}${ep.url}`;
    try {
      const response = await axios({
        method: ep.method,
        url,
        data: ep.data,
        params: ep.params,
      });
      console.log(`${ep.method.toUpperCase()} ${url} -> ${response.status}`);
    } catch (error) {
      if (error.response) {
        console.log(`${ep.method.toUpperCase()} ${url} -> ${error.response.status}`);
      } else {
        const err = error.code || error.message;
        console.log(`${ep.method.toUpperCase()} ${url} -> ERROR: ${err}`);
      }
    }
  }
}

main();