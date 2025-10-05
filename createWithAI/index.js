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
      wordsPerParagraph: '80-120',
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
      wordsPerParagraph: '90-130',
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
      wordsPerParagraph: '100-140',
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
→ Conclusion: 200-250 words (summary + actionable takeaways)

YOU MUST WRITE LONG, DETAILED CONTENT. Every section must be substantial.

# OUTPUT FORMAT (MANDATORY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Generate Only tinymce compatible Content (most important)
2. Follow immediately with HTML content using CSS classes ONLY
3. NO inline styles anywhere (they break dark mode)
4. NO markdown syntax (##, **, [], etc.)
5. NO code fences or wrappers (\`\`\`html, etc.)
6. NO preamble text ("Here's the article...", "Below is...", etc.)


Use semantic HTML and apply appropriate CSS classes.

General Styling Instructions:
- Ensure good readability and contrast for both light and dark modes.
- Use only CSS classes, never inline styles.
- Make content visually clear, well-spaced, and accessible.
- Use headings, paragraphs, lists, blockquotes, and highlight boxes with appropriate classes.
- Prioritize clarity, legibility, and a professional appearance.

# COMPREHENSIVE CSS STYLING WITH DARK MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<style>
/* Base Typography */
.article-h2 { 
  font-size: 1.875rem; font-weight: 700; margin: 2rem 0 1rem 0; line-height: 1.2; 
  color: #1f2937; background: linear-gradient(135deg, #3b82f6, #8b5cf6); 
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; 
  text-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
.article-h3 { 
  font-size: 1.5rem; font-weight: 600; margin: 1.5rem 0 0.75rem 0; line-height: 1.3; 
  color: #374151; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem;
}
.article-p { 
  font-size: 1rem; line-height: 1.7; margin: 1rem 0; color: #4b5563; 
  text-align: justify; letter-spacing: 0.025em;
}
.article-strong { font-weight: 600; color: #1f2937; }
.article-em { font-style: italic; color: #6b7280; }

/* Enhanced Lists */
.article-ul, .article-ol { 
  margin: 1.5rem 0; padding-left: 2rem; 
  background: rgba(59, 130, 246, 0.02); border-radius: 0.5rem; padding: 1rem 1rem 1rem 2rem;
}
.article-li { 
  margin: 0.75rem 0; line-height: 1.6; color: #374151; 
  position: relative; transition: all 0.2s ease;
}
.article-li:hover { transform: translateX(4px); }

/* Advanced Blockquotes with Gradients */
.blockquote-gradient { 
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(147, 51, 234, 0.1));
  border-left: 4px solid #3b82f6; padding: 1.5rem; margin: 2rem 0; border-radius: 0.75rem;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15); position: relative; overflow: hidden;
}
.blockquote-gradient::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899);
}
.blockquote-simple { 
  border-left: 4px solid #6b7280; padding: 1.5rem; margin: 2rem 0; font-style: italic;
  background: linear-gradient(135deg, rgba(107, 114, 128, 0.05), rgba(107, 114, 128, 0.02));
  border-radius: 0.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.05);
}
.blockquote-quote { 
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(34, 197, 94, 0.05));
  border-left: 4px solid #22c55e; padding: 1.5rem; margin: 2rem 0; border-radius: 0.75rem;
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.15); position: relative;
}

/* Enhanced Highlight Boxes */
.highlight-warning { 
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(245, 158, 11, 0.05));
  border: 2px solid rgba(245, 158, 11, 0.4); padding: 1.5rem; margin: 2rem 0; 
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(245, 158, 11, 0.2);
  animation: pulse-warning 3s infinite;
}
.highlight-info { 
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.15), rgba(59, 130, 246, 0.05));
  border: 2px solid rgba(59, 130, 246, 0.4); padding: 1.5rem; margin: 2rem 0; 
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(59, 130, 246, 0.2);
}
.highlight-success { 
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(34, 197, 94, 0.05));
  border: 2px solid rgba(34, 197, 94, 0.4); padding: 1.5rem; margin: 2rem 0; 
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(34, 197, 94, 0.2);
}
.highlight-danger { 
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.05));
  border: 2px solid rgba(239, 68, 68, 0.4); padding: 1.5rem; margin: 2rem 0; 
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2);
  animation: pulse-danger 4s infinite;
}

/* Animations */
@keyframes pulse-warning { 0%, 100% { box-shadow: 0 4px 12px rgba(245, 158, 11, 0.2); } 50% { box-shadow: 0 6px 20px rgba(245, 158, 11, 0.3); } }
@keyframes pulse-danger { 0%, 100% { box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2); } 50% { box-shadow: 0 6px 20px rgba(239, 68, 68, 0.3); } }

/* DARK MODE MEDIA QUERIES */
@media (prefers-color-scheme: dark) {
  .article-h2 { color: #f9fafb; text-shadow: 0 2px 8px rgba(59, 130, 246, 0.3); }
  .article-h3 { color: #e5e7eb; border-bottom-color: #374151; }
  .article-p { color: #d1d5db; }
  .article-strong { color: #f9fafb; }
  .article-em { color: #9ca3af; }
  .article-ul, .article-ol { background: rgba(59, 130, 246, 0.08); }
  .article-li { color: #e5e7eb; }
  
  .blockquote-gradient { 
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2));
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25);
  }
  .blockquote-simple { 
    background: linear-gradient(135deg, rgba(107, 114, 128, 0.15), rgba(107, 114, 128, 0.08));
    box-shadow: 0 2px 12px rgba(0,0,0,0.3);
  }
  .blockquote-quote { 
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.1));
    box-shadow: 0 4px 12px rgba(34, 197, 94, 0.25);
  }
  
  .highlight-warning { 
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(245, 158, 11, 0.1));
    border-color: rgba(245, 158, 11, 0.6); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.3);
  }
  .highlight-info { 
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(59, 130, 246, 0.1));
    border-color: rgba(59, 130, 246, 0.6); box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3);
  }
  .highlight-success { 
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(34, 197, 94, 0.1));
    border-color: rgba(34, 197, 94, 0.6); box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3);
  }
  .highlight-danger { 
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.1));
    border-color: rgba(239, 68, 68, 0.6); box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3);
  }
}

/* EXPLICIT DARK MODE CLASS */
.dark .article-h2 { color: #f9fafb; text-shadow: 0 2px 8px rgba(59, 130, 246, 0.3); }
.dark .article-h3 { color: #e5e7eb; border-bottom-color: #374151; }
.dark .article-p { color: #d1d5db; }
.dark .article-strong { color: #f9fafb; }
.dark .article-em { color: #9ca3af; }
.dark .article-ul, .dark .article-ol { background: rgba(59, 130, 246, 0.08); }
.dark .article-li { color: #e5e7eb; }
.dark .blockquote-gradient { 
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2));
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25);
}
.dark .blockquote-simple { 
  background: linear-gradient(135deg, rgba(107, 114, 128, 0.15), rgba(107, 114, 128, 0.08));
  box-shadow: 0 2px 12px rgba(0,0,0,0.3);
}
.dark .blockquote-quote { 
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.1));
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.25);
}
.dark .highlight-warning { 
  background: linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(245, 158, 11, 0.1));
  border-color: rgba(245, 158, 11, 0.6); box-shadow: 0 4px 16px rgba(245, 158, 11, 0.3);
}
.dark .highlight-info { 
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(59, 130, 246, 0.1));
  border-color: rgba(59, 130, 246, 0.6); box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3);
}
.dark .highlight-success { 
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(34, 197, 94, 0.1));
  border-color: rgba(34, 197, 94, 0.6); box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3);
}
.dark .highlight-danger { 
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.1));
  border-color: rgba(239, 68, 68, 0.6); box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3);
}
</style>

# ESSENTIAL HTML STRUCTURE EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ESSENTIAL HTML STRUCTURE EXAMPLES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INTRODUCTION (150-250 words):
<p class="article-p">Start with compelling hook addressing reader's pain point. Provide context with data/research. Promise specific value and outcomes they'll achieve.</p>

SECTION STRUCTURE:
<h2 class="article-h2">Section Title</h2>
<p class="article-p">Opening paragraph with ${config.wordsPerParagraph} words, concrete details, examples, actionable insights.</p>

<h3 class="article-h3">Subsection Title</h3>
<p class="article-p">Detailed explanation with ${config.wordsPerParagraph} words, statistics, case studies, practical applications.</p>

BLOCKQUOTE TYPES:
<blockquote class="blockquote-gradient">
  <strong>💡 Expert Insight:</strong> Professional advice, insider knowledge, industry secrets with specific actionable details.
</blockquote>

<blockquote class="blockquote-simple">
  "Authoritative quote from industry leaders or research that reinforces key message and adds credibility."
</blockquote>

<blockquote class="blockquote-quote">
  <strong>📊 Key Data:</strong> Important statistics with context about significance and application.
</blockquote>

LIST PATTERNS:
<ul class="article-ul">
  <li class="article-li"><strong>Point Title:</strong> ${config.wordsPerListItem} words with context, examples, implementation steps, expected outcomes.</li>
</ul>

<ol class="article-ol">
  <li class="article-li"><strong>Step Title:</strong> Detailed instructions, tools needed, troubleshooting tips, success metrics.</li>
</ol>

HIGHLIGHT BOXES:
<div class="highlight-warning">
  <p><strong>⚠️ Warning:</strong> Specific risks, common errors, costly mistakes to avoid with alternatives.</p>
</div>

<div class="highlight-info">
  <p><strong>ℹ️ Key Info:</strong> Important facts, insider knowledge, competitive advantages.</p>
</div>

<div class="highlight-success">
  <p><strong>✅ Best Practice:</strong> Proven strategies with implementation details and success criteria.</p>
</div>

<div class="highlight-danger">
  <p><strong>🚫 Avoid:</strong> Common pitfalls with specific consequences and better approaches.</p>
</div>

CONCLUSION:
<h2 class="article-h2">Key Takeaways and Next Steps</h2>
<p class="article-p">Synthesize 3-5 core principles. Provide immediate next steps for 24-48 hours. Include beginner and advanced options.</p>
<h2 class="article-h2">Strategic Content Flow for Maximum Engagement</h2>
# STRICT PROHIBITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✗ NEVER mention source URLs in article content
✗ NEVER use inline styles (style="...") - ONLY CSS classes
✗ NEVER use markdown syntax (##, **, __, etc.)
✗ NEVER wrap output in code fences (\`\`\`html)
✗ NEVER include preamble text before content
✗ NEVER write short paragraphs under ${config.wordsPerParagraph.split('-')[0]} words
✗ NEVER use generic, fluffy content without substance
✗ NEVER fall short of ${config.wordMin} word minimum

# FINAL EXECUTION CHECKLIST
BEGIN WRITING NOW with deep, comprehensive, valuable content.
TARGET: ${config.wordCount} WORDS with ${config.sections} sections.
START with article-p introduction, END with article-h2 conclusion.`;

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
