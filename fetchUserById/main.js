import { Client, Users } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
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

    // Enhanced validation
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      return res.json({ 
        error: 'userId parameter is required and must be a non-empty string' 
      }, 400);
    }

    const sanitizedUserId = userId.trim();

    // Validate user ID format (basic check for Appwrite ID format)
    if (sanitizedUserId.length < 20 || !/^[a-zA-Z0-9]+$/.test(sanitizedUserId)) {
      return res.json({ 
        error: 'Invalid user ID format' 
      }, 400);
    }

    log(`Fetching user data for ID: ${sanitizedUserId}`);

    // Fetch user from Appwrite
    const user = await users.get(sanitizedUserId);

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

    log(`Successfully retrieved user data for: ${sanitizedUser.name || 'Unknown'}`);

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
      return res.json({ 
        error: 'Unauthorized access',
        message: 'Invalid API key or insufficient permissions'
      }, 401);
    }

    if (err.code === 404) {
      return res.json({ 
        error: 'User not found',
        message: 'No user exists with the provided ID'
      }, 404);
    }

    if (err.code === 429) {
      return res.json({ 
        error: 'Rate limit exceeded',
        message: 'Too many requests. Please try again later.'
      }, 429);
    }

    if (err.code === 400) {
      return res.json({ 
        error: 'Bad request',
        message: 'Invalid user ID format or parameter'
      }, 400);
    }

    // Generic error response
    return res.json({ 
      error: 'Failed to fetch user',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    }, 500);
  }
};
