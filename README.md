/*
# Questrade Portfolio Tracker

A comprehensive Node.js application for tracking your Questrade portfolio with automatic token refresh, 
real-time data sync, and detailed dividend tracking.

## Features

- 🔐 Automatic token refresh (weekly)
- 📊 Real-time portfolio data sync
- 💰 Detailed dividend tracking and analysis
- 📈 Portfolio performance metrics
- 🎯 Snap quote integration for current prices
- 📅 Historical snapshots
- 🔄 Automatic data synchronization during market hours

## Prerequisites

- Node.js v14 or higher
- MongoDB v4.4 or higher
- Questrade account with API access enabled

## Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with your configuration:
   ```
   MONGODB_URI=mongodb://localhost:27017/questrade_portfolio
   PORT=3000
   NODE_ENV=development
   QUESTRADE_AUTH_URL=https://login.questrade.com
   JWT_SECRET=your_jwt_secret_key_here
   ENCRYPTION_KEY=your_32_character_encryption_key
   ```

4. Get your Questrade refresh token:
   - Log into Questrade
   - Go to API Centre
   - Create a personal app
   - Generate a manual refresh token

5. Run the setup script:
   ```bash
   npm run setup
   ```
   Enter your refresh token when prompted.

## Usage

### Start the server:
```bash
npm start
```

### Development mode (with auto-reload):
```bash
npm run dev
```

## API Endpoints

### Authentication
- `POST /api/auth/refresh-token` - Manually refresh the access token
- `GET /api/auth/token-status` - Check token status
- `POST /api/auth/update-refresh-token` - Update refresh token manually

### Portfolio
- `GET /api/portfolio/summary` - Get complete portfolio summary with calculations
- `GET /api/portfolio/positions` - Get all positions
- `GET /api/portfolio/positions/:symbol` - Get specific position details
- `GET /api/portfolio/dividends/calendar` - Get dividend calendar
- `GET /api/portfolio/snapshots` - Get historical portfolio snapshots
- `POST /api/portfolio/sync` - Manually trigger data sync

### Market Data
- `GET /api/market/quote/:symbols` - Get snap quotes (real-time prices)
- `GET /api/market/symbols/:symbols` - Get symbol information
- `GET /api/market/candles/:symbol` - Get historical price data

### Accounts
- `GET /api/accounts` - List all accounts
- `POST /api/accounts` - Create a new account


## Data Models

### Token
- Stores encrypted refresh and access tokens
- Automatic encryption/decryption
- Expiry tracking

### Account
- Account details and balances
- Multi-currency support

### Position
- Current holdings
- Cost basis and P&L
- Dividend metrics
- Market data cache

### Symbol
- Security information
- Dividend data
- Market metrics

### Activity
- Transaction history
- Dividend payments
- Trade executions

### MarketQuote
- Real-time quotes
- Snap quote tracking
- Auto-cleanup after 7 days

### PortfolioSnapshot
- Daily portfolio values
- Historical tracking
- Performance metrics

## Automatic Jobs

1. **Token Refresh**: Every 6 days
2. **Data Sync**: Every hour during market hours (9:30 AM - 4:00 PM ET)
3. **Daily Snapshot**: At market close (4:30 PM ET)

## Portfolio Metrics Calculated

- Total investment and current value
- Unrealized and realized P&L
- Total return (capital gains + dividends)
- Yield on cost
- Current yield
- Dividend-adjusted cost
- Monthly and annual projected income
- Sector and currency allocation
- Risk metrics

## Security

- Tokens are encrypted using AES-256
- Rate limiting on API endpoints
- Helmet.js for security headers
- Environment variables for sensitive data

## Snap Quote Usage

The app uses Questrade's snap quote feature for real-time prices. 
Note: Snap quotes count against your market data limits.

## Error Handling

- Comprehensive logging with Winston
- Automatic token refresh on 401 errors
- Graceful shutdown handling
- Database connection retry logic

## Scripts

- `npm start` - Start the production server
- `npm run dev` - Start development server with nodemon
- `npm run setup` - Initial setup wizard
- `npm run refresh-token` - Manually refresh token
- `npm run sync-data` - Manually sync all data

## License
