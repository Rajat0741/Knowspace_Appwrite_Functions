import { Client, Users, Query } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  // Validate environment variables
  if (!process.env.APPWRITE_FUNCTION_ENDPOINT) {
    return res.json({ 
      error: 'Missing configuration',
      message: 'APPWRITE_FUNCTION_ENDPOINT is not set'
    }, 500);
  }

  if (!process.env.APPWRITE_FUNCTION_PROJECT_ID) {
    return res.json({ 
      error: 'Missing configuration', 
      message: 'APPWRITE_FUNCTION_PROJECT_ID is not set'
    }, 500);
  }

  if (!process.env.APPWRITE_FUNCTION_API_KEY) {
    return res.json({ 
      error: 'Missing configuration',
      message: 'APPWRITE_FUNCTION_API_KEY is not set'
    }, 500);
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_FUNCTION_API_KEY);

  const users = new Users(client);

  try {
    // Validate request method
    if (req.method !== 'POST') {
      return res.json({ 
        error: 'Method not allowed. Use POST.' 
      }, 405);
    }

    // Validate and parse request body
    let requestBody;
    try {
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      return res.json({ 
        error: 'Invalid JSON in request body' 
      }, 400);
    }

    const { userId, includePreferences = true, includeMetadata = false } = requestBody;
    console.log(requestBody)
    // Enhanced validation
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      return res.json({ 
        error: 'userId parameter is required and must be a non-empty string' 
      }, 400);
    }

    const sanitizedUserId = userId.trim();

    console.console.log(`Searching for user with ID containing: ${sanitizedUserId}`);

    // Build query to search for user ID using contains - pass queries as array directly
    let queries = [
      Query.contains('$id', sanitizedUserId),
      Query.limit(1) // Only return first match
    ];

    // Search users from Appwrite
    const userList = await users.list(queries);

    // Check if user found
    if (!userList.users || userList.users.length === 0) {
      return res.json({ 
        error: 'User not found',
        message: 'No user exists with the provided ID'
      }, 404);
    }

    const user = userList.users[0]; // Get first match

    // Enhanced data sanitization with null safety
    const sanitizedUser = {
      $id: user.$id || '',
      name: user.name || '',
      email: user.email || '',
      phone: user.phone || '',
      registration: user.registration || '',
      status: user.status !== undefined ? user.status : true,
      passwordUpdate: user.passwordUpdate || '',
      emailVerification: user.emailVerification || false,
      phoneVerification: user.phoneVerification || false,
      labels: user.labels || [],
    };

    // Conditionally include preferences
    if (includePreferences && user.prefs) {
      sanitizedUser.preferences = {
        bio: user.prefs.bio || '',
        profilePictureId: user.prefs.profilePictureId || '',
        theme: user.prefs.theme || 'light',
        language: user.prefs.language || 'en',
        ...user.prefs
      };
    }

    // Conditionally include metadata (timestamps, etc.)
    if (includeMetadata) {
      sanitizedUser.metadata = {
        $createdAt: user.$createdAt || '',
        $updatedAt: user.$updatedAt || '',
        accessedAt: user.accessedAt || ''
      };
    }

    console.log(`Successfully retrieved user data for: ${sanitizedUser.name || 'Unknown'}`);

    return res.json({
      success: true,
      user: sanitizedUser,
      retrieved: new Date().toISOString()
    });

  } catch (err) {
    // Enhanced error logging
    error(`Function execution failed: ${err.message}`, {
      stack: err.stack,
      code: err.code,
      type: err.type
    });

    // Handle specific error types
    if (err.code === 401) {
      console.log("Unathorized access");
      return res.json({ 
        error: 'Unauthorized access',
        message: 'Invalid API key or insufficient permissions'
      }, 401);
    }

    if (err.code === 404) {
      console.log("User not found");
      return res.json({ 
        error: 'User not found',
        message: 'No user exists with the provided ID'
      }, 404);
    }

    if (err.code === 429) {
      console.log("Rate limit exceeded");
      return res.json({ 
        error: 'Rate limit exceeded',
        message: 'Too many requests. Please try again later.'
      }, 429);
    }

    if (err.code === 400) {
      console.log("Invalid user ID format or parameter");
      return res.json({ 
        error: 'Bad request',
        message: 'Invalid user ID format or parameter'
      }, 400);
    }

    if (err.message && err.message.includes('fulltext index')) {
      console.log("Search index not configured");
      return res.json({ 
        error: 'Search index not configured',
        message: 'Fulltext index required for search operations. Using alternative query methods.'
      }, 400);
    }

    // Generic error response
    return res.json({ 
      error: 'Failed to fetch user',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    }, 500);
  }
};
