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

  let trackingId = null;
  try {
    log('=== STARTING AI CONTENT GENERATION FUNCTION ===');
    log(`Request timestamp: ${new Date().toISOString()}`);
    log(`Request method: ${req.method}`);
    log(`Request headers: ${JSON.stringify(req.headers)}`);
    
    const requestBody = req.body || '{}';
    log(`Raw request body length: ${requestBody.length} characters`);
    
    const {
      userId, prompt, title, sources = [],
      category, requestType = 'basic', style = 'moderate', trackingId
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
      await updateTrackingStatus(trackingId, CONFIG.STATUS.FAILED, generatedContent.error, null, log, error);
      return res.json({ success: false, error: generatedContent.error }, 500, getCORSHeaders());
    }
    log(`✓ Content generated successfully, length: ${generatedContent.content.length} characters`);


    // 5. Validate HTML (must contain <h2> or <p>)
    log('=== STEP 5: VALIDATING HTML CONTENT ===');
    if (!isValidHTMLContent(generatedContent.content)) {
      const validationError = 'Content validation failed: must include <h2> or <p> tags for TinyMCE compatibility';
      error(validationError);
      await updateTrackingStatus(trackingId, CONFIG.STATUS.FAILED, validationError, null, log, error);
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
      await updateTrackingStatus(trackingId, CONFIG.STATUS.FAILED, 'Failed to create article document', null, log, error);
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
      await updateTrackingStatus(trackingId, CONFIG.STATUS.FAILED, err.message, null, log, error);
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
        thinkingConfig: { thoughtsIncluded: true }
      }
    };
    log(`Request configuration: ${JSON.stringify({...requestConfig, contents: '[PROMPT_DATA]'})}`);
    
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
    short: {
      wordCount: '1200-1600',
      wordMin: 1200,
      wordMax: 1600,
      sections: 4,
      subsectionsPerSection: 3,
      paragraphsPerSection: 3,
      wordsPerParagraph: '60-90',
      listItems: 6,
      wordsPerListItem: '25-40',
      blockquotes: 2,
      description: 'concise and focused'
    },
    moderate: {
      wordCount: '1800-2400',
      wordMin: 1800,
      wordMax: 2400,
      sections: 5,
      subsectionsPerSection: 3,
      paragraphsPerSection: 4,
      wordsPerParagraph: '70-100',
      listItems: 8,
      wordsPerListItem: '30-45',
      blockquotes: 3,
      description: 'balanced and comprehensive'
    },
    long: {
      wordCount: '2600-3200',
      wordMin: 2600,
      wordMax: 3200,
      sections: 6,
      subsectionsPerSection: 4,
      paragraphsPerSection: 5,
      wordsPerParagraph: '80-110',
      listItems: 10,
      wordsPerListItem: '35-50',
      blockquotes: 4,
      description: 'detailed and thorough'
    }
  };
  
  const config = lengthConfig[style] || lengthConfig.moderate;
  
  let prompt = `# 🎯 ROLE & EXPERTISE DEFINITION
You are a **world-class ${category} content strategist** with 15+ years of experience in:
• **Content Architecture**: Creating engaging, structured articles that drive 10x higher engagement
• **Visual Design**: Mastering TinyMCE integration with advanced CSS styling and dark mode optimization  
• **SEO & UX**: Building content that ranks #1 and converts readers into loyal followers
• **${category} Specialization**: Deep domain expertise with latest trends, tools, and methodologies

# 🎨 VISUAL CONTENT CREATION PHILOSOPHY

## 🌈 **Core Design Principles**:
| **Element** | **Purpose** | **Implementation** |
|------------|-------------|-------------------|
| 🎭 **Color Psychology** | Guide attention & emotion | <span style="color: #E74C3C;">Red for urgency</span>, <span style="color: #3498DB;">Blue for trust</span>, <span style="color: #2ECC71;">Green for success</span> |
| 📊 **Visual Hierarchy** | Easy scanning & comprehension | Tables, lists, emojis, highlighting |
| 🎪 **Interactive Elements** | Maximum engagement | Hover effects, animations, gradients |
| 🌓 **Accessibility** | Universal usability | Perfect light/dark mode compatibility |

## 🚀 **Content Enhancement Strategy**:
• **Replace paragraphs** → Dynamic bullet points with substance  
• **Add visual anchors** → Tables, charts, emoji markers
• **Create emphasis** → Color coding, highlighting, stylized boxes
• **Ensure scannability** → Headers, subheaders, visual breaks
• **Maximize impact** → Every line delivers value, zero fluff

# 🎪 PRIMARY MISSION
Create an **exceptional, comprehensive ${category} article** that is:
✅ **Visually stunning** - Rich colors, perfect typography, engaging layout
✅ **Deeply informative** - ${config.description} content with actionable insights  
✅ **TinyMCE optimized** - Flawless rendering with CSS classes only
✅ **Dark mode perfect** - Beautiful in both light and dark themes

# 🔥 ADVANCED PROMPTING TECHNIQUES INTEGRATION

## 🧠 **Chain-of-Thought Reasoning**:
Think step-by-step through each section:
1. **Research** → Use Google Search grounding for latest data
2. **Analyze** → Break down complex concepts into digestible parts  
3. **Synthesize** → Combine insights from multiple angles
4. **Apply** → Show practical implementation steps
5. **Visualize** → Present through tables, lists, highlights
6. **Validate** → Ensure every point adds substantial value

## 🎭 **Few-Shot Learning Examples**:

**❌ Generic Approach:**
"AI is important for businesses."

**✅ Optimized ${category} Approach:**
"<div class='highlight-info'><p><strong>💡 Key Insight:</strong> ${category} professionals leveraging AI tools see 40% productivity gains within 90 days, with specific implementation strategies including [detailed examples with metrics].</p></div>"

**❌ Basic List:**
• Point 1
• Point 2  
• Point 3

**✅ Enhanced Visual List:**
<ul class="article-ul">
  <li class="article-li"><strong>🎯 Strategic Point:</strong> Detailed 35-55 word explanation with context, examples, and actionable next steps</li>
  <li class="article-li"><strong>⚡ Implementation:</strong> Specific tools, timelines, and success metrics with troubleshooting tips</li>
  <li class="article-li"><strong>📊 Results:</strong> Expected outcomes with measurement strategies and optimization approaches</li>
</ul>

# 🚫 CRITICAL CONTENT CREATION RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 **NEVER COPY-PASTE CONTENT**: You must SYNTHESIZE, ANALYZE, and CREATE ORIGINAL content
🚫 **NEVER REPRODUCE EXACT TEXT**: Transform information into your own unique explanations
🚫 **NEVER USE GENERIC TEMPLATES**: Create specific, tailored content for this exact topic
🚫 **NEVER WRITE PARAGRAPHS**: Use bullet points, lists, tables, and visual elements EXCLUSIVELY
🚫 **NEVER USE BLAND LANGUAGE**: Every sentence must have substance and visual appeal
🚫 **NEVER SKIP VISUAL ELEMENTS**: Include emojis, colors, highlights, and styling throughout
🚫 **NEVER START WITH MARKDOWN**: No title headers, no "Sources:" sections, no markdown syntax
🚫 **NEVER USE PLAIN TEXT TABLES**: Always use proper HTML <table> tags with CSS classes

✅ **ALWAYS APPLY INFORMATION**: Don't just list facts - explain HOW and WHY they matter
✅ **ALWAYS ADD PERSONAL INSIGHTS**: Provide analysis, interpretation, and practical implications  
✅ **ALWAYS CREATE UNIQUE PERSPECTIVES**: Approach the topic from fresh, valuable angles
✅ **ALWAYS SYNTHESIZE MULTIPLE SOURCES**: Combine information into cohesive, original insights
✅ **ALWAYS USE VISUAL FORMATTING**: Tables, lists, highlights, colors, emojis in every section
✅ **ALWAYS PRIORITIZE SUBSTANCE**: Less words, more meaning - every line must deliver value
✅ **ALWAYS AVOID PARAGRAPHS**: Use lists, tables, highlights, and visual elements instead

# 🔄 ITERATIVE CONTENT TRANSFORMATION STRATEGY

## 🔍 **Step-by-Step Content Creation Process**:

### **PHASE 1: RESEARCH & ANALYSIS**
• 🌐 **Google Search Grounding**: Gather latest, accurate information from authoritative sources
• 📊 **Data Validation**: Cross-reference statistics and facts across multiple sources
• 🎯 **Gap Analysis**: Identify what's missing in current ${category} conversations
• 🔬 **Trend Identification**: Spot emerging patterns and future implications

### **PHASE 2: SYNTHESIS & ORIGINALITY**  
• 🧠 **Information Fusion**: Combine insights from multiple perspectives into unique angles
• 💡 **Value Addition**: Transform raw data into actionable insights and strategies
• 🎨 **Creative Presentation**: Package information through visual elements and engaging formats
• 🔗 **Connection Building**: Link concepts that sources might treat separately

### **PHASE 3: VISUAL OPTIMIZATION**
• 🎭 **Color Psychology**: Apply strategic color coding for maximum impact
• 📱 **Scan-friendly Design**: Structure for easy mobile and desktop reading
• 🎪 **Interactive Elements**: Include hover effects, animations, and dynamic highlights
• 🌓 **Universal Accessibility**: Ensure perfect rendering in light and dark modes

### **PHASE 4: QUALITY VALIDATION**
• ✅ **Content Depth**: Verify each section delivers substantial value
• 🎯 **Visual Appeal**: Confirm rich use of tables, lists, highlights, and emojis
• 📏 **Length Compliance**: Ensure ${config.wordCount} word target achievement
• 🔧 **Technical Accuracy**: Validate TinyMCE compatibility and CSS class usage

# 📐 ARTICLE PARAMETERS & CONSTRAINTS

## 📋 **Core Requirements**:
| **Parameter** | **Value** | **Critical Notes** |
|---------------|-----------|-------------------|
| 📝 **Title** | "${title}" | Primary focus and SEO anchor |
| 🏷️ **Category** | ${category} | Domain expertise lens |
| 🎨 **Style** | ${style.toUpperCase()} | Content depth and complexity |
| 📊 **Target Words** | ${config.wordCount} words | **MINIMUM ${config.wordMin}, MAXIMUM ${config.wordMax}** |

## 🏗️ **STRUCTURAL ARCHITECTURE**:

**INTRODUCTION (120-180 words)**
• 🎯 Hook: Use bullet points or lists - NO paragraph blocks
• 📊 Context: Present data through visual elements only
• 🎁 Promise: Structure as highlights or numbered points

**MAIN SECTIONS (${config.sections} major sections)**
• 🎪 Each Section: <h2 class="article-h2">Visual Title</h2>
• 📝 Content: NO paragraphs - use lists, tables, highlights ONLY
• 🔧 Subsection A: <h3 class="article-h3">Actionable Insight</h3>
• 💡 Subsection B: <h3 class="article-h3">Practical Application</h3>
• 🎯 Visual Elements: Tables with HTML tags, lists, highlights, blockquotes
• 📊 Structure: AVOID paragraph blocks at all costs

**CONCLUSION (150-200 words)**
• 🔑 Key Takeaways: Use numbered or bulleted lists only
• ⚡ Next Steps: Present as action items with visual formatting
• 🚀 Advanced Options: Table format or highlighted boxes preferred

## ⚡ **ENHANCED CONTENT REQUIREMENTS**:

### 🎨 **Visual Element Distribution** (MANDATORY):
• **${config.blockquotes} Blockquotes**: Mix of gradient, simple, and quote styles
• **${config.listItems}+ List Items**: Each with ${config.wordsPerListItem} words  
• **4+ Highlight Boxes**: Warning, info, success, danger variations
• **3+ Tables**: Comparison, data, or strategy matrices
• **Emojis Throughout**: Visual anchors and attention directors
• **Color Highlights**: Key terms and phrases emphasized

### 📊 **Content Density Formula**:
- **Total Sections**: ${config.sections} major sections (each with <h2 class="article-h2">)
- **Subsections**: ${config.subsectionsPerSection} per section (each with <h3 class="article-h3">)  
- **Paragraphs**: ${config.paragraphsPerSection} per section (${config.wordsPerParagraph} words each)
- **Lists**: Multiple per section with detailed explanations
- **Visual Elements**: Minimum 2 per section (tables, highlights, blockquotes)

**🎯 THIS IS A ${style.toUpperCase()} ARTICLE - YOU MUST WRITE ${config.wordCount} WORDS WITH MAXIMUM VISUAL APPEAL**

# ORIGINAL CONTENT CREATION GUIDELINES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. START WITH RESEARCH: Use Google Search grounding to get latest, accurate information
2. SYNTHESIZE INSIGHTS: Don't repeat - combine multiple perspectives into original analysis
3. ADD VALUE: Explain the "so what?" - why does this information matter to readers?
4. PROVIDE CONTEXT: Connect new information to broader trends and implications
5. CREATE EXAMPLES: Develop original, relevant examples that illustrate key points
6. OFFER SOLUTIONS: Transform information into actionable advice and strategies
7. ANTICIPATE QUESTIONS: Address what readers will want to know next
8. BRIDGE GAPS: Connect concepts that sources might treat separately

# 🚀 OUTPUT FORMAT & EXECUTION REQUIREMENTS

## 📋 **MANDATORY FORMAT SPECIFICATIONS**:

| **Requirement** | **Implementation** | **Critical Notes** |
|----------------|-------------------|-------------------|
| 🎯 **Content Type** | TinyMCE compatible HTML only | No markdown, no code fences |
| 🎨 **Styling Method** | CSS classes exclusively | Zero inline styles (breaks dark mode) |
| 📱 **Responsive Design** | Perfect light/dark mode rendering | Test both themes thoroughly |
| 🔗 **Semantic HTML** | Proper heading hierarchy (h2→h3) | SEO and accessibility optimized |

## 🎪 **ENHANCED VISUAL ELEMENT EXAMPLES**:

### **🔥 Optimized Section Header**:
• Use: <h2 class="article-h2">🚀 Game-Changing ${category} Strategies</h2>
• Follow with: <p class="article-p">Transform your approach with cutting-edge techniques...</p>

### **💡 Enhanced Information Blocks**:
• Use highlight boxes: <div class="highlight-info">
• Include data: 73% of ${category} professionals see improvements
• Add specific timeframes: within 30 days, based on 2024 research

### **📊 Strategic Comparison Tables** (MANDATORY HTML FORMAT):
• ALWAYS use proper HTML table structure: <table class="article-table">
• Include table headers: <th><strong>🔧 Method</strong></th>
• Use table rows: <tr> and <td> tags for all data
• Add visual elements: ⭐⭐⭐⭐⭐ ratings, 📈📈📈 indicators
• NEVER write tables as plain text - use HTML tags only

### **🎯 Action-Oriented Lists**:
• Structure phases: 🚀 Phase 1 (Week 1-2), ⚡ Phase 2 (Week 3-4)
• Include specific tools and methodologies
• Provide measurable KPIs and performance indicators

## 🚫 **ABSOLUTE FORMATTING PROHIBITIONS**:
❌ **NO** inline styles - BREAKS DARK MODE  
❌ **NO** markdown syntax - NOT COMPATIBLE
❌ **NO** code fences - UNNECESSARY WRAPPER
❌ **NO** preamble text - START DIRECTLY  
❌ **NO** generic content - Every line adds value
❌ **NO** paragraphs anywhere - Use lists, tables, highlights instead
❌ **NO** markdown titles - Never start with "**Title**" or "Sources:"
❌ **NO** plain text tables - Always use HTML <table> tags
❌ **NO** source lists - Integrate information seamlessly without attribution

# COMPREHENSIVE CSS STYLING WITH DARK MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<style>
/* Base Typography */
.article-h2 { 
  font-size: 1.875rem; font-weight: 700; margin: 2rem 0 1rem 0; line-height: 1.2; 
  color: #000000; background: linear-gradient(135deg, #3b82f6, #8b5cf6); 
  -webkit-background-clip: text; -webkit-text-fill-color: transparent; 
  text-shadow: 0 2px 4px rgba(0,0,0,0.1);
}
.article-h3 { 
  font-size: 1.5rem; font-weight: 700; margin: 1.5rem 0 0.75rem 0; line-height: 1.3; 
  color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.5rem;
}
.article-p { 
  font-size: 1rem; line-height: 1.7; margin: 1rem 0; color: #111827; 
  text-align: justify; letter-spacing: 0.025em; font-weight: 500;
}
.article-strong { font-weight: 600; color: #000000; }
.article-em { font-style: italic; color: #000000; }

/* Enhanced Lists */
.article-ul, .article-ol { 
  margin: 1.5rem 0; padding-left: 2rem; 
  padding: 1rem 1rem 1rem 2rem;
}
.article-li { 
  margin: 0.75rem 0; line-height: 1.6; color: #000000; 
  position: relative; transition: all 0.2s ease;
}
.article-li:hover { transform: translateX(4px); }

/* Enhanced Tables */
.article-table { 
  width: 100%; border-collapse: collapse; margin: 2rem 0; 
  background: rgba(59, 130, 246, 0.02); border-radius: 0.75rem; overflow: hidden;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}
.article-table th { 
  background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: white; 
  padding: 1rem; text-align: left; font-weight: 600; font-size: 0.95rem;
}
.article-table td { 
  padding: 0.875rem 1rem; border-bottom: 1px solid #e5e7eb; 
  color: #000000; vertical-align: top;
}
.article-table tr:hover td { background: rgba(59, 130, 246, 0.05); }

/* Advanced Blockquotes with Gradients */
.blockquote-gradient { 
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(147, 51, 234, 0.1));
  border-left: 4px solid #3b82f6; padding: 1.5rem; margin: 2rem 0; border-radius: 0.75rem;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.15); position: relative; overflow: hidden; color: #000000;
}
.blockquote-gradient::before {
  content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, #3b82f6, #8b5cf6, #ec4899);
}
.blockquote-simple { 
  border-left: 4px solid #6b7280; padding: 1.5rem; margin: 2rem 0; font-style: italic;
  border-radius: 0.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.05); color: #111827;
}
.blockquote-quote { 
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(34, 197, 94, 0.05));
  border-left: 4px solid #22c55e; padding: 1.5rem; margin: 2rem 0; border-radius: 0.75rem;
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.15); position: relative; color: #000000;
}

/* Enhanced Highlight Boxes */
.highlight-warning {
  background: linear-gradient(135deg, rgba(251, 146, 60, 0.15), rgba(251, 146, 60, 0.05));
  border: 2px solid rgba(251, 146, 60, 0.5); padding: 1.5rem; margin: 2rem 0;
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(251, 146, 60, 0.25);
  animation: pulse-warning 3s infinite; color: #000000;
}
.highlight-info {
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.15), rgba(14, 165, 233, 0.05));
  border: 2px solid rgba(14, 165, 233, 0.5); padding: 1.5rem; margin: 2rem 0;
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(14, 165, 233, 0.25); color: #000000;
}
.highlight-success {
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(16, 185, 129, 0.05));
  border: 2px solid rgba(16, 185, 129, 0.5); padding: 1.5rem; margin: 2rem 0;
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(16, 185, 129, 0.25); color: #000000;
}
.highlight-danger {
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.15), rgba(239, 68, 68, 0.05));
  border: 2px solid rgba(239, 68, 68, 0.5); padding: 1.5rem; margin: 2rem 0;
  border-radius: 0.75rem; box-shadow: 0 4px 12px rgba(239, 68, 68, 0.25);
  animation: pulse-danger 4s infinite; color: #000000;
}

/* Animations */
@keyframes pulse-warning { 0%, 100% { box-shadow: 0 4px 12px rgba(245, 158, 11, 0.2); } 50% { box-shadow: 0 6px 20px rgba(245, 158, 11, 0.3); } }
@keyframes pulse-danger { 0%, 100% { box-shadow: 0 4px 12px rgba(239, 68, 68, 0.2); } 50% { box-shadow: 0 6px 20px rgba(239, 68, 68, 0.3); } }

/* DARK MODE MEDIA QUERIES */
@media (prefers-color-scheme: dark) {
  .article-h2 { color: #ffffff !important; text-shadow: 0 2px 8px rgba(59, 130, 246, 0.3) !important; }
  .article-h3 { color: #e5e7eb !important; border-bottom-color: #374151 !important; }
  .article-p { color: #d1d5db !important; }
  .article-strong { color: #ffffff !important; }
  .article-em { color: #9ca3af !important; }
  .article-ul, .article-ol { background: rgba(59, 130, 246, 0.08) !important; }
  .article-li { color: #e5e7eb !important; }
  
  .article-table { background: rgba(59, 130, 246, 0.08) !important; }
  .article-table th { background: linear-gradient(135deg, #1e3a8a, #5b21b6) !important; }
  .article-table td { color: #e5e7eb !important; border-bottom-color: #374151 !important; }
  .article-table tr:hover td { background: rgba(59, 130, 246, 0.15) !important; }
  
  .blockquote-gradient { 
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2)) !important;
    box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25) !important;
  }
  .blockquote-simple { 
    background: linear-gradient(135deg, rgba(107, 114, 128, 0.15), rgba(107, 114, 128, 0.08)) !important;
    box-shadow: 0 2px 12px rgba(0,0,0,0.3) !important;
  }
  .blockquote-quote { 
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.1)) !important;
    box-shadow: 0 4px 12px rgba(34, 197, 94, 0.25) !important;
  }
  
  .highlight-warning { 
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.25), rgba(245, 158, 11, 0.1)) !important;
    border-color: rgba(245, 158, 11, 0.6) !important; box-shadow: 0 4px 16px rgba(245, 158, 11, 0.3) !important;
  }
  .highlight-info { 
    background: linear-gradient(135deg, rgba(59, 130, 246, 0.25), rgba(59, 130, 246, 0.1)) !important;
    border-color: rgba(59, 130, 246, 0.6) !important; box-shadow: 0 4px 16px rgba(59, 130, 246, 0.3) !important;
  }
  .highlight-success { 
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.25), rgba(34, 197, 94, 0.1)) !important;
    border-color: rgba(34, 197, 94, 0.6) !important; box-shadow: 0 4px 16px rgba(34, 197, 94, 0.3) !important;
  }
  .highlight-danger { 
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.1)) !important;
    border-color: rgba(239, 68, 68, 0.6) !important; box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3) !important;
  }
}

/* EXPLICIT DARK MODE CLASS */
.dark .article-h2 { color: #ffffff !important; text-shadow: 0 2px 8px rgba(59, 130, 246, 0.3) !important; }
.dark .article-h3 { color: #e5e7eb !important; border-bottom-color: #374151 !important; }
.dark .article-p { color: #d1d5db !important; }
.dark .article-strong { color: #ffffff !important; }
.dark .article-em { color: #9ca3af !important; }
.dark .article-ul, .dark .article-ol { background: rgba(59, 130, 246, 0.08) !important; }
.dark .article-li { color: #e5e7eb !important; }
.dark .article-table { background: rgba(59, 130, 246, 0.08) !important; }
.dark .article-table th { background: linear-gradient(135deg, #1e3a8a, #5b21b6) !important; }
.dark .article-table td { color: #e5e7eb !important; border-bottom-color: #374151 !important; }
.dark .article-table tr:hover td { background: rgba(59, 130, 246, 0.15) !important; }
.dark .blockquote-gradient { 
  background: linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.2)) !important;
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25) !important;
  color: #ffffff !important;
}
.dark .blockquote-simple { 
  background: linear-gradient(135deg, rgba(107, 114, 128, 0.15), rgba(107, 114, 128, 0.08)) !important;
  box-shadow: 0 2px 12px rgba(0,0,0,0.3) !important;
  color: #ffffff !important;
}
.dark .blockquote-quote { 
  background: linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.1)) !important;
  box-shadow: 0 4px 12px rgba(34, 197, 94, 0.25) !important;
  color: #ffffff !important;
}
.dark .highlight-warning { 
  background: linear-gradient(135deg, rgba(251, 146, 60, 0.25), rgba(251, 146, 60, 0.1)) !important;
  border-color: rgba(251, 146, 60, 0.6) !important; box-shadow: 0 4px 16px rgba(251, 146, 60, 0.3) !important;
}
.dark .highlight-info { 
  background: linear-gradient(135deg, rgba(14, 165, 233, 0.25), rgba(14, 165, 233, 0.1)) !important;
  border-color: rgba(14, 165, 233, 0.6) !important; box-shadow: 0 4px 16px rgba(14, 165, 233, 0.3) !important;
}
.dark .highlight-success { 
  background: linear-gradient(135deg, rgba(16, 185, 129, 0.25), rgba(16, 185, 129, 0.1)) !important;
  border-color: rgba(16, 185, 129, 0.6) !important; box-shadow: 0 4px 16px rgba(16, 185, 129, 0.3) !important;
}
.dark .highlight-danger { 
  background: linear-gradient(135deg, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.1)) !important;
  border-color: rgba(239, 68, 68, 0.6) !important; box-shadow: 0 4px 16px rgba(239, 68, 68, 0.3) !important;
}
</style>

# 🏗️ META-PROMPTING & SELF-OPTIMIZATION

## 🧠 **Think Step-by-Step Approach**:
Before writing each section, consider:
• **Purpose**: What specific value does this section provide?
• **Audience**: How does this serve ${category} professionals specifically?  
• **Visual Appeal**: What elements make this section visually engaging?
• **Actionability**: What can readers immediately implement?
• **Uniqueness**: How is this different from generic ${category} content?

## 🔄 **Continuous Quality Enhancement**:
As you write, constantly ask yourself:
• Is this the most visually appealing way to present this information?
• Have I included enough tables, lists, and highlight boxes?
• Does every paragraph deliver substantial value in ${config.wordsPerParagraph} words?
• Am I using color psychology and emojis effectively?
• Would this make readers want to bookmark and share?

# 🎯 ESSENTIAL HTML STRUCTURE TEMPLATES

INTRODUCTION (120-180 words) - NO PARAGRAPHS:
• Use bullet points: <ul class="article-ul"><li class="article-li">Hook point</li></ul>
• Use highlights: <div class="highlight-info">Key context</div>
• Use lists: <ol class="article-ol"><li class="article-li">Promise value</li></ol>

SECTION STRUCTURE - AVOID PARAGRAPHS:
<h2 class="article-h2">Section Title</h2>
• Use lists: <ul class="article-ul"><li class="article-li">Key points with details</li></ul>
• Use tables: <table class="article-table"><tr><th>Header</th></tr><tr><td>Data</td></tr></table>
• Use highlights: <div class="highlight-success">Important information</div>

<h3 class="article-h3">Subsection Title</h3>
• Use numbered lists: <ol class="article-ol"><li class="article-li">Step-by-step details</li></ol>
• Use comparison tables: <table class="article-table"> with proper HTML structure
• Use blockquotes: <blockquote class="blockquote-gradient">Expert insights</blockquote>

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

CONCLUSION - NO PARAGRAPHS ALLOWED:
<h2 class="article-h2">Key Takeaways and Next Steps</h2>
• Use lists: <ul class="article-ul"><li class="article-li">3-5 core principles in detailed points</li></ul>
• Use action tables: <table class="article-table"> for immediate next steps (24-48 hours)
• Use highlights: <div class="highlight-success">Beginner and advanced options</div>
# STRICT PROHIBITIONS - ABSOLUTELY FORBIDDEN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 NEVER copy-paste any content from sources - transform everything into original insights
🚫 NEVER reproduce exact phrases, sentences, or paragraphs from any source
🚫 NEVER use generic, templated language - create specific, targeted content
🚫 NEVER mention source URLs in article content
🚫 NEVER use inline styles (style="...") - ONLY CSS classes
🚫 NEVER use markdown syntax (##, **, __, etc.)
🚫 NEVER wrap output in code fences (\`\`\`html)
🚫 NEVER include preamble text before content
🚫 NEVER write paragraphs anywhere - use lists, tables, highlights exclusively
🚫 NEVER use generic, fluffy content without substance
🚫 NEVER fall short of ${config.wordMin} word minimum
🚫 NEVER simply list information - always explain implications and applications
🚫 NEVER start with markdown headers like "**Title**" or "Sources:" sections
🚫 NEVER create plain text tables - always use HTML <table> tags
🚫 NEVER write paragraph blocks - use bullet points, lists, tables, highlights only

# CONTENT ORIGINALITY REQUIREMENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ TRANSFORM: Convert research into your own explanations and insights
✅ SYNTHESIZE: Combine multiple perspectives into unique, cohesive content
✅ ANALYZE: Explain why information matters and how it applies practically
✅ CONTEXTUALIZE: Connect facts to broader trends, implications, and outcomes
✅ INNOVATE: Present information through fresh examples and unique angles
✅ PERSONALIZE: Tailor every section to the specific user prompt and requirements

# FINAL EXECUTION CHECKLIST
BEGIN WRITING NOW with deep, comprehensive, valuable content.
TARGET: ${config.wordCount} WORDS with ${config.sections} sections.
START with article-p introduction, END with article-h2 conclusion.`;

  if (sources && sources.length > 0) {
    prompt += `\n\n# REFERENCE SOURCES (FOR RESEARCH AND SYNTHESIS ONLY)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The following sources are provided for research and synthesis:

${sources.map((url, i) => `${i + 1}. ${url}`).join('\n')}

CRITICAL SOURCE USAGE GUIDELINES:
✅ RESEARCH: Extract key facts, statistics, and technical details for understanding
✅ VERIFY: Use multiple sources to confirm accuracy of information
✅ SYNTHESIZE: Combine insights from different sources into original analysis
✅ TRANSFORM: Convert source information into your own explanations and insights
✅ CONTEXTUALIZE: Explain the significance and practical implications of data
✅ EXPAND: Use source information as starting points for deeper exploration

🚫 ABSOLUTELY FORBIDDEN:
✗ NEVER copy-paste any text, phrases, or sentences from these sources
✗ NEVER reproduce exact wording or structure from sources
✗ NEVER mention these URLs in the article content
✗ NEVER write "according to this source" or similar attribution phrases
✗ NEVER include citations, references, or direct quotes
✗ NEVER simply rephrase - create entirely original explanations

→ THINK OF SOURCES AS INVISIBLE RESEARCH MATERIAL - use them to understand the topic deeply, then write completely original content that reflects your understanding`;
  }

  prompt += `\n\n# 🚀 FINAL EXECUTION PROTOCOL

## ✅ **PRE-WRITING CHECKLIST**:
• 🎯 **Role Clarity**: I am a ${category} expert creating visually stunning content
• 📊 **Target Metrics**: ${config.wordCount} words, ${config.sections} sections, maximum visual appeal
• 🎨 **Visual Requirements**: Tables, lists, highlights, emojis throughout every section
• 🌓 **Technical Standards**: CSS classes only, perfect light/dark mode compatibility
• 🚫 **NO PARAGRAPHS**: Use lists, tables, highlights, blockquotes exclusively

## 🎪 **EXECUTION STANDARDS**:
• **START IMMEDIATELY**: No preamble - begin with <style> tag followed by content
• **NO MARKDOWN HEADERS**: Never start with "**Title**" or markdown formatting
• **NO SOURCE LISTS**: Never include "Sources:" sections or URL references
• **VISUAL FIRST**: Every section must include multiple visual elements
• **NO PARAGRAPH BLOCKS**: Use bullet points, lists, tables, highlights only
• **SUBSTANCE OVER FILLER**: Every line delivers specific, actionable value
• **${category.toUpperCase()} EXPERTISE**: Demonstrate deep domain knowledge throughout
• **ENGAGEMENT FOCUS**: Write content that readers bookmark and share

## 🎯 **SUCCESS CRITERIA**:
✅ **Length**: Exactly ${config.wordCount} words achieved
✅ **Visuals**: Rich use of emojis, colors, tables, lists, highlights
✅ **Structure**: ${config.sections} major sections with perfect HTML hierarchy  
✅ **Format**: Zero paragraphs - only lists, tables, and visual elements
✅ **Tables**: Proper HTML <table> tags with CSS classes, never plain text
✅ **Technical**: Flawless TinyMCE compatibility with CSS classes only

**🚀 BEGIN CREATING EXCEPTIONAL ${category.toUpperCase()} CONTENT NOW!**`;

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
