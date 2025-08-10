// middleware/errorHandler.js
const logger = require('../utils/logger');

// Token-specific error codes
const TOKEN_ERRORS = {
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_INVALID: 'TOKEN_INVALID', 
  TOKEN_MISSING: 'TOKEN_MISSING',
  API_CONNECTION_FAILED: 'API_CONNECTION_FAILED',
  PERSON_NOT_FOUND: 'PERSON_NOT_FOUND',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  QUESTRADE_API_ERROR: 'QUESTRADE_API_ERROR'
};

// Map common error patterns to token error codes
function mapToTokenError(error) {
  const message = error.message.toLowerCase();
  
  if (message.includes('expired') && message.includes('token')) {
    return TOKEN_ERRORS.TOKEN_EXPIRED;
  }
  if (message.includes('invalid') && message.includes('token')) {
    return TOKEN_ERRORS.TOKEN_INVALID;
  }
  if (message.includes('no active refresh token')) {
    return TOKEN_ERRORS.TOKEN_MISSING;
  }
  if (message.includes('person') && message.includes('not found')) {
    return TOKEN_ERRORS.PERSON_NOT_FOUND;
  }
  if (message.includes('questrade api error')) {
    return TOKEN_ERRORS.QUESTRADE_API_ERROR;
  }
  if (message.includes('connection') || message.includes('network')) {
    return TOKEN_ERRORS.API_CONNECTION_FAILED;
  }
  
  return null;
}

// Get user-friendly error message
function getUserFriendlyMessage(errorCode, originalMessage) {
  switch (errorCode) {
    case TOKEN_ERRORS.TOKEN_EXPIRED:
      return 'Your access token has expired. The system will automatically refresh it on the next request.';
    case TOKEN_ERRORS.TOKEN_INVALID:
      return 'Your authentication token is invalid. Please update your refresh token in the Settings tab.';
    case TOKEN_ERRORS.TOKEN_MISSING:
      return 'No valid authentication token found. Please add your Questrade refresh token in the Settings tab.';
    case TOKEN_ERRORS.PERSON_NOT_FOUND:
      return 'Person not found. Please check the person name or add them in the Settings tab.';
    case TOKEN_ERRORS.API_CONNECTION_FAILED:
      return 'Unable to connect to Questrade API. Please check your internet connection and try again.';
    case TOKEN_ERRORS.REFRESH_TOKEN_EXPIRED:
      return 'Your refresh token has expired. Please get a new refresh token from Questrade and update it in Settings.';
    case TOKEN_ERRORS.QUESTRADE_API_ERROR:
      return 'Questrade API returned an error. Please try again or check your account status.';
    default:
      return originalMessage || 'An unexpected error occurred. Please try again.';
  }
}

// Get recovery suggestions
function getRecoverySuggestions(errorCode) {
  switch (errorCode) {
    case TOKEN_ERRORS.TOKEN_EXPIRED:
      return [
        'The system will automatically refresh your token',
        'If this persists, check your refresh token in Settings'
      ];
    case TOKEN_ERRORS.TOKEN_INVALID:
    case TOKEN_ERRORS.TOKEN_MISSING:
      return [
        'Go to Settings → Token Management',
        'Add or update your Questrade refresh token',
        'Get a new refresh token from Questrade if needed'
      ];
    case TOKEN_ERRORS.PERSON_NOT_FOUND:
      return [
        'Go to Settings → Person Management',
        'Add the person with their refresh token',
        'Ensure the person name is spelled correctly'
      ];
    case TOKEN_ERRORS.API_CONNECTION_FAILED:
      return [
        'Check your internet connection',
        'Verify Questrade services are operational',
        'Try again in a few minutes'
      ];
    case TOKEN_ERRORS.REFRESH_TOKEN_EXPIRED:
      return [
        'Log into your Questrade account',
        'Go to API Centre → Personal Apps',
        'Generate a new manual refresh token',
        'Update the token in Settings'
      ];
    default:
      return [
        'Try refreshing the page',
        'Check the Settings tab for any token issues',
        'Contact support if the problem persists'
      ];
  }
}

// Enhanced error handler middleware
const errorHandler = (err, req, res, next) => {
  logger.error('API Error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    personName: req.query.personName || req.body.personName,
    timestamp: new Date()
  });

  // Map to token error if applicable
  const tokenErrorCode = mapToTokenError(err);
  
  // Default error response
  let statusCode = err.statusCode || 500;
  let errorResponse = {
    success: false,
    error: err.message || 'Internal server error',
    timestamp: new Date()
  };

  // Enhanced response for token-related errors
  if (tokenErrorCode) {
    errorResponse = {
      ...errorResponse,
      errorCode: tokenErrorCode,
      userMessage: getUserFriendlyMessage(tokenErrorCode, err.message),
      recoverySuggestions: getRecoverySuggestions(tokenErrorCode),
      tokenRelated: true
    };
    
    // Set appropriate status codes for token errors
    switch (tokenErrorCode) {
      case TOKEN_ERRORS.TOKEN_EXPIRED:
      case TOKEN_ERRORS.TOKEN_INVALID:
      case TOKEN_ERRORS.TOKEN_MISSING:
        statusCode = 401;
        break;
      case TOKEN_ERRORS.PERSON_NOT_FOUND:
        statusCode = 404;
        break;
      case TOKEN_ERRORS.API_CONNECTION_FAILED:
        statusCode = 503;
        break;
      default:
        statusCode = 400;
    }
  }

  // Handle validation errors
  if (err.name === 'ValidationError') {
    statusCode = 400;
    errorResponse.error = 'Validation failed';
    errorResponse.details = Object.values(err.errors).map(e => e.message);
  }

  // Handle MongoDB errors
  if (err.name === 'MongoError' || err.name === 'MongooseError') {
    statusCode = 500;
    errorResponse.error = 'Database error';
    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = err.message;
    }
  }

  // Handle Axios errors (API calls)
  if (err.response && err.response.data) {
    statusCode = err.response.status;
    errorResponse.error = err.response.data.message || err.response.statusText;
    if (err.response.data.error_description) {
      errorResponse.details = err.response.data.error_description;
    }
  }

  // Don't expose sensitive information in production
  if (process.env.NODE_ENV === 'production') {
    delete errorResponse.stack;
    if (!tokenErrorCode && statusCode === 500) {
      errorResponse.error = 'Internal server error';
    }
  } else {
    errorResponse.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
};

// Async error wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Not found middleware
const notFound = (req, res, next) => {
  const error = new Error(`Not Found - ${req.originalUrl}`);
  error.statusCode = 404;
  next(error);
};

module.exports = {
  errorHandler,
  asyncHandler,
  notFound,
  TOKEN_ERRORS
};