import { Client, Users } from 'node-appwrite';

export default async ({ req, res, log, error }) => {
  // Basic logging
  log('Function started');
  log(`Request method: ${req.method}`);

  // Check environment variables
  const endpoint = process.env.APPWRITE_FUNCTION_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const apiKey = process.env.APPWRITE_FUNCTION_API_KEY;

  if (!endpoint || !projectId || !apiKey) {
    error('Missing required environment variables');
    return res.json({ 
      error: 'Configuration error',
      message: 'Missing required environment variables'
    }, 500);
  }

  // Initialize client
  let client;
  let users;
  
  try {
    client = new Client()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);
    
    users = new Users(client);
    log('Appwrite client initialized');
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
      return res.json({ 
        error: 'Method not allowed',
        message: 'Use POST method'
      }, 405);
    }

    // Parse request body
    let requestBody;
    try {
      requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (parseError) {
      return res.json({ 
        error: 'Invalid JSON',
        message: parseError.message
      }, 400);
    }

    // Get userId
    const { userId } = requestBody || {};
    
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.json({ 
        error: 'Invalid request',
        message: 'Valid userId is required'
      }, 400);
    }

    // Fetch user
    let user;
    try {
      user = await users.get(userId.trim());
      log('User fetched successfully');
    } catch (fetchError) {
      if (fetchError.code === 404) {
        return res.json({ 
          error: 'User not found',
          message: 'No user exists with the provided ID'
        }, 404);
      }
      
      if (fetchError.code === 401) {
        return res.json({ 
          error: 'Unauthorized',
          message: 'Invalid API key or insufficient permissions'
        }, 401);
      }
      
      throw fetchError;
    }

    // Return ONLY non-sensitive data
    const publicUserData = {
      $id: user.$id,
      name: user.name || 'Anonymous User',
      bio: user.prefs?.bio || null,
      profilePictureId: user.prefs?.profilePicture || null,
      registrationDate: user.$createdAt || null
    };

    return res.json({
      success: true,
      user: publicUserData,
      retrieved: new Date().toISOString()
    });

  } catch (err) {
    error('Unhandled error occurred');
    return res.json({ 
      error: 'Internal server error',
      message: 'An error occurred while processing your request'
    }, 500);
  }
};
