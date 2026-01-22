import { Client, Databases, ID, Query, Users } from 'node-appwrite';
import { GoogleGenAI, Type } from '@google/genai';

/**
 * Appwrite Function: Enhanced AI Content Generator
 */

const CONFIG = {
  MODELS: {
    basic: 'gemini-2.5-flash-lite',
    pro: 'gemini-2.5-flash',
    ultra: 'gemini-3-flash'
  },
  MAX_OUTPUT_TOKENS: {
    concise: 4000,
    moderate: 6000,
    extended: 8000
  },
  STATUS: {
    IN_PROGRESS: 'inprogress',
    COMPLETED: 'completed',
    FAILED: 'failed'
  },
  DATABASE_ID: process.env.DATABASE_ID,
  COLLECTIONS: {
    ARTICLES: process.env.ARTICLES_COLLECTION_ID,
    TRACKING: process.env.TRACKING_COLLECTION_ID
  }
};

// Initialize Appwrite SDK
const client = new Client();

try {
  client
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
} catch (initError) {
  console.error('Failed to initialize Appwrite client:', initError);
}

const databases = new Databases(client);
const users = new Users(client);

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Helper: Get usage field name for request type
function getUsageFieldForRequestType(requestType) {
  switch (requestType.toLowerCase()) {
    case 'ultra': return 'ultra_uses';
    case 'pro': return 'pro_uses';
    case 'basic': return 'basic_uses';
    default: return null;
  }
}


// Helper: Get CORS headers
function getCORSHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Appwrite-Project, X-Appwrite-Key, X-Appwrite-Response-Format'
  };
}

export default async ({ req, res, log, error }) => {
  // Handle preflight OPTIONS request for CORS
  if (req.method === 'OPTIONS') {
    log('Handling CORS preflight request');
    return res.json({}, 200, {
      ...getCORSHeaders(),
      'Access-Control-Max-Age': '86400'
    });
  }

  let trackingId = null;
  try {
    log('=== STARTING AI CONTENT GENERATION FUNCTION ===');
    log(`Request timestamp: ${new Date().toISOString()}`);
    log(`Request method: ${req.method}`);
    log(`Request headers: ${JSON.stringify(req.headers)}`);

    const requestBody = req.body || '{}';
    log(`Raw request body length: ${requestBody.length} characters`);

    const {
      prompt, title, sources = [],
      category, requestType = 'basic', style = 'moderate', trackingId
    } = JSON.parse(requestBody);

    // Get userId from headers (Appwrite standard)
    const userId = req.headers['x-appwrite-user-id'];

    log('=== PARSED REQUEST PARAMETERS ===');
    log(`User ID: ${userId}`);
    log(`Title: ${title}`);
    log(`Category: ${category}`);
    log(`Request Type: ${requestType}`);
    log(`Style: ${style}`);
    log(`Prompt length: ${prompt ? prompt.length : 0} characters`);
    log(`Sources count: ${sources.length}`);
    log(`Sources: ${JSON.stringify(sources)}`);

    // Validation
    log('=== VALIDATING REQUEST PARAMETERS ===');
    if (!userId || !prompt || !title || !category || !trackingId) {
      error('Missing required fields validation failed');
      log(`Missing fields - userId: ${!!userId}, prompt: ${!!prompt}, title: ${!!title}, category: ${!!category}, trackingId: ${!!trackingId}`);
      return res.json({ success: false, error: 'Missing required fields: userId, prompt, title, category, trackingId' }, 400, getCORSHeaders());
    }

    if (!CONFIG.MAX_OUTPUT_TOKENS[style]) {
      error(`Invalid style validation failed: ${style}`);
      return res.json({ success: false, error: 'Invalid style. Must be concise, moderate, or extended' }, 400, getCORSHeaders());
    }

    log('✓ All request parameters validated successfully');

    // 1. Check user prefs
    log('=== STEP 1: CHECKING USER PREFERENCES ===');
    const canProceed = await checkUserPreferences(userId, requestType, log, error);
    if (!canProceed.success) {
      error(`User preference check failed: ${canProceed.error}`);
      return res.json({ success: false, error: canProceed.error }, 403, getCORSHeaders());
    }
    log('✓ User preferences check passed');

    // 2. Update tracking document status to inprogress
    log('=== STEP 2: UPDATING TRACKING DOCUMENT STATUS TO INPROGRESS ===');
    await updateTrackingStatus(trackingId, CONFIG.STATUS.IN_PROGRESS, '', null, log, error);
    log(`✓ Tracking document ${trackingId} status updated to inprogress`);

    // 3. Generate content (Gemini)
    log('=== STEP 3: GENERATING CONTENT WITH GEMINI ===');
    let generatedContent = await generateArticleContent(
      prompt, title, sources, category, requestType, style, log, error
    );
    if (!generatedContent.success) {
      error(`Content generation failed: ${generatedContent.error}`);
      await setTrackingStatusToFailed(trackingId, generatedContent.error, log, error);
      return res.json({ success: false, error: generatedContent.error }, 500, getCORSHeaders());
    }
    log(`✓ Content generated successfully, length: ${generatedContent.content.length} characters`);


    // 5. Validate HTML (must contain <h2> or <p>)
    log('=== STEP 5: VALIDATING HTML CONTENT ===');
    if (!isValidHTMLContent(generatedContent.content)) {
      const validationError = 'Content validation failed: must include <h2> or <p> tags for TinyMCE compatibility';
      error(validationError);
      await setTrackingStatusToFailed(trackingId, validationError, log, error);
      return res.json({ success: false, error: validationError }, 500, getCORSHeaders());
    }
    log('✓ HTML content validation passed');

    // 6. Create article (status: inactive)
    log('=== STEP 6: CREATING ARTICLE DOCUMENT ===');
    const userDetails = await getUserDetails(userId, log, error);
    log(`Author details retrieved: ${userDetails.authorName}`);

    const articleDoc = await createArticleDocument(
      userId, title, generatedContent.content, category, sources, userDetails.authorName, log, error
    );
    if (!articleDoc.success) {
      error('Failed to create article document');
      await setTrackingStatusToFailed(trackingId, 'Failed to create article document', log, error);
      return res.json({ success: false, error: 'Failed to create article document' }, 500, getCORSHeaders());
    }
    log(`✓ Article document created with ID: ${articleDoc.documentId}`);

    // 7. update tracking (completed, clear error, link postId)
    log('=== STEP 7: UPDATING TRACKING STATUS TO COMPLETED ===');
    await updateTrackingStatus(trackingId, CONFIG.STATUS.COMPLETED, '', articleDoc.documentId, log, error);
    log('✓ Tracking status updated to completed');

    // 8. decrement quota
    log('=== STEP 8: DECREMENTING USER QUOTA ===');
    await decrementUserQuota(userId, requestType, log, error);
    log('✓ User quota decremented');

    log('=== AI CONTENT GENERATION COMPLETED SUCCESSFULLY ===');
    log(`Total execution completed at: ${new Date().toISOString()}`);

    return res.json({
      success: true,
      message: 'Article generated successfully',
      trackingId: trackingId,
      articleId: articleDoc.documentId
    }, 200, getCORSHeaders());

  } catch (err) {
    error(`=== FATAL FUNCTION ERROR ===`);
    error(`Error timestamp: ${new Date().toISOString()}`);
    error(`Error message: ${err.message}`);
    error(`Error stack: ${err.stack}`);

    if (trackingId) {
      log(`Updating tracking document ${trackingId} with error status`);
      await setTrackingStatusToFailed(trackingId, err.message, log, error);
    }

    return res.json({ success: false, error: err.message }, 500, getCORSHeaders());
  }
};

// HTML validation utility
function isValidHTMLContent(html) {
  console.log('--- HTML VALIDATION START ---');
  console.log(`Validating HTML content length: ${html ? html.length : 0} characters`);

  const hasH2 = /<h2[^>]*>.*?<\/h2>/i.test(html);
  const hasP = /<p[^>]*>.*?<\/p>/i.test(html);

  console.log(`Contains <h2> tags: ${hasH2}`);
  console.log(`Contains <p> tags: ${hasP}`);

  const isValid = hasH2 || hasP;
  console.log(`HTML validation result: ${isValid ? 'PASSED' : 'FAILED'}`);

  if (!isValid) {
    console.log('HTML validation failed - content must contain at least one <h2> or <p> tag');
    console.log(`First 500 characters of content: ${html ? html.substring(0, 500) : 'null'}...`);
  }

  console.log('--- HTML VALIDATION END ---');

  return isValid;
}


// All other helpers below (unchanged except where noted):

async function checkUserPreferences(userId, requestType, log, error) {
  try {
    log(`Checking prefs for user: ${userId}`);

    // Validate userId format
    if (!userId || typeof userId !== 'string') {
      error(`Invalid userId format: ${userId}`);
      return { success: false, error: 'Invalid user ID format.' };
    }

    let userPrefs = {};

    try {
      // Get user preferences using the correct Appwrite API
      log(`Fetching preferences for user: ${userId}`);
      userPrefs = await users.getPrefs(userId);
      log(`User preferences retrieved successfully`);
    } catch (prefsError) {
      // If user has no preferences set, create default ones
      if (prefsError.code === 404 || prefsError.message.includes('not found')) {
        log(`No preferences found for user ${userId}, using defaults`);
        userPrefs = {
          basic_uses: 0,
          pro_uses: 0,
          ultra_uses: 0
        };
      } else {
        throw prefsError; // Re-throw if it's a different error
      }
    }

    const usageField = getUsageFieldForRequestType(requestType);
    if (!usageField) {
      error(`Invalid request type: ${requestType}`);
      return { success: false, error: 'Invalid request type.' };
    }

    const remainingUses = userPrefs[usageField] || 0;
    log(`User has ${remainingUses} ${requestType} uses remaining`);

    if (remainingUses <= 0) {
      return { success: false, error: `Insufficient ${requestType} uses.` };
    }

    return { success: true };
  } catch (err) {
    error(`Preference check error: ${err.message}`);
    error(`Error details: ${JSON.stringify(err)}`);
    return { success: false, error: err.message };
  }
}

// Helper: Set tracking status to failed
async function setTrackingStatusToFailed(trackingId, errorMessage, log, error) {
  try {
    log(`Setting tracking status to failed for: ${trackingId}`);
    await updateTrackingStatus(trackingId, CONFIG.STATUS.FAILED, errorMessage, null, log, error);
    log(`✓ Tracking status set to failed`);
  } catch (statusError) {
    error(`Failed to set tracking status to failed: ${statusError.message}`);
  }
}

// Now stores error string for every status change
async function updateTrackingStatus(trackingId, status, errorMessage, postId, log, error) {
  try {
    log('--- UPDATE TRACKING STATUS START ---');
    log(`Updating tracking status for document: ${trackingId}`);
    log(`New status: ${status}`);
    log(`Error message: ${errorMessage || 'none'}`);
    log(`Post ID: ${postId || 'none'}`);

    // Ensure errorMessage is a string and truncate it to 500 chars (Appwrite limit)
    let safeErrorMessage = errorMessage || '';
    if (typeof safeErrorMessage !== 'string') {
        try {
            safeErrorMessage = JSON.stringify(safeErrorMessage);
        } catch (e) {
            safeErrorMessage = String(safeErrorMessage);
        }
    }
    
    if (safeErrorMessage.length > 500) {
        log(`Truncating error message from ${safeErrorMessage.length} to 500 chars`);
        safeErrorMessage = safeErrorMessage.substring(0, 500);
    }

    const updateData = { status, error: safeErrorMessage };
    if (postId) {
      updateData.postId = postId;
      log(`Adding postId to update: ${postId}`);
    }

    log(`Update data: ${JSON.stringify(updateData)}`);

    await databases.updateDocument(
      CONFIG.DATABASE_ID,
      CONFIG.COLLECTIONS.TRACKING,
      trackingId,
      updateData
    );

    log(`Tracking doc updated successfully: ${trackingId}`);
    log('--- UPDATE TRACKING STATUS SUCCESS ---');

  } catch (err) {
    error(`Tracking status update error: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    log('--- UPDATE TRACKING STATUS ERROR ---');
  }
}

// ... (Other helper functions remain as in your current code)
async function getUserDetails(userId, log, error) {
  try {
    log('--- GET USER DETAILS START ---');
    log(`Fetching user details for: ${userId}`);

    const user = await users.get(userId);

    log(`User retrieved successfully:`);
    log(`- User ID: ${user.$id}`);
    log(`- User name: ${user.name || 'not set'}`);
    log(`- User email: ${user.email || 'not set'}`);
    log(`- User created: ${user.$createdAt}`);

    const authorName = user.name || 'Anonymous';
    log(`Final author name: ${authorName}`);
    log('--- GET USER DETAILS SUCCESS ---');

    return { authorName };
  } catch (err) {
    error(`Author lookup error: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    log('--- GET USER DETAILS ERROR ---');
    log('Using fallback author name: Anonymous');
    return { authorName: 'Anonymous' };
  }
}

async function createArticleDocument(userId, title, content, category, sources, authorName, log, error) {
  try {
    log('--- CREATE ARTICLE DOCUMENT START ---');
    log(`Creating article document for user: ${userId}`);
    log(`Title: ${title}`);
    log(`Category: ${category}`);
    log(`Author: ${authorName}`);
    log(`Content length: ${content.length} characters`);
    log(`Sources: ${JSON.stringify(sources)}`);

    const articleData = {
      userid: userId,
      title,
      content,
      category,
      status: 'inactive',
      authorName,
      featuredimage: ''
    };

    log(`Article data prepared (excluding content for brevity):`);
    log(`- userid: ${articleData.userid}`);
    log(`- title: ${articleData.title}`);
    log(`- category: ${articleData.category}`);
    log(`- status: ${articleData.status}`);
    log(`- authorName: ${articleData.authorName}`);
    log(`- featuredimage: ${articleData.featuredimage}`);
    log(`- content length: ${articleData.content.length} characters`);

    log(`Database ID: ${CONFIG.DATABASE_ID}`);
    log(`Articles Collection ID: ${CONFIG.COLLECTIONS.ARTICLES}`);

    const document = await databases.createDocument(
      CONFIG.DATABASE_ID,
      CONFIG.COLLECTIONS.ARTICLES,
      ID.unique(),
      articleData
    );

    log(`Article document created successfully with ID: ${document.$id}`);
    log(`Document created at: ${document.$createdAt}`);
    log('--- CREATE ARTICLE DOCUMENT SUCCESS ---');

    return { success: true, documentId: document.$id };
  } catch (err) {
    error(`Article doc error: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    log('--- CREATE ARTICLE DOCUMENT ERROR ---');
    return { success: false, error: err.message };
  }
}

// ... (Gemini generation logic stays nearly identical)
async function generateArticleContent(prompt, title, sources, category, requestType, style, log, error) {
  try {
    log('--- GENERATE ARTICLE CONTENT START ---');
    log(`Generating content with Gemini AI`);
    log(`Title: ${title}`);
    log(`Category: ${category}`);
    log(`Request Type: ${requestType}`);
    log(`Style: ${style}`);
    log(`Prompt length: ${prompt.length} characters`);
    log(`Sources count: ${sources.length}`);

    const modelName = CONFIG.MODELS[requestType] || CONFIG.MODELS.basic;
    const maxTokens = CONFIG.MAX_OUTPUT_TOKENS[style] || CONFIG.MAX_OUTPUT_TOKENS.moderate;

    log(`Selected model: ${modelName}`);
    log(`Max output tokens: ${maxTokens}`);

    const systemPrompt = buildSystemPrompt(title, category, sources, style);
    log(`System prompt length: ${systemPrompt.length} characters`);

    // Configure grounding tools - Google Search for dynamic real-time information
    const tools = [
      {
        googleSearch: {} // Enable Google Search grounding for up-to-date information
      }
    ];
    log(`Tools configured: ${JSON.stringify(tools)}`);

    const completePrompt = buildCompletePrompt(systemPrompt, prompt, sources);
    log(`Complete prompt parts count: ${completePrompt.length}`);
    log(`Complete prompt total length: ${JSON.stringify(completePrompt).length} characters`);

    const requestConfig = {
      model: modelName,
      contents: completePrompt,
      config: {
        tools,
        temperature: 0.7,
        maxOutputTokens: maxTokens,
        thinkingConfig: {
          thinkingLevel: 'medium'
        }
      }
    };
    log(`Request configuration: ${JSON.stringify({ ...requestConfig, contents: '[PROMPT_DATA]' })}`);

    log('Making request to Gemini AI...');
    const response = await ai.models.generateContent(requestConfig);

    log('Gemini AI response received');
    log(`Response object keys: ${Object.keys(response).join(', ')}`);

    // Check for grounding metadata to see if Google Search was used
    if (response.candidates && response.candidates[0] && response.candidates[0].groundingMetadata) {
      log('✓ Response was grounded with Google Search');
      log(`Grounding metadata: ${JSON.stringify(response.candidates[0].groundingMetadata)}`);
    } else {
      log('ℹ Model answered from its own knowledge (no grounding used)');
    }

    const generatedText = response.text;
    log(`Generated text length: ${generatedText ? generatedText.length : 0} characters`);

    if (!generatedText || generatedText.trim().length === 0) {
      error('Generated content is empty');
      log('--- GENERATE ARTICLE CONTENT FAILED (EMPTY) ---');
      return { success: false, error: 'Generated content is empty' };
    }

    log(`First 200 characters of generated content: ${generatedText.substring(0, 200)}...`);
    log('--- GENERATE ARTICLE CONTENT SUCCESS ---');

    return { success: true, content: generatedText };
  } catch (err) {
    error(`Gemini error: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    log('--- GENERATE ARTICLE CONTENT ERROR ---');
    return { success: false, error: `Failed to generate content: ${err.message}` };
  }
}

// Build prompts
function buildSystemPrompt(title, category, sources, style) {
  const lengthConfig = {
    concise: {
      wordCount: '250-350',
      sections: 4,
      description: 'brief'
    },
    moderate: {
      wordCount: '350-450',
      sections: 4,
      description: 'balanced'
    },
    extended: {
      wordCount: '400-500',
      sections: 5,
      description: 'comprehensive'
    }
  };

  const config = lengthConfig[style] || lengthConfig.moderate;

  let prompt = `You are a ${category} expert. Write a ${config.description} blog article in HTML for TinyMCE.

**Requirements:**
- Title: "${title}"  
- Length: ${config.wordCount} words
- Sections: ${config.sections} main sections with <h2 class="article-h2">
- Format: HTML only - NO markdown

**HTML Classes:**
<style>
  .article-h2 {
    font-size: 1.875rem;
    font-weight: 700;
    margin: 2rem 0 1rem 0;
    color: #000000;
    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .article-h3 {
    font-size: 1.5rem;
    font-weight: 700;
    margin: 1.5rem 0 0.75rem 0;
    color: #000000;
    border-bottom: 2px solid #e5e7eb;
    padding-bottom: 0.5rem;
  }
  .article-p {
    font-size: 1rem;
    line-height: 1.7;
    margin: 1rem 0;
    color: #000000;
  }
  .article-ul, .article-ol {
    margin: 1.5rem 0;
    padding: 1rem 1rem 1rem 2rem;
    border-left: 3px solid #3b82f6;
  }
  .article-li {
    margin: 0.75rem 0;
    color: #000000;
  }
  .article-table {
    width: 100%;
    border-collapse: collapse;
    margin: 2rem 0;
  }
  .article-table th {
    background: linear-gradient(135deg, #3b82f6, #8b5cf6);
    color: white;
    padding: 1rem;
    font-weight: 600;
  }
  .article-table td {
    padding: 0.875rem 1rem;
    border-bottom: 1px solid #e5e7eb;
    color: #000000;
  }
  .highlight-info {
    border: 2px solid #0ea5e9;
    padding: 1.5rem;
    margin: 2rem 0;
    color: #000000;
  }
  .dark .article-h2 {
    color: #ffffff;
    background: linear-gradient(135deg, #60a5fa, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .dark .article-h3, .dark .article-p, .dark .article-li {
    color: #ffffff;
  }
  .dark .article-ul, .dark .article-ol {
    border-left-color: #60a5fa;
  }
  .dark .article-table th {
    background: linear-gradient(135deg, #1e3a8a, #5b21b6);
  }
  .dark .article-table td {
    color: #ffffff;
    border-bottom-color: #374151;
  }
  .dark .highlight-info {
    color: #ffffff;
    background-color: rgba(14, 165, 233, 0.1);
  }
</style>

**Rules:**
- Start with <style> tag, then content
- Use CSS classes only - NO inline styles
- Write original content - don't copy sources
- Keep it concise`;

  return prompt;
}

function buildCompletePrompt(systemPrompt, userPrompt, sources) {
  console.log('--- BUILD COMPLETE PROMPT START ---');
  console.log(`System prompt length: ${systemPrompt.length} characters`);
  console.log(`User prompt length: ${userPrompt.length} characters`);
  console.log(`Sources count: ${sources ? sources.length : 0}`);

  const contents = [
    {
      role: 'user',
      parts: [{ text: systemPrompt }]
    },
    {
      role: 'user',
      parts: [{ text: `USER INSTRUCTIONS:\n${userPrompt}` }]
    }
  ];

  if (sources && sources.length > 0) {
    console.log('Adding sources to complete prompt');
    contents.push({
      role: 'user',
      parts: [{ text: `SOURCES TO REFERENCE:\n${sources.join('\n')}` }]
    });
  }

  console.log(`Complete prompt parts count: ${contents.length}`);
  console.log('--- BUILD COMPLETE PROMPT END ---');

  return contents;
}

async function decrementUserQuota(userId, requestType, log, error) {
  try {
    log(`Decrementing quota for user: ${userId}, type: ${requestType}`);

    // Validate userId is string
    if (!userId || typeof userId !== 'string') {
      error(`Invalid userId format in decrementUserQuota: ${userId}`);
      return;
    }

    let currentPrefs = {};

    try {
      // Get current user preferences
      currentPrefs = await users.getPrefs(userId);
    } catch (prefsError) {
      // If user has no preferences, create default ones
      if (prefsError.code === 404 || prefsError.message.includes('not found')) {
        log(`No preferences found for user ${userId}, creating defaults`);
        currentPrefs = {
          basic_uses: 0,
          pro_uses: 0,
          ultra_uses: 0
        };
      } else {
        throw prefsError; // Re-throw if it's a different error
      }
    }

    const usageField = getUsageFieldForRequestType(requestType);
    if (!usageField) {
      error(`Invalid request type for quota decrement: ${requestType}`);
      return;
    }

    const currentUses = currentPrefs[usageField] || 0;
    const newUses = Math.max(0, currentUses - 1);

    // Update user preferences with new quota
    const updatedPrefs = { ...currentPrefs, [usageField]: newUses };

    // Validate updatedPrefs is an object
    if (!updatedPrefs || typeof updatedPrefs !== 'object') {
      error(`Invalid updatedPrefs format: ${updatedPrefs}`);
      return;
    }

    await users.updatePrefs(userId, updatedPrefs);

    log(`User quota updated: ${usageField} = ${newUses}`);
  } catch (err) {
    error(`Quota decrement error: ${err.message}`);
  }
}
