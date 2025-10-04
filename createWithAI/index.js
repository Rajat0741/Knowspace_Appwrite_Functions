import { Client, Databases, ID, Query, Users } from 'node-appwrite';
import { GoogleGenAI, Type } from '@google/genai';

/**
 * Appwrite Function: Enhanced AI Content Generator
 */

const CONFIG = {
  MODELS: {
    basic: 'gemini-2.5-flash-lite',
    pro: 'gemini-2.5-flash',
    ultra: 'gemini-2.5-pro'
  },
  MAX_OUTPUT_TOKENS: {
    concise: 30000,
    moderate: 45000,
    extended: 60000
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

  let trackingDocId = null;
  try {
    log('=== STARTING AI CONTENT GENERATION FUNCTION ===');
    log(`Request timestamp: ${new Date().toISOString()}`);
    log(`Request method: ${req.method}`);
    log(`Request headers: ${JSON.stringify(req.headers)}`);
    
    const requestBody = req.body || '{}';
    log(`Raw request body length: ${requestBody.length} characters`);
    
    const {
      userId, prompt, title, sources = [],
      category, requestType = 'basic', style = 'moderate'
    } = JSON.parse(requestBody);

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
    if (!userId || !prompt || !title || !category) {
      error('Missing required fields validation failed');
      log(`Missing fields - userId: ${!!userId}, prompt: ${!!prompt}, title: ${!!title}, category: ${!!category}`);
      return res.json({ success: false, error: 'Missing required fields: userId, prompt, title, category' }, 400, getCORSHeaders());
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

    // 2. Create tracking doc with inprogress + blank error
    log('=== STEP 2: CREATING TRACKING DOCUMENT ===');
    const trackingDoc = await createTrackingDocument(
      userId, title, prompt, category, requestType, style, sources, log, error
    );
    if (!trackingDoc.success) {
      error('Failed to create tracking document');
      return res.json({ success: false, error: 'Failed to create tracking document' }, 500, getCORSHeaders());
    }
    trackingDocId = trackingDoc.documentId;
    log(`✓ Tracking document created with ID: ${trackingDocId}`);
    
    // 3. Generate content (Gemini)
    log('=== STEP 3: GENERATING CONTENT WITH GEMINI ===');
    let generatedContent = await generateArticleContent(
      prompt, title, sources, category, requestType, style, log, error
    );
    if (!generatedContent.success) {
      error(`Content generation failed: ${generatedContent.error}`);
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.FAILED, generatedContent.error, null, log, error);
      return res.json({ success: false, error: generatedContent.error }, 500, getCORSHeaders());
    }
    log(`✓ Content generated successfully, length: ${generatedContent.content.length} characters`);


    // 5. Validate HTML (must contain <h2> or <p>)
    log('=== STEP 5: VALIDATING HTML CONTENT ===');
    if (!isValidHTMLContent(generatedContent.content)) {
      const validationError = 'Content validation failed: must include <h2> or <p> tags for TinyMCE compatibility';
      error(validationError);
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.FAILED, validationError, null, log, error);
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
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.FAILED, 'Failed to create article document', null, log, error);
      return res.json({ success: false, error: 'Failed to create article document' }, 500, getCORSHeaders());
    }
    log(`✓ Article document created with ID: ${articleDoc.documentId}`);
    
    // 7. update tracking (completed, clear error, link postId)
    log('=== STEP 7: UPDATING TRACKING STATUS TO COMPLETED ===');
    await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, '', articleDoc.documentId, log, error);
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
      trackingId: trackingDocId,
      articleId: articleDoc.documentId
    }, 200, getCORSHeaders());

  } catch (err) {
    error(`=== FATAL FUNCTION ERROR ===`);
    error(`Error timestamp: ${new Date().toISOString()}`);
    error(`Error message: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    
    if (trackingDocId) {
      log(`Updating tracking document ${trackingDocId} with error status`);
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.FAILED, err.message, null, log, error);
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

// Include error field on create
async function createTrackingDocument(userId, title, prompt, category, requestType, style, sources, log, error) {
  try {
    log('--- CREATE TRACKING DOCUMENT START ---');
    log(`Creating tracking doc for user: ${userId}`);
    log(`Title: ${title}`);
    log(`Category: ${category}`);
    log(`Request Type: ${requestType}`);
    log(`Style: ${style}`);
    log(`Sources: ${JSON.stringify(sources)}`);
    
    const trackingData = {
      userid: userId, 
      title, 
      prompt, 
      category,
      request_type: requestType, 
      style, 
      status: CONFIG.STATUS.IN_PROGRESS,
      sources: sources.length > 0 ? sources.join(',') : '',
      postId: null,
      error: ''
    };
    
    log(`Tracking data prepared: ${JSON.stringify(trackingData)}`);
    log(`Database ID: ${CONFIG.DATABASE_ID}`);
    log(`Collection ID: ${CONFIG.COLLECTIONS.TRACKING}`);
    
    const document = await databases.createDocument(
      CONFIG.DATABASE_ID, 
      CONFIG.COLLECTIONS.TRACKING,
      ID.unique(), 
      trackingData
    );
    
    log(`Tracking document created successfully with ID: ${document.$id}`);
    log(`Document created at: ${document.$createdAt}`);
    log('--- CREATE TRACKING DOCUMENT SUCCESS ---');
    
    return { success: true, documentId: document.$id };
  } catch (err) {
    error(`Tracking doc error: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    log('--- CREATE TRACKING DOCUMENT ERROR ---');
    return { success: false, error: err.message };
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
    
    const updateData = { status, error: errorMessage || '' };
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
    
    const tools = [
      { googleSearch: {} }
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
        thinkingConfig: { thoughtsIncluded: true }
      }
    };
    log(`Request configuration: ${JSON.stringify({...requestConfig, contents: '[PROMPT_DATA]'})}`);
    
    log('Making request to Gemini AI...');
    const response = await ai.models.generateContent(requestConfig);
    
    log('Gemini AI response received');
    log(`Response object keys: ${Object.keys(response).join(', ')}`);
    
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
    short: {
      wordCount: '1800-2200',
      wordMin: 1800,
      wordMax: 2200,
      sections: 5,
      subsectionsPerSection: 3,
      paragraphsPerSection: 4,
      wordsPerParagraph: '60-100',
      listItems: 5,
      wordsPerListItem: '30-50',
      blockquotes: 3,
      description: 'concise yet comprehensive'
    },
    moderate: {
      wordCount: '2800-3200',
      wordMin: 2800,
      wordMax: 3200,
      sections: 7,
      subsectionsPerSection: 4,
      paragraphsPerSection: 5,
      wordsPerParagraph: '70-110',
      listItems: 7,
      wordsPerListItem: '35-55',
      blockquotes: 5,
      description: 'thorough and well-balanced'
    },
    long: {
      wordCount: '3800-4500',
      wordMin: 3800,
      wordMax: 4500,
      sections: 10,
      subsectionsPerSection: 5,
      paragraphsPerSection: 7,
      wordsPerParagraph: '80-120',
      listItems: 9,
      wordsPerListItem: '40-60',
      blockquotes: 7,
      description: 'in-depth, exhaustive, and authoritative'
    }
  };
  
  const config = lengthConfig[style] || lengthConfig.moderate;
  
  let prompt = `# PRIMARY MISSION
You are a world-class content creator specializing in "${category}" content. Create an exceptional, comprehensive article that is visually stunning, deeply informative, and optimized for both light and dark modes.

# ARTICLE PARAMETERS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Title: "${title}"
Category: ${category}
Style: ${style.toUpperCase()}
Target Word Count: ${config.wordCount} words (MINIMUM ${config.wordMin}, MAXIMUM ${config.wordMax})

# CRITICAL LENGTH REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THIS IS A ${style.toUpperCase()} ARTICLE - YOU MUST WRITE ${config.wordCount} WORDS

STRUCTURAL REQUIREMENTS:
→ Total Sections: ${config.sections} major sections (each with <h2 class="article-h2">)
→ Subsections: ${config.subsectionsPerSection} subsections per major section (each with <h3 class="article-h3">)
→ Paragraphs per Section: ${config.paragraphsPerSection} substantial paragraphs
→ Words per Paragraph: ${config.wordsPerParagraph} words (NO SHORT PARAGRAPHS)
→ List Items: ${config.listItems} items per list
→ Words per List Item: ${config.wordsPerListItem} words with detailed explanations
→ Blockquotes/Callouts: ${config.blockquotes} throughout the article
→ Introduction: 150-250 words (compelling hook + preview)
→ Conclusion: 150-250 words (summary + actionable takeaways)

CALCULATION CHECK:
- ${config.sections} sections × ${config.paragraphsPerSection} paragraphs × ${config.wordsPerParagraph.split('-')[0]} words = ${config.sections * config.paragraphsPerSection * parseInt(config.wordsPerParagraph.split('-')[0])} words minimum from paragraphs alone
- Plus lists, blockquotes, intro, conclusion = Target ${config.wordCount} words

YOU MUST WRITE LONG, DETAILED CONTENT. Every section must be substantial.

# OUTPUT FORMAT (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Generate Only tinymce compatible Content (most important)
2. Follow immediately with HTML content using CSS classes ONLY
3. NO inline styles anywhere (they break dark mode)
4. NO markdown syntax (##, **, [], etc.)
5. NO code fences or wrappers (\`\`\`html, etc.)
6. NO preamble text ("Here's the article...", "Below is...", etc.)

# COMPLETE CSS TEMPLATE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are expected create styles by your own understanding and use these as examples only to:

<style>
/* Typography & Base Styles */
.article-h2 {
  color: #2c3e50;
  font-size: 28px;
  font-weight: 700;
  margin: 40px 0 20px 0;
  padding-bottom: 12px;
  border-bottom: 3px solid #3498db;
  line-height: 1.3;
}

.article-h3 {
  color: #34495e;
  font-size: 22px;
  font-weight: 600;
  margin: 28px 0 14px 0;
  line-height: 1.4;
}

.article-h4 {
  color: #2c3e50;
  font-size: 18px;
  font-weight: 600;
  margin: 20px 0 10px 0;
  line-height: 1.4;
}

.article-p {
  font-size: 16px;
  line-height: 1.8;
  color: #333;
  margin-bottom: 18px;
  text-align: justify;
}

.article-strong {
  color: #2c3e50;
  font-weight: 600;
}

.article-em {
  font-style: italic;
  color: #555;
}

/* Blockquotes - Gradient Style */
.blockquote-gradient {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  padding: 24px 28px;
  margin: 28px 0;
  border-left: 6px solid #ffd700;
  border-radius: 10px;
  font-size: 17px;
  line-height: 1.7;
  box-shadow: 0 6px 12px rgba(0,0,0,0.15);
}

.blockquote-gradient strong {
  font-size: 19px;
  display: block;
  margin-bottom: 10px;
  font-weight: 700;
}

/* Blockquotes - Simple Style */
.blockquote-simple {
  background-color: #f8f9fa;
  border-left: 5px solid #28a745;
  padding: 18px 24px;
  margin: 24px 0;
  border-radius: 6px;
  font-style: italic;
  color: #495057;
  font-size: 16px;
  line-height: 1.7;
}

/* Blockquotes - Quote Style */
.blockquote-quote {
  background-color: #fff8e1;
  border-left: 5px solid #ffa726;
  padding: 20px 24px;
  margin: 24px 0;
  border-radius: 6px;
  font-size: 17px;
  color: #e65100;
  line-height: 1.7;
  font-style: italic;
}

/* Lists */
.article-ul, .article-ol {
  margin: 20px 0;
  padding-left: 28px;
  line-height: 1.8;
}

.article-li {
  margin-bottom: 16px;
  color: #333;
  font-size: 16px;
  line-height: 1.7;
}

.article-li strong {
  color: #2c3e50;
  font-weight: 600;
}

/* Highlight Boxes */
.highlight-warning {
  background: #fff3cd;
  border: 2px solid #ffc107;
  border-radius: 10px;
  padding: 20px 24px;
  margin: 28px 0;
}

.highlight-warning p {
  margin: 0;
  color: #856404;
  font-size: 16px;
  line-height: 1.7;
}

.highlight-info {
  background: #d1ecf1;
  border-left: 5px solid #17a2b8;
  padding: 20px 24px;
  margin: 24px 0;
  border-radius: 6px;
}

.highlight-info p {
  margin: 0;
  color: #0c5460;
  font-size: 16px;
  line-height: 1.7;
}

.highlight-success {
  background: #d4edda;
  border-left: 5px solid #28a745;
  padding: 20px 24px;
  margin: 24px 0;
  border-radius: 6px;
}

.highlight-success p {
  margin: 0;
  color: #155724;
  font-size: 16px;
  line-height: 1.7;
}

.highlight-danger {
  background: #f8d7da;
  border-left: 5px solid #dc3545;
  padding: 20px 24px;
  margin: 24px 0;
  border-radius: 6px;
}

.highlight-danger p {
  margin: 0;
  color: #721c24;
  font-size: 16px;
  line-height: 1.7;
}

/* Tables (if needed) */
.article-table {
  width: 100%;
  border-collapse: collapse;
  margin: 24px 0;
  font-size: 16px;
}

.article-table th {
  background-color: #3498db;
  color: white;
  padding: 12px;
  text-align: left;
  font-weight: 600;
}

.article-table td {
  padding: 12px;
  border-bottom: 1px solid #ddd;
  color: #333;
}

.article-table tr:hover {
  background-color: #f5f5f5;
}

/* Dark Mode Overrides */
@media (prefers-color-scheme: dark) {
  .article-h2 {
    color: #e8eaed;
    border-bottom-color: #8ab4f8;
  }
  
  .article-h3 {
    color: #e8eaed;
  }
  
  .article-h4 {
    color: #e8eaed;
  }
  
  .article-p {
    color: #e8eaed;
  }
  
  .article-strong {
    color: #aecbfa;
  }
  
  .article-em {
    color: #bdc1c6;
  }
  
  .blockquote-gradient {
    background: linear-gradient(135deg, #5e72e4 0%, #6a3aa2 100%);
    box-shadow: 0 6px 12px rgba(0,0,0,0.4);
  }
  
  .blockquote-simple {
    background-color: #1e293b;
    color: #cbd5e1;
    border-left-color: #34d399;
  }
  
  .blockquote-quote {
    background-color: #2d2416;
    color: #ffd699;
    border-left-color: #ff9800;
  }
  
  .article-li {
    color: #e8eaed;
  }
  
  .highlight-warning {
    background: #2d2416;
    border-color: #eab308;
  }
  
  .highlight-warning p {
    color: #fef3c7;
  }
  
  .highlight-info {
    background: #0f2832;
    border-left-color: #06b6d4;
  }
  
  .highlight-info p {
    color: #cffafe;
  }
  
  .highlight-success {
    background: #1a2e1a;
    border-left-color: #34d399;
  }
  
  .highlight-success p {
    color: #d1fae5;
  }
  
  .highlight-danger {
    background: #2e1a1a;
    border-left-color: #f87171;
  }
  
  .highlight-danger p {
    color: #fecaca;
  }
  
  .article-table th {
    background-color: #1e40af;
  }
  
  .article-table td {
    border-bottom-color: #374151;
    color: #e8eaed;
  }
  
  .article-table tr:hover {
    background-color: #1f2937;
  }
}
</style>

# HTML STRUCTURE & USAGE EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INTRODUCTION (150-250 words):
<p class="article-p">Start with a compelling hook that grabs attention. Explain why this topic matters to readers. Preview what they'll learn. Make this substantial - ${config.wordsPerParagraph} words with depth, context, and value.</p>

MAJOR SECTION:
<h2 class="article-h2">Compelling Section Title That Describes Content</h2>
<p class="article-p">Opening paragraph introducing this section's focus. Write ${config.wordsPerParagraph} words with specific details, examples, and insights. Every sentence should add value and advance understanding.</p>

SUBSECTION:
<h3 class="article-h3">Specific Subtopic Within Main Section</h3>
<p class="article-p">Detailed explanation with concrete examples, data points, or case studies. Make this ${config.wordsPerParagraph} words with real substance. Include practical applications and actionable insights.</p>

<p class="article-p">Continue with additional paragraphs that explore different aspects. Use <strong class="article-strong">key terminology</strong> and <em class="article-em">subtle emphasis</em> where appropriate. Each paragraph should be comprehensive.</p>

BLOCKQUOTES - Use ${config.blockquotes} throughout article:
<blockquote class="blockquote-gradient">
  <strong>💡 Pro Tip:</strong>
  Share valuable insider knowledge or best practices. Write 2-3 substantial sentences that provide genuine value readers can't easily find elsewhere. Be specific and actionable.
</blockquote>

<blockquote class="blockquote-simple">
  "Powerful, memorable quote that reinforces your key message and provides authority or credibility to your argument."
</blockquote>

<blockquote class="blockquote-quote">
  Important statistic or research finding that supports your points with concrete data.
</blockquote>

LISTS - Use ${config.listItems} items, ${config.wordsPerListItem} words each:
<ul class="article-ul">
  <li class="article-li"><strong>First Key Point Title:</strong> Comprehensive explanation that includes context, practical examples, specific steps, or real-world applications. Write ${config.wordsPerListItem} words minimum with genuine depth and actionable details that readers can implement.</li>
  <li class="article-li"><strong>Second Key Point Title:</strong> Another detailed explanation with examples, data, case studies, or step-by-step guidance. Provide real value with specific, concrete information.</li>
  <li class="article-li"><strong>Third Key Point Title:</strong> Continue pattern with substantial, valuable content in every list item.</li>
</ul>

NUMBERED LISTS (for processes, steps, rankings):
<ol class="article-ol">
  <li class="article-li"><strong>Step One - Action Title:</strong> Detailed instructions explaining what to do, why it matters, and how to execute effectively. Include tips, common mistakes to avoid, and expected outcomes.</li>
  <li class="article-li"><strong>Step Two - Next Action:</strong> Continue with clear, comprehensive guidance.</li>
</ol>

HIGHLIGHT BOXES - Use strategically:
<div class="highlight-warning">
  <p><strong>⚠️ Important Warning:</strong> Critical information readers must know to avoid mistakes, problems, or missed opportunities. Explain the implications and what to do instead.</p>
</div>

<div class="highlight-info">
  <p><strong>ℹ️ Did You Know?</strong> Fascinating fact, statistic, or insight that adds depth and interest. Explain why this matters and how readers can use this information.</p>
</div>

<div class="highlight-success">
  <p><strong>✅ Best Practice:</strong> Proven strategy or recommendation backed by experience or data. Explain implementation details.</p>
</div>

<div class="highlight-danger">
  <p><strong>🚫 Avoid This:</strong> Common mistake or pitfall with explanation of why it's problematic and what to do instead.</p>
</div>

CONCLUSION (150-250 words):
<h2 class="article-h2">Conclusion: Key Takeaways and Next Steps</h2>
<p class="article-p">Summarize the most important points from the article. Reinforce the main message and value provided. Give readers clear, actionable next steps they can take immediately.</p>

# CONTENT QUALITY STANDARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DEPTH & SUBSTANCE:
✓ Every paragraph must provide genuine value - NO filler content
✓ Include specific examples, case studies, or real-world scenarios in each section
✓ Use concrete numbers, statistics, data points, or research findings
✓ Provide actionable advice - readers should know exactly what to DO
✓ Explain the "why" behind concepts, not just the "what"
✓ Address common questions, concerns, or objections readers might have

WRITING QUALITY:
✓ Vary sentence length and structure for engaging rhythm
✓ Use active voice predominantly (passive voice sparingly)
✓ Professional yet conversational tone - write like a knowledgeable friend
✓ Match energy and style to "${category}" category expectations
✓ Use transitions between sections for smooth flow
✓ Balance technical accuracy with accessibility

ENGAGEMENT ELEMENTS:
✓ Start sections with hooks that create curiosity
✓ Use rhetorical questions occasionally to engage readers
✓ Include surprising facts or counterintuitive insights
✓ Provide contrasts and comparisons to aid understanding
✓ Use analogies or metaphors for complex concepts
✓ Add personality while maintaining professionalism

PARAGRAPH CONSTRUCTION:
✓ Each paragraph: ${config.wordsPerParagraph} words (STRICTLY ENFORCE)
✓ Topic sentence that introduces the main idea
✓ 3-6 supporting sentences with details, examples, evidence
✓ Concluding or transitional sentence
✓ NO single-sentence paragraphs
✓ NO shallow or superficial content

# STRICT PROHIBITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✗ NEVER mention source URLs in article content
✗ NEVER write "according to [source]" or "based on [URL]"
✗ NEVER use inline styles (style="...") - ONLY CSS classes
✗ NEVER use markdown syntax (##, **, __, etc.)
✗ NEVER wrap output in code fences (\`\`\`html)
✗ NEVER include preamble text before the <style> tag
✗ NEVER write short paragraphs under ${config.wordsPerParagraph.split('-')[0]} words
✗ NEVER use generic, fluffy content without substance
✗ NEVER skip sections or subsections to save space
✗ NEVER fall short of ${config.wordMin} word minimum

# PRE-WRITING ANALYSIS (THINK BEFORE GENERATING)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before you begin writing, mentally complete this planning:

1. TOPIC ANALYSIS:
   - What are the 3-5 core questions readers have about "${title}"?
   - What misconceptions exist around this topic?
   - What makes content in "${category}" engaging and valuable?

2. STRUCTURE PLANNING:
   - Map out ${config.sections} section titles that comprehensively cover the topic
   - For each section, identify ${config.subsectionsPerSection} logical subsections
   - Plan specific examples, data, or case studies for each section

3. CONTENT DEPTH:
   - Identify 10+ concrete examples or scenarios to include
   - List 5+ statistics, data points, or research findings to incorporate
   - Plan 3-5 actionable takeaways readers can implement
   - Consider common objections or questions to address

4. WORD COUNT CALCULATION:
   - ${config.sections} sections × ${config.paragraphsPerSection} paragraphs × ${parseInt(config.wordsPerParagraph.split('-')[1])} words = ${config.sections * config.paragraphsPerSection * parseInt(config.wordsPerParagraph.split('-')[1])} words from paragraphs
   - ${config.blockquotes} blockquotes × 40 words average = ${config.blockquotes * 40} words
   - ${config.sections} lists × ${config.listItems} items × ${parseInt(config.wordsPerListItem.split('-')[1])} words = ${config.sections * config.listItems * parseInt(config.wordsPerListItem.split('-')[1])} words
   - Introduction (200 words) + Conclusion (200 words) = 400 words
   - TOTAL TARGET: ${config.wordCount} words

5. VISUAL VARIETY:
   - Plan placement of ${config.blockquotes} blockquotes throughout
   - Determine which sections need lists vs continuous prose
   - Identify where highlight boxes add value`;

  if (sources && sources.length > 0) {
    prompt += `\n\n# REFERENCE SOURCES (FOR FACTUAL ACCURACY ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The following sources are provided for research and fact-checking:

${sources.map((url, i) => `${i + 1}. ${url}`).join('\n')}

SOURCE USAGE GUIDELINES:
✓ Extract key facts, statistics, and technical details
✓ Verify accuracy of information you include
✓ Synthesize insights and present in your own words
✓ Use data points to add credibility and specificity
✗ NEVER mention these URLs in the article content
✗ NEVER write "according to this source" or similar phrases
✗ NEVER include attribution or citations
→ Treat sources as invisible background research`;
  }

  prompt += `\n\n# FINAL EXECUTION CHECKLIST

DO NOT include any text before <style> tag.
DO NOT use markdown or code fences.
BEGIN WRITING NOW with deep, comprehensive, valuable content.
TARGET: ${config.wordCount} WORDS - GO!`;

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
