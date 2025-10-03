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
    short: 30000,
    moderate: 45000,
    long: 60000
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
const client = new Client()
  .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
  .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
  .setKey(process.env.APPWRITE_API_KEY);

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

export default async ({ req, res, log, error }) => {
  let trackingDocId = null;
  try {
    log('Starting enhanced AI content generation');
    const {
      userId, prompt, title, sources = [],
      category, requestType = 'basic', style = 'moderate'
    } = JSON.parse(req.body || '{}');

    if (!userId || !prompt || !title || !category) {
      return res.json({ success: false, error: 'Missing required fields: userId, prompt, title, category' }, 400);
    }
    if (!CONFIG.MAX_OUTPUT_TOKENS[style]) {
      return res.json({ success: false, error: 'Invalid style. Must be short, moderate, or long' }, 400);
    }

    // 1. Check user prefs
    const canProceed = await checkUserPreferences(userId, requestType, log, error);
    if (!canProceed.success) {
      return res.json({ success: false, error: canProceed.error }, 403);
    }

    // 2. Create tracking doc with inprogress + blank error
    const trackingDoc = await createTrackingDocument(
      userId, title, prompt, category, requestType, style, sources, log, error
    );
    if (!trackingDoc.success) {
      return res.json({ success: false, error: 'Failed to create tracking document' }, 500);
    }
    trackingDocId = trackingDoc.documentId;
    
    // 3. Generate content (Gemini)
    let generatedContent = await generateArticleContent(
      prompt, title, sources, category, requestType, style, log, error
    );
    if (!generatedContent.success) {
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, generatedContent.error, null, log, error);
      return res.json({ success: false, error: generatedContent.error }, 500);
    }

    // 4. Ultra → RAG semantic rerank (LangSearch API)
    if (requestType === 'ultra') {
      const rerankRes = await ragRerankWithLangSearch(prompt, generatedContent.content, sources, log, error);
      if (rerankRes.success) {
        generatedContent.content = rerankRes.reranked;
      } else {
        log('LangSearch RAG rerank failed, keeping Gemini output');
        // fallback: keep Gemini output, log error but do not fail outright
      }
    }

    // 5. Validate HTML (must contain <h2> or <p>)
    if (!isValidHTMLContent(generatedContent.content)) {
      const validationError = 'Content validation failed: must include <h2> or <p> tags for TinyMCE compatibility';
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, validationError, null, log, error);
      return res.json({ success: false, error: validationError }, 500);
    }

    // 6. Create article (status: inactive)
    const userDetails = await getUserDetails(userId, log, error);
    const articleDoc = await createArticleDocument(
      userId, title, generatedContent.content, category, sources, userDetails.authorName, log, error
    );
    if (!articleDoc.success) {
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, 'Failed to create article document', null, log, error);
      return res.json({ success: false, error: 'Failed to create article document' }, 500);
    }
    // 7. update tracking (completed, clear error, link postId)
    await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, '', articleDoc.documentId, log, error);
    // 8. decrement quota
    await decrementUserQuota(userId, requestType, log, error);

    log('AI content generation completed successfully');
    return res.json({
      success: true,
      message: 'Article generated successfully',
      trackingId: trackingDocId,
      articleId: articleDoc.documentId
    }, 200);

  } catch (err) {
    error(`Fatal function error: ${err.message}`);
    if (trackingDocId) {
      await updateTrackingStatus(trackingDocId, CONFIG.STATUS.COMPLETED, err.message, null, log, error);
    }
    return res.json({ success: false, error: err.message }, 500);
  }
};

// HTML validation utility
function isValidHTMLContent(html) {
  return /<h2[^>]*>.*?<\/h2>/i.test(html) || /<p[^>]*>.*?<\/p>/i.test(html);
}

// RAG rerank for ultra requests
async function ragRerankWithLangSearch(query, text, urls, log, error) {
  try {
    if (!(query && text && urls && urls.length)) {
      error('RAG rerank: missing required parameters');
      return { success: false };
    }
    log(`Reranking with query: "${query.substring(0, 50)}..."`);
    const response = await fetch(CONFIG.LANGSEARCH.RERANK_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LANGSEARCH_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: query,  // Use the concise prompt/summary instead of full article
        urls: urls,
        maxK: 1
      })
    });
    const data = await response.json();
    if (data?.rerankedPassage) {
      log('RAG rerank successful');
      return { success: true, reranked: data.rerankedPassage };
    }
    error('RAG rerank failed: no rerankedPassage in response');
    return { success: false };
  } catch (err) {
    error(`LangSearch RAG rerank error: ${err.message}`);
    return { success: false };
  }
}

// All other helpers below (unchanged except where noted):

async function checkUserPreferences(userId, requestType, log, error) {
  try {
    log(`Checking prefs for user: ${userId}`);
    const user = await users.getPrefs(userId);
    const usageField = getUsageFieldForRequestType(requestType);
    if (!usageField) {
      error(`Invalid request type: ${requestType}`);
      return { success: false, error: 'Invalid request type.' };
    }
    const remainingUses = user[usageField] || 0;
    if (remainingUses <= 0)
      return { success: false, error: `Insufficient ${requestType} uses.` };
    return { success: true };
  } catch (err) {
    error(`Preference check error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Include error field on create
async function createTrackingDocument(userId, title, prompt, category, requestType, style, sources, log, error) {
  try {
    log('Creating tracking doc');
    const trackingData = {
      userid: userId, title, prompt, category,
      request_type: requestType, style, status: CONFIG.STATUS.IN_PROGRESS,
      sources: sources.length > 0 ? sources.join(',') : '',
      postId: null,
      error: ''
    };
    const document = await databases.createDocument(
      CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.TRACKING,
      ID.unique(), trackingData
    );
    return { success: true, documentId: document.$id };
  } catch (err) {
    error(`Tracking doc error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Now stores error string for every status change
async function updateTrackingStatus(trackingId, status, errorMessage, postId, log, error) {
  try {
    log(`Updating tracking status: ${trackingId} → ${status}`);
    const updateData = { status, error: errorMessage || '' };
    if (postId) updateData.postId = postId;
    await databases.updateDocument(CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.TRACKING, trackingId, updateData);
    log(`Tracking doc updated: ${trackingId}`);
  } catch (err) {
    error(`Tracking status update error: ${err.message}`);
  }
}

// ... (Other helper functions remain as in your current code)
async function getUserDetails(userId, log, error) {
  try {
    const user = await users.get(userId);
    return { authorName: user.name || 'Anonymous' };
  } catch (err) {
    error(`Author lookup error: ${err.message}`);
    return { authorName: 'Anonymous' };
  }
}

async function createArticleDocument(userId, title, content, category, sources, authorName, log, error) {
  try {
    log('Creating article doc');
    const articleData = {
      userid: userId, title, content, category,
      status: 'inactive', authorName,
      featuredimage: ''
    };
    const document = await databases.createDocument(
      CONFIG.DATABASE_ID, CONFIG.COLLECTIONS.ARTICLES, ID.unique(), articleData
    );
    return { success: true, documentId: document.$id };
  } catch (err) {
    error(`Article doc error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ... (Gemini generation logic stays nearly identical)
async function generateArticleContent(prompt, title, sources, category, requestType, style, log, error) {
  try {
    log('Generating content with Gemini');
    const modelName = CONFIG.MODELS[requestType] || CONFIG.MODELS.basic;
    const maxTokens = CONFIG.MAX_OUTPUT_TOKENS[style] || CONFIG.MAX_OUTPUT_TOKENS.moderate;
    const systemPrompt = buildSystemPrompt(title, category, sources);
    const tools = [
      { googleSearch: {} }
    ];
    const completePrompt = buildCompletePrompt(systemPrompt, prompt, sources);
    const response = await ai.models.generateContent({
      model: modelName,
      contents: completePrompt,
      config: {
        tools,
        temperature: 0.7,
        maxOutputTokens: maxTokens,
        thinkingConfig: { thoughtsIncluded: true }
      }
    });
    const generatedText = response.text;
    if (!generatedText || generatedText.trim().length === 0)
      return { success: false, error: 'Generated content is empty' };
    return { success: true, content: generatedText };
  } catch (err) {
    error(`Gemini error: ${err.message}`);
    return { success: false, error: `Failed to generate content: ${err.message}` };
  }
}

// Build prompts
function buildSystemPrompt(title, category, sources) {
  let prompt = `You are an expert content writer creating a comprehensive, engaging blog article.

ARTICLE DETAILS:
- Title: "${title}"
- Category: "${category}"

REQUIREMENTS:
- Write a complete, well-structured article with proper HTML formatting for TinyMCE editor
- Use semantic HTML tags: <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <blockquote>
- MUST include at least one <h2> or <p> tag (required for validation)
- Create engaging, informative content with clear section headings
- Include relevant examples, explanations, and insights
- Write in a professional yet accessible tone
- Ensure proper grammar, spelling, and punctuation

OUTPUT FORMAT:
- Return ONLY the HTML content (no markdown, no code blocks)
- Start directly with content (no "Here's the article" or similar phrases)
- Use proper HTML structure with meaningful semantic tags`;

  if (sources && sources.length > 0) {
    prompt += `\n\nREFERENCE SOURCES:
These sources have been provided for context and factual grounding. Use them to ensure accuracy:
${sources.map((url, i) => `${i + 1}. ${url}`).join('\n')}

Note: Verify facts against these sources but write in your own words. Do not copy content directly.`;
  }

  return prompt;
}

function buildCompletePrompt(systemPrompt, userPrompt, sources) {
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
    contents.push({
      role: 'user',
      parts: [{ text: `SOURCES TO REFERENCE:\n${sources.join('\n')}` }]
    });
  }

  return contents;
}

async function decrementUserQuota(userId, requestType, log, error) {
  try {
    const prefs = await users.getPrefs(userId);
    const usageField = getUsageFieldForRequestType(requestType);
    if (!usageField) return;
    const currentUses = prefs[usageField] || 0;
    const newUses = Math.max(0, currentUses - 1);
    await users.updatePrefs(userId, { ...prefs, [usageField]: newUses });
    log(`User quota updated: ${usageField} = ${newUses}`);
  } catch (err) { error(`Quota decrement error: ${err.message}`); }
}
