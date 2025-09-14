import { Client, Users, Query } from 'node-appwrite';

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

    const { name, limit = 25, offset = 0 } = requestBody;
    
    // Enhanced validation
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.json({ 
        error: 'Name parameter is required and must be a non-empty string' 
      }, 400);
    }

    // Sanitize and validate pagination parameters
    const sanitizedLimit = Math.min(Math.max(parseInt(limit) || 25, 1), 100); // Cap at 100
    const sanitizedOffset = Math.max(parseInt(offset) || 0, 0);
    const sanitizedName = name.trim();

    // Validate name length (prevent overly broad searches)
    if (sanitizedName.length < 2) {
      return res.json({ 
        error: 'Name must be at least 2 characters long' 
      }, 400);
    }

    log(`Searching for users with name: "${sanitizedName}", limit: ${sanitizedLimit}, offset: ${sanitizedOffset}`);

    // Build queries for searching by name
    const queries = [
      Query.search('name', sanitizedName),
      Query.limit(sanitizedLimit),
      Query.offset(sanitizedOffset)
    ];

    // Fetch users from Appwrite
    const response = await users.list(queries);
    
    // Enhanced data sanitization with null safety
    const sanitizedUsers = response.users.map(user => ({
      $id: user.$id || '',
      name: user.name || '',
      bio: user.prefs?.bio || '',
      registration: user.registration || '',
      // Add avatar if available (common use case)
      profilePictureId: user.prefs.profilePictureId || '',
      // Explicitly exclude sensitive fields for clarity
    }));

    const totalUsers = response.total || 0;
    const nextOffset = sanitizedOffset + sanitizedUsers.length;
    const hasMore = nextOffset < totalUsers;

    log(`Found ${sanitizedUsers.length} users out of ${totalUsers} total`);

    return res.json({
      success: true,
      users: sanitizedUsers,
      pagination: {
        total: totalUsers,
        limit: sanitizedLimit,
        offset: sanitizedOffset,
        hasMore,
        nextOffset: hasMore ? nextOffset : null,
        page: Math.floor(sanitizedOffset / sanitizedLimit) + 1,
        totalPages: Math.ceil(totalUsers / sanitizedLimit)
      }
    });

  } catch (err) {
    // Enhanced error logging
    error(`Function execution failed: ${err.message}`, {
      stack: err.stack,
      code: err.code,
      type: err.type
    });

    // Different error responses based on error type
    if (err.code === 401) {
      return res.json({ 
        error: 'Unauthorized access',
        message: 'Invalid API key or insufficient permissions'
      }, 401);
    }

    if (err.code === 429) {
      return res.json({ 
        error: 'Rate limit exceeded',
        message: 'Too many requests. Please try again later.'
      }, 429);
    }

    // Generic error response (don't expose internal details)
    return res.json({ 
      error: 'Failed to fetch users',
      message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error'
    }, 500);
  }
};
