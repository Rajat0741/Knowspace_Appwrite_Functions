import { Client, Users } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  // Start with immediate logging to confirm function is running
  try {
    log('Function started');
    log(`Request method: ${req.method}`);
    log(`Request body type: ${typeof req.body}`);
    log(`Request body: ${JSON.stringify(req.body)}`);
  } catch (e) {
    return res.json({ 
      error: 'Logging failed',
      message: e.message
    }, 500);
  }

  // Check environment variables with detailed logging
  const endpoint = process.env.APPWRITE_FUNCTION_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const apiKey = process.env.APPWRITE_FUNCTION_API_KEY;

  log(`Endpoint exists: ${!!endpoint}`);
  log(`Project ID exists: ${!!projectId}`);
  log(`API Key exists: ${!!apiKey}`);

  if (!endpoint) {
    error('Missing APPWRITE_FUNCTION_ENDPOINT');
    return res.json({ 
      error: 'Missing configuration',
      message: 'APPWRITE_FUNCTION_ENDPOINT is not set'
    }, 500);
  }

  if (!projectId) {
    error('Missing APPWRITE_FUNCTION_PROJECT_ID');
    return res.json({ 
      error: 'Missing configuration', 
      message: 'APPWRITE_FUNCTION_PROJECT_ID is not set'
    }, 500);
  }

  if (!apiKey) {
    error('Missing APPWRITE_FUNCTION_API_KEY');
    return res.json({ 
      error: 'Missing configuration',
      message: 'APPWRITE_FUNCTION_API_KEY is not set'
    }, 500);
  }

  log('Environment variables validated');

  // Initialize client with error handling
  let client;
  let users;
  
  try {
    log('Initializing Appwrite client');
    client = new Client()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);
    
    users = new Users(client);
    log('Appwrite client initialized successfully');
  } catch (e) {
    error(`Failed to initialize client: ${e.message}`);
    return res.json({ 
      error: 'Client initialization failed',
      message: e.message
    }, 500);
  }

  try {
    // Validate request method
    if (req.method !== 'POST') {
      log(`Invalid method: ${req.method}`);
      return res.json({ 
        error: 'Method not allowed',
        message: `Use POST method. Received: ${req.method}`
      }, 405);
    }

    // Parse request body with detailed error handling
    let requestBody;
    try {
      if (typeof req.body === 'string') {
        log('Parsing string body');
        requestBody = JSON.parse(req.body);
      } else {
        log('Body is already an object');
        requestBody = req.body;
      }
      log(`Parsed body: ${JSON.stringify(requestBody)}`);
    } catch (parseError) {
      error(`JSON parse error: ${parseError.message}`);
      return res.json({ 
        error: 'Invalid JSON in request body',
        message: parseError.message
      }, 400);
    }

    // Extract parameters with logging
    const { userId, includePreferences = true, includeMetadata = false } = requestBody || {};
    
    log(`UserId: ${userId}`);
    log(`Include preferences: ${includePreferences}`);
    log(`Include metadata: ${includeMetadata}`);
    
    // Validate userId
    if (!userId) {
      log('UserId is missing');
      return res.json({ 
        error: 'Missing required parameter',
        message: 'userId is required'
      }, 400);
    }

    if (typeof userId !== 'string') {
      log(`UserId is not a string: ${typeof userId}`);
      return res.json({ 
        error: 'Invalid parameter type',
        message: `userId must be a string, received ${typeof userId}`
      }, 400);
    }

    const sanitizedUserId = userId.trim();
    
    if (sanitizedUserId.length === 0) {
      log('UserId is empty after trimming');
      return res.json({ 
        error: 'Invalid parameter',
        message: 'userId cannot be empty'
      }, 400);
    }

    log(`Attempting to fetch user with ID: ${sanitizedUserId}`);

    // Fetch user with detailed error catching
    let user;
    try {
      user = await users.get(sanitizedUserId);
      log(`User fetched successfully: ${user.$id}`);
    } catch (fetchError) {
      error(`User fetch failed: ${fetchError.message}`);
      error(`Error code: ${fetchError.code}`);
      error(`Error type: ${fetchError.type}`);
      
      // Handle specific Appwrite errors
      if (fetchError.code === 404) {
        return res.json({ 
          error: 'User not found',
          message: `No user exists with ID: ${sanitizedUserId}`
        }, 404);
      }
      
      if (fetchError.code === 401) {
        return res.json({ 
          error: 'Unauthorized',
          message: 'Invalid API key or insufficient permissions'
        }, 401);
      }
      
      throw fetchError; // Re-throw for general error handler
    }

    // Build response
    log('Building sanitized response');
    
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

    // Add preferences if requested
    if (includePreferences && user.prefs) {
      sanitizedUser.preferences = user.prefs;
      log('Preferences included');
    }

    // Add metadata if requested
    if (includeMetadata) {
      sanitizedUser.metadata = {
        $createdAt: user.$createdAt || '',
        $updatedAt: user.$updatedAt || '',
        accessedAt: user.accessedAt || ''
      };
      log('Metadata included');
    }

    log('Returning success response');

    return res.json({
      success: true,
      user: sanitizedUser,
      retrieved: new Date().toISOString()
    });

  } catch (err) {
    error(`Unhandled error: ${err.message}`);
    error(`Stack: ${err.stack}`);
    
    return res.json({ 
      error: 'Internal server error',
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    }, 500);
  }
};
