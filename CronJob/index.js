const sdk = require('node-appwrite');

module.exports = async function (req, res) {
  // Initialize Appwrite client
  const client = new sdk.Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT) // Your API Endpoint
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY); // Server API key

  const users = new sdk.Users(client);

  try {
    // Add timeout protection
    const startTime = Date.now();
    const TIMEOUT_THRESHOLD = 14 * 60 * 1000 + 30; // 14 minutes 30 seconds

    let offset = 0;
    const limit = 100; // Max users per API call
    let hasMore = true;
    let updatedCount = 0;
    let errorCount = 0;

    console.log('Starting daily user preferences update...');

    while (hasMore) {
      // Fetch batch of users
      const usersList = await users.list([
        sdk.Query.limit(limit),
        sdk.Query.offset(offset)
      ]);

      // Process each user in current batch
      for (const user of usersList.users) {
        try {
          // Get existing preferences (preserve them)
          const existingPrefs = user.prefs || {};
          
          // Determine new usage values based on labels
          let usageValues;
          
          const isAdmin = user.labels && 
                          Array.isArray(user.labels) && 
                          user.labels.includes('admin');
          
          if (isAdmin) {
            // Admin users get unlimited uses
            usageValues = {
              basic_uses: 999,
              pro_uses: 999,
              ultra_uses: 999
            };
          } else {
            // Regular users get standard limits
            usageValues = {
              basic_uses: 10,
              pro_uses: 5,
              ultra_uses: 3
            };
          }

          // Merge with existing preferences (preserves other settings)
          const updatedPreferences = {
            ...existingPrefs,  // Keep all existing preferences
            ...usageValues     // Override only usage values
          };

          // Update user preferences
          await users.updatePrefs(
            user.$id,           // userId
            updatedPreferences  // prefs
          );

          updatedCount++;
          
          // Add progress tracking
          const progressInterval = Math.max(1, Math.floor(updatedCount / 10));
          if (updatedCount % progressInterval === 0) {
            console.log(`Progress: ${updatedCount} users processed...`);
          }
          
        } catch (userError) {
          errorCount++;
          console.error(`✗ Failed to update user ${user.$id}:`, userError.message);
          // Continue with next user even if one fails
        }
      }

      // Check for timeout
      if (Date.now() - startTime > TIMEOUT_THRESHOLD) {
        console.log('Function approaching timeout, stopping gracefully...');
        break;
      }

      // Check if there are more users
      if (usersList.users.length < limit) {
        hasMore = false;
      } else {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
        offset += limit;
      }
    }

    // Final summary
    const summary = {
      success: true,
      message: 'Daily preferences update completed',
      totalUpdated: updatedCount,
      errors: errorCount,
      timestamp: new Date().toISOString()
    };

    console.log('Update complete:', summary);
    return res.json(summary);

  } catch (error) {
    console.error('Critical error in preferences update:', error);
    return res.json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }, 500);
  }
};