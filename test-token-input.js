// test-token-input.js - Test the fixed token input functionality
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Fixed secure password input function
function questionHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    
    let input = '';
    let isComplete = false;
    
    // Remove any existing listeners to avoid conflicts
    const originalListeners = process.stdin.listeners('data');
    process.stdin.removeAllListeners('data');
    
    function dataHandler(char) {
      if (isComplete) return;
      
      char = char.toString();
      
      switch (char) {
        case '\n':
        case '\r':
        case '\u0004': // Ctrl+D
          isComplete = true;
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', dataHandler);
          
          // Restore original listeners
          originalListeners.forEach(listener => {
            process.stdin.on('data', listener);
          });
          
          process.stdout.write('\n');
          resolve(input.trim()); // Trim any whitespace
          break;
          
        case '\u0003': // Ctrl+C
          process.exit();
          break;
          
        case '\u007f': // Backspace
        case '\b': // Alternative backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b'); // Move back, write space, move back again
          }
          break;
          
        default:
          // Only add printable ASCII characters
          if (char >= ' ' && char <= '~') {
            input += char;
            process.stdout.write('*');
          }
          // Ignore other control characters
          break;
      }
    }
    
    process.stdin.on('data', dataHandler);
  });
}

// Regular question function
function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function testTokenInput() {
  console.log('🧪 Testing Token Input Functionality');
  console.log('====================================\n');
  
  console.log('This script will test the fixed token input to ensure no extra characters are added.\n');
  
  try {
    // Test 1: Regular input
    console.log('Test 1: Regular visible input');
    const regularInput = await question('Enter some text (visible): ');
    console.log(`You entered: "${regularInput}"`);
    console.log(`Length: ${regularInput.length} characters\n`);
    
    // Test 2: Hidden input
    console.log('Test 2: Hidden input (like token entry)');
    console.log('Type some text and press Enter. Each character will show as *');
    console.log('Use backspace to delete characters if needed.');
    const hiddenInput = await questionHidden('Enter text (hidden): ');
    console.log(`You entered: "${hiddenInput}"`);
    console.log(`Length: ${hiddenInput.length} characters\n`);
    
    // Test 3: Token-like input
    console.log('Test 3: Token simulation');
    console.log('Try entering a fake token like: ABC123xyz789');
    const tokenInput = await questionHidden('Enter fake token (hidden): ');
    console.log(`Token received: "${tokenInput}"`);
    console.log(`Token length: ${tokenInput.length} characters`);
    
    // Validate the token doesn't have extra characters
    if (tokenInput.includes('*')) {
      console.log('❌ ERROR: Token contains asterisk characters - input function is broken!');
    } else {
      console.log('✅ SUCCESS: Token input is clean (no asterisks)');
    }
    
    // Check for common issues
    if (tokenInput.trim() !== tokenInput) {
      console.log('⚠️  WARNING: Token has leading/trailing whitespace (will be trimmed)');
      console.log(`Trimmed token: "${tokenInput.trim()}"`);
    }
    
    console.log('\n🎯 Test Results:');
    console.log('- Regular input:', regularInput === '' ? 'Empty' : 'OK');
    console.log('- Hidden input:', hiddenInput === '' ? 'Empty' : 'OK');
    console.log('- Token input:', tokenInput === '' ? 'Empty' : 'OK');
    console.log('- No asterisks in token:', !tokenInput.includes('*') ? 'PASS' : 'FAIL');
    
    if (!tokenInput.includes('*') && tokenInput.length > 0) {
      console.log('\n✅ Token input is working correctly!');
      console.log('You can now use the fixed setup script with confidence.');
    } else {
      console.log('\n❌ Token input has issues. Please check the implementation.');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    rl.close();
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log('\n⏹️  Test interrupted by user');
  rl.close();
  process.exit(0);
});

// Run the test
if (require.main === module) {
  testTokenInput();
}

module.exports = { questionHidden, question };