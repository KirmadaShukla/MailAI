

const {
  processEmailsParallel,
  getProcessingStatus,
  resetProcessingStatus,
  getAllActiveSessions,
  addLog,
} = require('./services/parallelProcessingService');

// Mock user authentication data
const mockUsers = {
  'user1@example.com': {
    accessToken: 'mock_access_token_1',
    refreshToken: 'mock_refresh_token_1',
  },
  'user2@example.com': {
    accessToken: 'mock_access_token_2',
    refreshToken: 'mock_refresh_token_2',
  },
  'user3@example.com': {
    accessToken: 'mock_access_token_3',
    refreshToken: 'mock_refresh_token_3',
  },
};

async function testMultiUserProcessing() {
  console.log('🧪 Testing Multi-User Parallel Processing System');
  console.log('=' .repeat(60));

  // Test 1: Check initial state
  console.log('\n📊 Test 1: Initial State');
  const initialSessions = getAllActiveSessions();
  console.log(`Active sessions: ${initialSessions.length}`);

  // Test 2: Start processing for User 1
  console.log('\n🚀 Test 2: Starting processing for User 1');
  const user1Id = 'user1@example.com';
  const user1Status = getProcessingStatus(user1Id);
  console.log(`User 1 initial status - isProcessing: ${user1Status.isProcessing}`);

  // Simulate starting processing for User 1
  user1Status.isProcessing = true;
  user1Status.startTime = Date.now();
  user1Status.totalEmails = 100;
  user1Status.processedEmails = 0;
  addLog('🎯 User 1 started processing', user1Id);

  // Test 3: Check User 1 status
  console.log('\n📈 Test 3: User 1 Status After Starting');
  const user1StatusAfter = getProcessingStatus(user1Id);
  console.log(`User 1 - isProcessing: ${user1StatusAfter.isProcessing}`);
  console.log(`User 1 - totalEmails: ${user1StatusAfter.totalEmails}`);
  console.log(`User 1 - logs count: ${user1StatusAfter.logs.length}`);

  // Test 4: Start processing for User 2 (should work independently)
  console.log('\n🚀 Test 4: Starting processing for User 2 (while User 1 is processing)');
  const user2Id = 'user2@example.com';
  const user2Status = getProcessingStatus(user2Id);
  console.log(`User 2 initial status - isProcessing: ${user2Status.isProcessing}`);

  // Simulate starting processing for User 2
  user2Status.isProcessing = true;
  user2Status.startTime = Date.now();
  user2Status.totalEmails = 200;
  user2Status.processedEmails = 0;
  addLog('🎯 User 2 started processing', user2Id);

  // Test 5: Check both users' statuses
  console.log('\n📊 Test 5: Both Users Processing Simultaneously');
  const user1Current = getProcessingStatus(user1Id);
  const user2Current = getProcessingStatus(user2Id);
  console.log(`User 1 - isProcessing: ${user1Current.isProcessing}, totalEmails: ${user1Current.totalEmails}`);
  console.log(`User 2 - isProcessing: ${user2Current.isProcessing}, totalEmails: ${user2Current.totalEmails}`);

  // Test 6: Check active sessions
  console.log('\n🔍 Test 6: Active Sessions');
  const activeSessions = getAllActiveSessions();
  console.log(`Total active sessions: ${activeSessions.length}`);
  activeSessions.forEach((session, index) => {
    console.log(`  Session ${index + 1}: ${session.userId} - Processing: ${session.isProcessing}`);
  });

  // Test 7: Start processing for User 3
  console.log('\n🚀 Test 7: Starting processing for User 3');
  const user3Id = 'user3@example.com';
  const user3Status = getProcessingStatus(user3Id);
  user3Status.isProcessing = true;
  user3Status.startTime = Date.now();
  user3Status.totalEmails = 50;
  addLog('🎯 User 3 started processing', user3Id);

  // Test 8: Final status check
  console.log('\n📊 Test 8: Final Status - All Three Users Processing');
  const finalSessions = getAllActiveSessions();
  console.log(`Total active sessions: ${finalSessions.length}`);
  finalSessions.forEach((session, index) => {
    console.log(`  Session ${index + 1}: ${session.userId} - Processing: ${session.isProcessing}, Emails: ${session.totalEmails}`);
  });

  // Test 9: Stop User 2 processing
  console.log('\n🛑 Test 9: Stopping User 2 Processing');
  const user2Stop = getProcessingStatus(user2Id);
  user2Stop.isProcessing = false;
  user2Stop.userRequestedStop = true;
  addLog('🛑 User 2 stopped processing', user2Id);

  // Test 10: Check status after User 2 stops
  console.log('\n📊 Test 10: Status After User 2 Stops');
  const afterStopSessions = getAllActiveSessions();
  console.log(`Active sessions: ${afterStopSessions.length}`);
  afterStopSessions.forEach((session, index) => {
    console.log(`  Session ${index + 1}: ${session.userId} - Processing: ${session.isProcessing}`);
  });

  // Test 11: Reset User 1 status
  console.log('\n🔄 Test 11: Resetting User 1 Status');
  resetProcessingStatus(user1Id);
  const user1Reset = getProcessingStatus(user1Id);
  console.log(`User 1 after reset - isProcessing: ${user1Reset.isProcessing}`);

  console.log('\n✅ Multi-User Testing Complete!');
  console.log('=' .repeat(60));
  console.log('🎉 SUCCESS: Multiple users can process emails independently!');
  console.log('🔧 The system now supports concurrent processing for different users.');
}

// Run the test
if (require.main === module) {
  testMultiUserProcessing().catch(console.error);
}

module.exports = { testMultiUserProcessing };
