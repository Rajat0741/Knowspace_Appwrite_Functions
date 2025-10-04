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
  LANGSEARCH: {
    MAX_RESULTS: 20,
    SEARCH_URL: 'https://api.langsearch.com/v1/web-search',
    RERANK_URL: 'https://api.langsearch.com/v1/rerank'
  },
  STATUS: {
    IN_PROGRESS: 'inprogress',
    COMPLETED: 'completed'
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
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, generatedContent.error, null, log, error);
      return res.json({ success: false, error: generatedContent.error }, 500, getCORSHeaders());
    }
    log(`✓ Content generated successfully, length: ${generatedContent.content.length} characters`);

    // 4. Ultra → RAG semantic rerank (LangSearch API)
    if (requestType === 'ultra') {
      log('=== STEP 4: APPLYING RAG RERANK (ULTRA MODE) ===');
      const rerankRes = await ragRerankWithLangSearch(prompt, generatedContent.content, sources, log, error);
      if (rerankRes.success) {
        log(`✓ RAG rerank successful, content length: ${rerankRes.reranked.length} characters`);
        generatedContent.content = rerankRes.reranked;
      } else {
        log('⚠ LangSearch RAG rerank failed, keeping Gemini output');
        // fallback: keep Gemini output, log error but do not fail outright
      }
    } else {
      log(`=== STEP 4: SKIPPING RAG RERANK (${requestType.toUpperCase()} MODE) ===`);
    }

    // 5. Validate HTML (must contain <h2> or <p>)
    log('=== STEP 5: VALIDATING HTML CONTENT ===');
    if (!isValidHTMLContent(generatedContent.content)) {
      const validationError = 'Content validation failed: must include <h2> or <p> tags for TinyMCE compatibility';
      error(validationError);
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, validationError, null, log, error);
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
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, 'Failed to create article document', null, log, error);
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
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, err.message, null, log, error);
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

// RAG rerank for ultra requests
async function ragRerankWithLangSearch(query, text, urls, log, error) {
  try {
    log('--- RAG RERANK FUNCTION START ---');
    log(`Query length: ${query ? query.length : 0} characters`);
    log(`Text length: ${text ? text.length : 0} characters`);
    log(`URLs count: ${urls ? urls.length : 0}`);
    log(`URLs: ${JSON.stringify(urls)}`);
    
    if (!(query && text && urls && urls.length)) {
      error('RAG rerank: missing required parameters');
      log('RAG rerank validation failed - missing parameters');
      return { success: false };
    }
    
    log(`Reranking with query: "${query.substring(0, 50)}..."`);
    log(`Making request to LangSearch API: ${CONFIG.LANGSEARCH.RERANK_URL}`);
    
    const requestPayload = {
      query: query,  // Use the concise prompt/summary instead of full article
      urls: urls,
      maxK: 1
    };
    log(`Request payload: ${JSON.stringify(requestPayload)}`);
    
    const response = await fetch(CONFIG.LANGSEARCH.RERANK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LANGSEARCH_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestPayload)
    });
    
    log(`LangSearch API response status: ${response.status}`);
    log(`LangSearch API response statusText: ${response.statusText}`);
    
    const data = await response.json();
    log(`LangSearch API response data keys: ${Object.keys(data).join(', ')}`);
    
    if (data?.rerankedPassage) {
      log(`RAG rerank successful - reranked content length: ${data.rerankedPassage.length} characters`);
      log('--- RAG RERANK FUNCTION SUCCESS ---');
      return { success: true, reranked: data.rerankedPassage };
    }
    
    error('RAG rerank failed: no rerankedPassage in response');
    log(`Response data: ${JSON.stringify(data)}`);
    log('--- RAG RERANK FUNCTION FAILED ---');
    return { success: false };
    
  } catch (err) {
    error(`LangSearch RAG rerank error: ${err.message}`);
    error(`Error stack: ${err.stack}`);
    log('--- RAG RERANK FUNCTION ERROR ---');
    return { success: false };
  }
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
    
    const systemPrompt = buildSystemPrompt(title, category, sources);
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
  console.log('--- BUILD SYSTEM PROMPT START ---');
  console.log(`Building system prompt for title: ${title}`);
  console.log(`Category: ${category}`);
  console.log(`Style: ${style}`);
  console.log(`Sources count: ${sources ? sources.length : 0}`);
  
  // Define length-specific instructions with higher word counts
  const lengthConfig = {
    short: {
      wordCount: '1800-2200 words',
      sections: '4-5 major sections',
      subsections: '2-3 subsections per section',
      listItems: '4-5 items',
      blockquotes: '2-3 blockquotes',
      paragraphsPerSection: '3-4 paragraphs',
      description: 'concise yet comprehensive'
    },
    moderate: {
      wordCount: '2800-3200 words',
      sections: '6-8 major sections',
      subsections: '3-4 subsections per section',
      listItems: '5-7 items',
      blockquotes: '4-5 blockquotes',
      paragraphsPerSection: '4-5 paragraphs',
      description: 'thorough and well-balanced'
    },
    long: {
      wordCount: '3800-4500+ words',
      sections: '8-12 major sections',
      subsections: '4-6 subsections per section',
      listItems: '7-10+ items',
      blockquotes: '6-8 blockquotes',
      paragraphsPerSection: '5-7 paragraphs',
      description: 'in-depth, exhaustive, and authoritative'
    }
  };
  
  const config = lengthConfig[style] || lengthConfig.moderate;
  
  let prompt = `You are an ELITE content creator with expertise in visual design and engaging writing. Your mission is to create a STUNNING, modern blog article that looks absolutely AMAZING in TinyMCE editor.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 ARTICLE SPECIFICATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Title: "${title}"
- Category: "${category}"
- Style: ${style.toUpperCase()} - Create a ${config.description} article

📏 LENGTH & STRUCTURE REQUIREMENTS FOR ${style.toUpperCase()} STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 TARGET LENGTH: ${config.wordCount} (STRICTLY ADHERE TO THIS)

STRUCTURAL BREAKDOWN:
- Major Sections: ${config.sections} with descriptive <h2> headings
- Subsections: ${config.subsections} per major section using <h3> tags
- Paragraphs: ${config.paragraphsPerSection} per section (3-5 sentences each)
- Lists: ${config.listItems} per list with detailed explanations
- Callouts: ${config.blockquotes} throughout with valuable insights
- Each paragraph should be 60-100 words for depth

CONTENT DENSITY:
- Every section must be SUBSTANTIAL with real depth
- No filler content - every sentence adds value
- Include multiple examples, statistics, and actionable insights per section
- Use transitional paragraphs between sections
- Expand on concepts with detailed explanations

🎯 CRITICAL INSTRUCTION: THINK DEEPLY BEFORE WRITING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before generating ANY content, you MUST:
1. Analyze the title and identify the core topics, questions, and user intent
2. Consider what makes content in the "${category}" category truly engaging
3. Plan a logical structure with compelling section titles that cover the topic comprehensively
4. Think about concrete examples, analogies, case studies, and actionable insights to include
5. Map out how to make each section visually distinct and scannable
6. Ensure the content depth matches the ${style.toUpperCase()} style requirements (${config.wordCount})
7. Plan to write ${config.paragraphsPerSection} per section to meet word count targets

🎨 STYLING REQUIREMENTS (TINYMCE COMPATIBLE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
USE INLINE CSS STYLES FOR VISUAL IMPACT:

✓ HEADINGS - Make them stand out:
  <h2 style="color: #2c3e50; font-size: 28px; font-weight: 700; margin-top: 32px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 3px solid #3498db;">Section Title</h2>
  
  <h3 style="color: #34495e; font-size: 22px; font-weight: 600; margin-top: 24px; margin-bottom: 12px;">Subsection Title</h3>

✓ PARAGRAPHS - Readable and spaced (WRITE LONGER PARAGRAPHS):
  <p style="font-size: 16px; line-height: 1.8; color: #333; margin-bottom: 16px;">Your engaging content here with <strong style="color: #2c3e50; font-weight: 600;">important terms highlighted</strong> and <em style="font-style: italic; color: #555;">subtle emphasis</em> where needed. Each paragraph should be substantial, providing detailed explanations, examples, and insights that add real value to the reader.</p>

✓ BLOCKQUOTES - Eye-catching callouts:
  <blockquote style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 24px; margin: 24px 0; border-left: 5px solid #ffd700; border-radius: 8px; font-size: 17px; line-height: 1.6; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
    <strong style="font-size: 18px; display: block; margin-bottom: 8px;">💡 Pro Tip:</strong>
    Your valuable insight or key takeaway goes here. Make these blockquotes substantial with 2-3 sentences providing real depth.
  </blockquote>
  
  <blockquote style="background-color: #f8f9fa; border-left: 4px solid #28a745; padding: 16px 20px; margin: 20px 0; border-radius: 4px; font-style: italic; color: #495057;">
    "Powerful quote or important fact that deserves emphasis and provides genuine value to readers."
  </blockquote>

✓ LISTS - Scannable and structured (WRITE DETAILED LIST ITEMS):
  <ul style="margin: 16px 0; padding-left: 24px; line-height: 1.8;">
    <li style="margin-bottom: 12px; color: #333; font-size: 16px;"><strong style="color: #2c3e50;">Key Point One:</strong> Detailed explanation with context, examples, and practical applications that provide real value. Each list item should be 30-50 words.</li>
    <li style="margin-bottom: 12px; color: #333; font-size: 16px;"><strong style="color: #2c3e50;">Key Point Two:</strong> More insights with practical applications, real-world scenarios, and actionable advice that readers can implement.</li>
  </ul>
  
  <ol style="margin: 16px 0; padding-left: 24px; line-height: 1.8;">
    <li style="margin-bottom: 12px; color: #333; font-size: 16px;"><strong>Step One:</strong> Clear, detailed instructions with explanations of why this step matters and how to execute it effectively.</li>
  </ol>

✓ HIGHLIGHT BOXES - Special emphasis:
  <div style="background: #fff3cd; border: 2px solid #ffc107; border-radius: 8px; padding: 16px 20px; margin: 24px 0;">
    <p style="margin: 0; color: #856404; font-size: 16px; line-height: 1.6;"><strong>⚠️ Important Note:</strong> Critical information that readers must know, explained in detail with context and implications.</p>
  </div>
  
  <div style="background: #d1ecf1; border-left: 4px solid #17a2b8; padding: 16px 20px; margin: 20px 0; border-radius: 4px;">
    <p style="margin: 0; color: #0c5460; font-size: 16px;"><strong>ℹ️ Did You Know?</strong> Interesting fact or statistic with explanation and relevance to the topic.</p>
  </div>

✓ SPACING - Create visual breathing room:
  • Use margin-bottom: 16-24px between paragraphs
  • Use margin-top: 32-40px before major h2 sections
  • Add margin: 24px 0 around blockquotes and special elements

📐 DETAILED STRUCTURE REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Opening Section (150-200 words):
  • Compelling hook that grabs attention
  • Context and relevance to the reader
  • Preview of what the article covers

✓ Each Major Section (${config.paragraphsPerSection} per section):
  • Opening paragraph introducing the section topic
  • ${config.subsections} with detailed explanations
  • Mix of paragraphs, lists, and blockquotes
  • Real examples, case studies, or scenarios
  • Smooth transitions to next section

✓ Conclusion Section (150-200 words):
  • Summary of key points
  • Actionable takeaways
  • Call-to-action or next steps

🎭 CONTENT DEPTH & QUALITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Every section must provide REAL VALUE - no fluff or filler
✓ Include specific examples, case studies, or real-world scenarios
✓ Use concrete numbers, data points, or statistics when relevant
✓ Make it actionable - readers should know what to DO with the information
✓ Vary sentence length and structure for engaging rhythm
✓ Use active voice and conversational yet professional tone
✓ Match energy level to the "${category}" category
✓ Provide detailed explanations, not surface-level information
✓ Each paragraph should advance the reader's understanding significantly

🚫 CRITICAL PROHIBITIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━
✗ NEVER mention or reference source URLs in the article content
✗ NEVER include phrases like "According to [source]" or "Source: [URL]"
✗ NO markdown formatting (no ##, **, or markdown code blocks)
✗ NO code block wrappers around the HTML
✗ NO introductory phrases like "Here's the article" or "Below is..."
✗ NO generic, fluffy content - every sentence must add value
✗ NO short, superficial paragraphs - write substantial content
✗ DO NOT skimp on word count - meet the ${config.wordCount} target

📏 OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━
✓ Return ONLY clean HTML with inline CSS styles
✓ Start immediately with your first <h2> or compelling intro paragraph
✓ Ensure ALL tags are properly closed
✓ Include at least one <h2> AND multiple <p> tags (required for validation)
✓ Every element should have inline styles for visual appeal
✓ WRITE LONG, DETAILED CONTENT - aim for ${config.wordCount}`;

  if (sources && sources.length > 0) {
    console.log(`Adding sources section to prompt: ${JSON.stringify(sources)}`);
    prompt += `\n\n📚 REFERENCE SOURCES (FOR FACTUAL ACCURACY ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The following sources have been provided for factual verification and accuracy:

${sources.map((url, i) => `${i + 1}. ${url}`).join('\n')}

🔍 SOURCE USAGE GUIDELINES:
- Use these sources to verify facts, statistics, and technical accuracy
- Extract key insights and synthesize information in your own words
- Add depth and credibility by incorporating facts from these sources
- NEVER mention these URLs in your article content
- NEVER write phrases like "according to this source" or "as stated in..."
- Treat the sources as background research - invisible to readers
- If using statistics or data from sources, present them naturally without attribution`;
  }

  prompt += `\n\n🎯 FINAL REMINDER FOR ${style.toUpperCase()} ARTICLE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are creating a ${style.toUpperCase()} article with a target of ${config.wordCount}.

MANDATORY REQUIREMENTS:
- ${config.sections} with ${config.subsections} each
- ${config.paragraphsPerSection} per major section
- Each paragraph: 60-100 words with detailed explanations
- Lists with ${config.listItems}, each 30-50 words
- ${config.blockquotes} throughout the article
- NO SHORTCUTS - write comprehensive, detailed content

Write ${config.description} coverage that truly educates and engages readers.
Take a deep breath, plan your structure, and create an AMAZING, LENGTHY article! 🚀`;

  console.log(`System prompt length: ${prompt.length} characters`);
  console.log('--- BUILD SYSTEM PROMPT END ---');
  
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
