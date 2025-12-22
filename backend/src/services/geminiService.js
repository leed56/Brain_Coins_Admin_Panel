/**
 * BACKEND - Gemini AI Service
 * This file contains AI question generation logic using Google's Gemini API
 * Used by backend API controllers
 * DO NOT use this in frontend - this should only run on the server
 */

// Core Node.js modules
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  logGeminiApiError,
  logGeminiParsingError,
  logGeminiValidationError,
  logGeminiRateLimitError
} from './geminiErrorService.js';
// Third-party imports
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

// Local imports
import { downloadAny } from './supabaseStorage.js';

// We'll use dynamic import for pdf-parse to avoid ESM/CommonJS issues

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

/**
 * Detect language from text content using Unicode ranges
 * @param {string} text - Text content to analyze
 * @returns {string} - Detected language: 'English', 'Sinhala', or 'Tamil'
 */
function detectLanguageFromText(text) {
  if (!text || typeof text !== 'string') return 'English';

  // Count characters in each Unicode range
  let sinhalaCount = 0;
  let tamilCount = 0;
  let englishCount = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);

    // Sinhala Unicode range: 0D80-0DFF
    if (code >= 0x0D80 && code <= 0x0DFF) {
      sinhalaCount++;
    }
    // Tamil Unicode range: 0B80-0BFF
    else if (code >= 0x0B80 && code <= 0x0BFF) {
      tamilCount++;
    }
    // English/Latin: 0041-007A (A-Z, a-z)
    else if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) {
      englishCount++;
    }
  }

  // Determine primary language based on character count
  if (sinhalaCount > tamilCount && sinhalaCount > englishCount) {
    return 'Sinhala';
  } else if (tamilCount > sinhalaCount && tamilCount > englishCount) {
    return 'Tamil';
  } else {
    return 'English';
  }
}

/**
 * Extract text from file data based on MIME type
 * @param {string} base64Data - Base64 encoded file data
 * @param {string} mimeType - MIME type of the file
 * @returns {Promise<string>} - Extracted text
 */
async function extractTextFromFile(base64Data, mimeType) {
  try {
    const buffer = Buffer.from(base64Data, 'base64');

    if (mimeType === 'application/pdf') {
      try {
        // Use dynamic import for pdf-parse
        const { default: pdfParse } = await import('pdf-parse');

        // More lenient PDF parsing with better error handling
        const data = await pdfParse(buffer, {
          max: 50, // Increase page limit
          pagerender: render_page, // Custom renderer for better text extraction
          version: 'v1.10.100'
        });

        if (!data.text || !data.text.trim()) {
          console.warn('[Backend Gemini] No text extracted from PDF, trying alternative method');
          // Fallback to simple text extraction
          const simpleText = extractSimpleText(buffer);
          if (simpleText && simpleText.trim()) {
            return simpleText;
          }
          throw new Error('No text content could be extracted from the PDF');
        }

        // More lenient text cleaning
        let cleanedText = data.text
          // Remove null bytes and control characters except newlines and tabs
          .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
          // Normalize whitespace but be more careful
          .replace(/[ \t]+/g, ' ')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        // More lenient content validation for Tamil/Sinhala
        const hasValidContent = /[a-zA-Z\u0D80-\u0DFF\u0B80-\u0BFF\d\s]{20,}/.test(cleanedText);

        if (!hasValidContent) {
          console.warn('[Backend Gemini] PDF may contain images/scanned content, using Vision API fallback');
          throw new Error('PDF appears to be image-based or scanned document');
        }

        return cleanedText;
      } catch (error) {
        console.error('PDF text extraction error:', error);
        // Don't throw here - let the calling function handle fallback
        throw new Error(`PDF may contain scanned content or images: ${error.message}`);
      }
    }

    // For images, use Gemini Vision to extract text
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const result = await model.generateContent({
      contents: [{
        parts: [
          { text: 'Extract all text from this image/document. Return only the raw text, no formatting or additional text. Preserve Tamil/Sinhala characters exactly as they appear.' },
          {
            inlineData: {
              mimeType,
              data: base64Data
            }
          }
        ]
      }]
    });

    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('[Backend Gemini] Error extracting text from file:', error);
    throw new Error(`Failed to extract text from file: ${error.message}`);
  }
}

// Simple text extraction fallback
function extractSimpleText(buffer) {
  try {
    // Convert buffer to string and extract basic text
    const text = buffer.toString('utf-8');
    // Extract text between common PDF text markers
    const textMatches = text.match(/\(([^)]+)\)/g) || [];
    return textMatches.map(match => match.slice(1, -1)).join(' ');
  } catch (e) {
    return null;
  }
}

/**
 * Retries an async function with exponential backoff and jitter.
 * Specifically targets Gemini 503 (Overloaded) and 429 (Rate Limit) errors.
 *
 * @param {Function} fn - The async operation to wrap (e.g., () => model.generateContent(...))
 * @param {Object} options - Configuration options
 * @param {number} options.maxAttempts - Max attempts (default: 5)
 * @param {number} options.baseDelay - Initial delay in ms (default: 2000ms)
 * @param {number} options.maxDelay - Maximum delay cap in ms (default: 32000ms)
 */
const withRetry = async (fn, options = {}) => {
  const {
    maxAttempts = 5,
    baseDelay = 2000, // 2 seconds base delay
    maxDelay = 32000, // 32 seconds max delay
  } = options;

  let attempt = 0;
  let delay = baseDelay;
  let lastError;

  while (attempt < maxAttempts) {
    try {
      // Attempt to execute the function
      return await fn();
    } catch (error) {
      lastError = error;
      attempt++;

      // Check if the error is retryable
      // We look for '503' (Service Unavailable/Overloaded) or '429' (Quota/Rate Limit)
      const isOverloaded = error.message && (error.message.includes('503') || error.message.includes('overloaded'));
      const isRateLimited = error.message && (error.message.includes('429') || error.message.includes('quota'));

      // If it's not a retryable error, throw immediately
      if (!isOverloaded && !isRateLimited) {
        console.error('[Gemini Service] Non-retryable error:', error.message);
        throw error;
      }

      // If we've used all retries, break out of the loop
      if (attempt >= maxAttempts) {
        break;
      }

      // Calculate next delay: Double the previous delay (Exponential)
      // Add "Jitter" (random 0-500ms) to prevent synchronized retries
      const jitter = Math.random() * 500;
      delay = Math.min(delay * 2 + jitter, maxDelay);

      console.warn(
        `[Gemini Service] API Busy (${isOverloaded ? 'Overloaded' : 'Rate Limit'}). ` +
        `Retrying in ${(delay / 1000).toFixed(1)}s... (Attempts left: ${maxAttempts - attempt})`
      );

      // Wait for the calculated delay
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // If we get here, all attempts failed
  console.error(`[Backend Gemini] All ${maxAttempts} attempts failed. Last error:`, lastError);
  if (lastError) {
    await logGeminiApiError(lastError, {
      apiEndpoint: 'withRetry',
      retryAttempt: maxAttempts,
      maxAttempts
    });
  }

  throw lastError || new Error('Max retry attempts reached');
};

/**
 * Generate multiple Learning Packs (one per chapter/section) from a base64 file.
 * Returns an array: [{ title, content, order, language }]
 */
export const generateLearningPacksFromBase64 = async (base64Data, mimeType) => {
  try {
    const timing = {
      precheck: 0,
      gemini: 0,
      repair: 0,
      fallback: 0,
    };

    const isPdf = mimeType === 'application/pdf';

    const isImage = mimeType.startsWith('image/');
    const isDocx = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isDoc = mimeType === 'application/msword';
    const isTxt = mimeType === 'text/plain';

    let prompt = '';
    let textForChapters = '';
    let forceVisionAPI = false;

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    // Pre-check for Sinhala/Tamil content in PDFs - use Vision API if detected
    const tPreStart = Date.now();
    if (isPdf) {
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        const { default: pdfParse } = await import('pdf-parse');
        const quickCheck = await pdfParse(buffer, { max: 3 }); // Check first 3 pages only
        const sampleText = quickCheck.text.substring(0, 5000);

        // Detect if content has Sinhala/Tamil characters
        const hasSinhala = /[\u0D80-\u0DFF]{5,}/.test(sampleText);
        const hasTamil = /[\u0B80-\u0BFF]{5,}/.test(sampleText);

        if (hasSinhala || hasTamil) {
          forceVisionAPI = true;
        }
      } catch (preCheckError) {
        console.warn('[Backend Gemini] Pre-check failed, will use Vision API:', preCheckError.message);
        forceVisionAPI = true;
      }
    }
    const tPreEnd = Date.now();
    timing.precheck = tPreEnd - tPreStart;

    // Helper: sanitize slightly-malformed JSON array text
    const sanitizeJsonArrayString = (raw) => {
      if (!raw || typeof raw !== 'string') return raw;
      let s = raw.trim();
      const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || s.match(/\[[\s\S]*\]/);
      if (m) s = (m[1] || m[0]).trim();
      s = s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
      // Remove control characters except \n, \r, \t
      s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
      s = s.replace(/,\s*(\]|\})/g, '$1');
      const start = s.indexOf('[');
      const end = s.lastIndexOf(']');
      if (start !== -1 && end !== -1) s = s.substring(start, end + 1);
      return s;
    };

    // Local fallback: split plain text into multiple packs
    const splitTextIntoPacks = (text) => {
      const cleaned = String(text || '').replace(/\u0000/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (!cleaned) return [];
      const paragraphs = cleaned.split(/\n\s*\n+/);
      const packs = [];
      let buf = [];
      let chars = 0;
      const targetMin = 1200;
      const targetMax = 2500;
      paragraphs.forEach((p) => {
        const para = p.trim();
        if (!para) return;
        if (chars > 0 && (chars + para.length > targetMax)) {
          const content = buf.join('\n\n');
          const firstLine = content.split('\n')[0] || '';
          const title = (firstLine.length > 8 && firstLine.length < 120) ? firstLine : `Learning Pack ${packs.length + 1}`;
          packs.push({ title, content, order: packs.length + 1, language: 'English' });
          buf = [para];
          chars = para.length;
        } else {
          buf.push(para);
          chars += para.length;
          if (chars >= targetMin) {
            const content = buf.join('\n\n');
            const firstLine = content.split('\n')[0] || '';
            const title = (firstLine.length > 8 && firstLine.length < 120) ? firstLine : `Learning Pack ${packs.length + 1}`;
            packs.push({ title, content, order: packs.length + 1, language: 'English' });
            buf = [];
            chars = 0;
          }
        }
      });
      if (buf.length) {
        const content = buf.join('\n\n');
        const firstLine = content.split('\n')[0] || '';
        const title = (firstLine.length > 8 && firstLine.length < 120) ? firstLine : `Learning Pack ${packs.length + 1}`;
        packs.push({ title, content, order: packs.length + 1, language: 'English' });
      }
      return packs;
    };

    // Local fallback orchestrator
    const localFallbackPacks = async () => {
      try {
        if (isPdf) {
          const { default: PDFParser } = await import('pdf2json');
          const buffer = Buffer.from(base64Data, 'base64');
          const text = await new Promise((resolve, reject) => {
            const pdfParser = new PDFParser(this, 1);
            pdfParser.on('pdfParser_dataError', errData => reject(new Error(errData.parserError)));
            pdfParser.on('pdfParser_dataReady', pdfData => {
              try {
                const pages = pdfData?.Pages || [];
                const parts = [];
                const safeDecode = (s) => {
                  if (typeof s !== 'string') return '';
                  const replaced = s.replace(/\+/g, ' ');
                  try { return decodeURIComponent(replaced); } catch { return replaced; }
                };
                pages.forEach(pg => {
                  (pg.Texts || []).forEach(t => {
                    const str = (t.R || []).map(r => safeDecode(r.T || '')).join('');
                    parts.push(str);
                  });
                  parts.push('\n\n');
                });
                resolve(parts.join(' '));
              } catch (e) {
                reject(e);
              }
            });
            pdfParser.parseBuffer(buffer);
          });
          const packs = splitTextIntoPacks(text);
          if (packs.length) return packs;
        } else if (isDocx) {
          const { default: mammoth } = await import('mammoth');
          const buffer = Buffer.from(base64Data, 'base64');
          const { value } = await mammoth.extractRawText({ buffer });
          const packs = splitTextIntoPacks(value || '');
          if (packs.length) return packs;
        } else if (isTxt) {
          const text = Buffer.from(base64Data, 'base64').toString('utf-8');
          const packs = splitTextIntoPacks(text);
          if (packs.length) return packs;
        }
      } catch (e) {
        console.error('[Backend Gemini] Local fallback error:', e);
      }
      return [{ title: 'Learning Pack 1: Document Content', content: 'Content not available', order: 1, language: 'English' }];
    };

    if (isPdf || isImage || forceVisionAPI) {
      // Use Vision API for images, PDFs, and Sinhala/Tamil content
      const imagePart = { inlineData: { data: base64Data, mimeType } };
      prompt = `🚨🚨🚨 CRITICAL: TAMIL/SINHALA TEXT MUST USE PROPER UNICODE! 🚨🚨🚨

❌❌❌ THESE ARE GARBAGE - NEVER OUTPUT THESE ❌❌❌
Tamil garbage: "¸USP", "©hUøP", "£õh¡À", "C»Á\\", "÷©ØSÔzu", "¨£µ¨£ÍÄ", "Gs÷PõøÁPøÍa"
Sinhala garbage: ";d;aúl", "fkdñ,a fnod", "o¾Yl yd"

✅✅✅ USE ONLY PROPER UNICODE ✅✅✅
Tamil: "கணிதம்", "பாடம்", "பயிற்சி", "விளக்கம்", "கேள்விகள்"
Sinhala: "ගණිතය", "පාඩම", "අභ්‍යාස", "විස්තරය", "ප්‍රශ්න"

If you see Tamil/Sinhala script, you MUST:
1. Use ONLY proper Unicode characters (U+0B80-U+0BFF for Tamil, U+0D80-U+0DFF for Sinhala)
2. Set language field to "Tamil" or "Sinhala" (NOT "English")
3. NO Latin letters mixed with symbols

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

You are an expert educational content creator for the Sri Lankan local syllabus (Grades 6-11) with advanced multilingual capabilities in English, Sinhala, and Tamil.

⚠️ ABSOLUTE RULES - VIOLATION WILL RESULT IN REJECTION:
1. **FIRST**: Check if this is a TABLE OF CONTENTS page - if yes, extract chapter titles ONLY
2. Create ONE learning pack per ACTUAL chapter found in the document
3. Each pack must have a REAL, meaningful title from the document
4. Use ONLY clean Unicode - NO garbage characters, NO corrupted text
5. ALL content must be in the DETECTED language (English/Sinhala/Tamil)
6. DO NOT create a pack for every page - analyze the ENTIRE document structure first
7. If document has 15 chapters, create 15 packs; if 3 chapters, create 3 packs

---

### STEP 0: DOCUMENT STRUCTURE ANALYSIS (DO THIS FIRST!)

🔍 **CRITICAL**: Before creating packs, analyze the ENTIRE document:

**STEP 0.1: Is this a Table of Contents?**
- Look for: "Contents", "Table of Contents", "Index", "පටුන", "අන්තර්ගතය", "உள்ளடக்கம்"
- Check if you see a list of chapter titles with page numbers
- **IMPORTANT**: If you find a TOC, you MUST also scan the REST of the document

**STEP 0.2: TOC VALIDATION (CRITICAL!)**
If you found a Table of Contents:
1. **Count TOC entries**: How many chapters are listed? (e.g., 5 chapters)
2. **Scan remaining pages**: Look through ALL pages after the TOC
3. **Verify chapter presence**: Check if those chapters actually exist in the document
4. **Compare content volume**: 
   - If TOC lists 5 chapters but document has 50+ pages of content → TOC is valid ✅
   - If TOC lists 10 chapters but document only has 3 pages → TOC is INVALID ❌
   - If TOC is just 1 page and rest is blank → TOC is INVALID ❌

**STEP 0.3: Decision Logic**
- **If TOC is VALID** (matches actual document structure):
  → Extract chapter titles from TOC
  → Scan actual content to create meaningful summaries
  → Create packs based on TOC structure
  
- **If TOC is INVALID or INCOMPLETE** (doesn't match document):
  → IGNORE the TOC
  → Analyze the full document content
  → Detect chapters from actual content (not from TOC)
  → Create packs based on what you actually see

**STEP 0.4: Document Type Detection (if no valid TOC):**
1. **Single Chapter Document**: If you see only ONE main topic → Create 1 pack
2. **Multi-Chapter Textbook**: If you see clear chapter divisions → Create 1 pack per chapter (ALL chapters)
3. **Exercise/Worksheet**: If mostly problems/exercises → Create 1 pack summarizing topics
4. **Reference Material**: If dense content without chapters → Create 2-3 thematic packs

⚠️ **NEVER** treat each page as a separate chapter!
⚠️ **ALWAYS** verify TOC against actual document content!
⚠️ **ALWAYS** create packs for ALL actual chapters found (whether 3, 10, 15, or 20 chapters)

---

### STEP 1: CRITICAL - ABSOLUTE UNICODE REQUIREMENT (NO EXCEPTIONS!)

🔴 **CRITICAL ENCODING RULE**: You MUST use PROPER UNICODE encoding. NO corrupted text allowed!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ WARNING: THESE ARE GARBAGE CHARACTERS - NEVER OUTPUT THESE:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ **FORBIDDEN - Tamil Garbage** (ISO-8859-1 encoding errors):
   "¸USP", "©hUøP", "AmhÁønø¯", "£¯ß£kzv", "Gs÷PõøÁPøÍa"
   "_¸UPÀ", "÷Áõ®", "Euõµn[PÎß", "ö\´²®", "Âuzøua"
   "Po¨¦a", "£õh¡À", "C»Á\", "÷©ØSÔzu", "öPõÒ÷Áõ®"
   "A¨÷£õx", "¨£µ¨£ÍÄ", "CønPµ®", "•U÷Põo", "\©õ¢uµU"
   
❌ **FORBIDDEN - Sinhala Garbage** (encoding errors):
   ";d;aúl ixLHd", "o¾Yl yd ,>q.Kl", "fkdñ,a fnod yeÿ"
   "kshu úÿ,s iy t<öu újdyl", "wmkhk ixLHd"

❌ **FORBIDDEN - Mixed/Corrupted**:
   "lg P", "antilog", Any mix of Latin letters with accent marks that don't form real words

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ REQUIRED: PROPER UNICODE OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ **Tamil** (Unicode range U+0B80-U+0BFF):
   Examples: "கணிதம்", "அத்தியாயம்", "பாடம்", "பயிற்சி"
   "இயற்கணிதம்", "வடிவியல்", "எண்கள்", "முறைகள்"
   "விளக்கம்", "கேள்விகள்", "தீர்வு", "சூத்திரம்"
   
✅ **Sinhala** (Unicode range U+0D80-U+0DFF):
   Examples: "ගණිතය", "පරිච්ඡේදය", "පාඩම", "අභ්‍යාස"
   "වීජ ගණිතය", "ජ්‍යාමිතිය", "සංඛ්‍යා", "ක්‍රම"
   "විස්තරය", "ප්‍රශ්න", "විසඳුම", "සූත්‍රය"

✅ **English** (ASCII/Latin):
   Examples: "Mathematics", "Chapter", "Lesson", "Exercise"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 LANGUAGE DETECTION PROTOCOL:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**STEP 1.1: Identify Script**
- Look at the actual shapes of characters in the image
- **Tamil**: Angular/curved characters (க, ங, ச, ஞ, ட, ண, த, ந, ப, ம, ய, ர, ல, வ, ழ, ள, ற, ன)
- **Sinhala**: Round/circular characters (ක, ග, ච, ජ, ට, ඩ, ණ, ත, ද, න, ප, බ, ම, ය, ර, ල, ව, ශ, ෂ, ස, හ, ළ)
- **English**: Latin alphabet (A-Z, a-z)

**STEP 1.2: Set Language and Encoding**
- If Tamil detected:
  → Set language = "Tamil"
  → Use ONLY Unicode Tamil block (U+0B80-U+0BFF)
  → Every character MUST be proper Tamil Unicode
  
- If Sinhala detected:
  → Set language = "Sinhala"
  → Use ONLY Unicode Sinhala block (U+0D80-U+0DFF)
  → Every character MUST be proper Sinhala Unicode
  
- If English detected:
  → Set language = "English"
  → Use standard ASCII/Latin characters

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 MANDATORY SELF-VALIDATION (Do this BEFORE responding!):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before you output ANYTHING, ask yourself:

1. ✓ Does my output contain ONLY proper Tamil (U+0B80-U+0BFF) or Sinhala (U+0D80-U+0DFF) Unicode?
2. ✓ Are there ANY Latin letters mixed with accent marks (like ¨, ©, ø, ®, À, Á, etc.)?
3. ✓ Would a native Tamil/Sinhala speaker be able to READ this text?
4. ✓ Do the words look like REAL words in that language?
5. ✓ Is the language field set to "Tamil" or "Sinhala" (NOT "English")?

**If ANY answer is NO or uncertain:**
→ STOP!
→ Re-examine the image carefully
→ Extract text again with proper Unicode encoding
→ Verify each character is from the correct Unicode block
→ Try again until ALL checks pass

⚠️ **REMEMBER**: Garbage characters mean FAILED Unicode extraction. You MUST retry until you get clean Unicode!

### STEP 2: INTELLIGENT PACK CREATION

⚠️ **CRITICAL RULES**:

**SCENARIO A: VALID TABLE OF CONTENTS FOUND**
If you validated the TOC (Step 0.2) and it matches the document:
1. Extract ALL chapter/section titles from the TOC
2. **IMPORTANT**: Scan the actual chapter content pages to create accurate summaries
3. Don't just use TOC titles - read the actual chapter content
4. Create one pack per chapter with:
   - Title from TOC
   - SHORT, PRECISE summary from actual chapter content (10-15 words MAXIMUM)
   - Detected language
5. If TOC shows 15 chapters, create 15 packs; if 20 chapters, create 20 packs

**SCENARIO B: INVALID/INCOMPLETE TOC OR NO TOC**
If TOC doesn't match document OR no TOC exists:
1. **Scan the ENTIRE document**: Look through all pages
2. **Count chapters by markers**:
   - English: "Chapter 1", "Unit 1", "Lesson 1", "Section 1.1", "Part 1"
   - Sinhala: "පරිච්ඡේදය 1", "පාඩම 1", "ඒකකය 1", "කොටස 1"
   - Tamil: "அத்தியாயம் 1", "பாடம் 1", "அலகு 1", "பகுதி 1"

3. **Decision Logic:**
   - **0-1 chapters found**: Create 1 comprehensive pack covering all content
   - **2+ chapters found**: Create 1 pack per chapter (ALL chapters, no limit)
   - **Example**: If 15 chapters exist, create 15 packs
   - **Example**: If 3 chapters exist, create 3 packs

**SCENARIO C: UNCLEAR STRUCTURE**
If no clear chapters or TOC:
- Analyze main topics/themes
- Create 1-3 thematic packs based on content
- NEVER create a pack for every page

**GOLDEN RULES**: 
- ✅ ALWAYS verify TOC against actual content
- ✅ ALWAYS create packs for ALL actual chapters found
- ✅ ALWAYS read actual content (not just TOC)
- ❌ NEVER create a pack for every page
- ❌ NEVER trust TOC without verification

### STEP 3: Create Learning Packs
For EACH identified chapter:
- **title**: Format as "Learning Pack 1", "Learning Pack 2", etc. (NOT "Chapter 1", "Chapter 2") followed by the actual chapter title from document (in detected language)
- **content**: Write a SHORT, PRECISE summary (10-15 words MAXIMUM) covering ONLY the key concepts (in detected language)
- **language**: The detected language (MUST be "English", "Sinhala", or "Tamil" - use EXACT spelling)

⚠️ CRITICAL: 
- Keep summaries SHORT and PRECISE - 10-15 words MAXIMUM! Focus on key points only!
- Title format: "Learning Pack 1: [Chapter Title]" NOT "Chapter 1: [Title]"
- Language MUST be one of: "English", "Sinhala", "Tamil" (exact spelling, capitalized)

### IF NO CLEAR CHAPTERS EXIST:
Create EXACTLY ONE comprehensive learning pack that covers all main themes of the document.

### VALIDATION RULES:
✓ Each title must be meaningful and readable
✓ NO random characters like "fkdñ,a fnod yeÿ iyd h'"
✓ NO corrupted text or encoding errors
✓ Use proper Unicode for Sinhala (0D80-0DFF) and Tamil (0B80-0BFF)
✓ Create packs for ALL actual chapters (no arbitrary limit)
✓ Language field MUST match the actual content language

### OUTPUT FORMAT EXAMPLES:

**Example 1: Sinhala Math Textbook (Multiple Chapters)**
<BEGIN_JSON>
[
  {
    "title": "Learning Pack 1: සංඛ්‍යා පද්ධති",
    "content": "මෙම පරිච්ඡේදයෙන් සංඛ්‍යා පද්ධති පිළිබඳ මූලික සංකල්ප විස්තර කෙරේ. ස්වභාවික සංඛ්‍යා, පූර්ණ සංඛ්‍යා සහ තාර්කික සංඛ්‍යා ගැන සාකච්ඡා කෙරේ.",
    "language": "Sinhala"
  },
  {
    "title": "Learning Pack 2: වීජ ගණිතය",
    "content": "වීජ ගණිතයේ මූලික සංකල්ප හඳුන්වා දෙයි. විචල්‍යයන්, සමීකරණ සහ අසමානතා විසඳීම පිළිබඳ විස්තර කෙරේ.",
    "language": "Sinhala"
  }
]
<END_JSON>

**Example 2: Tamil Science Document (Single Topic)**
<BEGIN_JSON>
[
  {
    "title": "Learning Pack 1: ஒளியியல்",
    "content": "இந்த அத்தியாயம் ஒளியின் பண்புகள் மற்றும் நடத்தை பற்றி விவரிக்கிறது. பிரதிபலிப்பு, ஒளிவிலகல் மற்றும் ஒளி சிதறல் பற்றிய கருத்துக்கள் விளக்கப்படுகின்றன.",
    "language": "Tamil"
  }
]
<END_JSON>

**Example 3: English Textbook (Table of Contents Detected)**
<BEGIN_JSON>
[
  {
    "title": "Learning Pack 1: Introduction to Biology",
    "content": "This chapter introduces the fundamental concepts of biology, including cell structure, living organisms, and basic life processes.",
    "language": "English"
  },
  {
    "title": "Learning Pack 2: Cell Biology",
    "content": "Detailed study of cell structure and function, including organelles, cell membrane, and cellular processes.",
    "language": "English"
  }
]
<END_JSON>

⚠️ FINAL CHECKLIST:
1. ✓ Scanned the ENTIRE document (not just first page)?
2. ✓ If TOC found, verified it against actual content?
3. ✓ Detected correct language (English/Sinhala/Tamil)?
4. ✓ Used proper Unicode characters?
5. ✓ Created packs for ALL actual chapters found?
6. ✓ Titles are meaningful and from the document?
7. ✓ Content summaries based on ACTUAL content (not just TOC)?
8. ✓ Content summaries are in the detected language?
9. ✓ Did NOT create a pack for every page?

⚠️ REMEMBER: 
- Verify TOC against actual document
- Analyze ENTIRE document structure
- Create packs for ALL chapters
- Use actual content for summaries
- Clean Unicode only
- Correct language detection!`;

      let result;
      const tGeminiStart = Date.now();
      try {
        result = await withRetry(() => model.generateContent({
          contents: [{ role: 'user', parts: [{ text: prompt }, imagePart] }]
        }), { maxAttempts: 4, baseDelay: 1500 });
      } catch (e) {
        const tGeminiFailEnd = Date.now();
        timing.gemini = tGeminiFailEnd - tGeminiStart;
        await logGeminiApiError(e, {
          apiEndpoint: 'generateContent',
          prompt: prompt.substring(0, 500),
          fileType: mimeType,
          endpoint: 'generateLearningPacksFromBase64'
        });
        const tFallbackStart = Date.now();
        const fallbackPacks = await localFallbackPacks();
        const tFallbackEnd = Date.now();
        timing.fallback = tFallbackEnd - tFallbackStart;
        console.log('[Backend Gemini] Timing (ms):', timing);
        return fallbackPacks;
      }
      const tGeminiEnd = Date.now();
      timing.gemini = tGeminiEnd - tGeminiStart;

      let raw = result.response.text();

      const block = raw.match(/<BEGIN_JSON>[\s\S]*?<END_JSON>/);
      if (block) raw = block[0].replace(/<BEGIN_JSON>|<END_JSON>/g, '').trim();
      raw = sanitizeJsonArrayString(raw);
      let packs;
      const tParseStart = Date.now();
      try {
        packs = JSON.parse(raw);
      } catch (e1) {
        const repairPrompt = `Fix to a valid JSON array only. No extra text.\n\n<INPUT>\n${raw}\n</INPUT>`;
        const tRepairStart = Date.now();
        try {
          const repair = await withRetry(() => model.generateContent({ contents: [{ role: 'user', parts: [{ text: repairPrompt }] }] }), { maxAttempts: 3, baseDelay: 800 });
          const repairedText = repair.response.text();
          const repaired = sanitizeJsonArrayString(repairedText);
          packs = JSON.parse(repaired);
          const tRepairEnd = Date.now();
          timing.repair = tRepairEnd - tRepairStart;
        } catch (e2) {
          const tFallbackStart = Date.now();
          const fallbackPacks = await localFallbackPacks();
          const tFallbackEnd = Date.now();
          timing.fallback = tFallbackEnd - tFallbackStart;
          console.log('[Backend Gemini] Timing (ms):', timing);
          return fallbackPacks;
        }
      }
      const tParseEnd = Date.now();
      if (!timing.repair) {
        timing.repair = tParseEnd - tParseStart;
      }
      console.log('[Backend Gemini] Timing (ms):', timing);

      // Validate and filter packs
      const validPacks = packs
        .filter((p, idx) => {
          const title = String(p.title || '');
          const content = String(p.content || '');
          const language = p.language || 'English';

          // Check if title has meaningful content (not just garbage)
          const hasEnglish = /[a-zA-Z]{3,}/.test(title);
          const hasSinhala = /[\u0D80-\u0DFF]{3,}/.test(title);
          const hasTamil = /[\u0B80-\u0BFF]{3,}/.test(title);
          const hasValidTitle = title.length > 3 && (hasEnglish || hasSinhala || hasTamil);

          // Specific garbage patterns for Sinhala/Tamil corruption
          // These patterns indicate corrupted ISO-8859-1 or Windows-1252 encoding
          const sinhalaGarbage = /fkd[ñ,a]|fnod|yeÿ|iyd|ksoi|mqkl|wdh|kfh|bEö|fjk|;d;a|o¾Y|,>q\.|>k jia|mDIaG|mßud|oaúm|ùÔh|iudka;r|f¾Ld|m%;s|fldgia/.test(title);

          // Tamil garbage patterns - these are the EXACT patterns user is seeing
          const tamilGarbage = /[¸©£÷øÁÎß\u00a8\u00a9\u00b8\u00c0\u00c1\u00f8\u00ae\u00ce\u00df\u00f6\u00f7\u00f5][A-Za-z]|[A-Za-z][¸©£÷øÁÎß\u00a8\u00a9\u00b8\u00c0\u00c1\u00f8\u00ae\u00ce\u00df\u00f6\u00f7\u00f5]|C»Á|£õh|÷©Ø|¨£µ|Po¨|Gs÷|_¸UP|\u00c2uzøu/.test(title);

          const hasGarbagePatterns = sinhalaGarbage || tamilGarbage;

          // For Tamil/Sinhala, if garbage patterns are detected, automatically reject
          // Even a single garbage pattern should disqualify the pack
          const garbageThreshold = (hasTamil || hasSinhala) ? 0.3 : 0.3;

          // Reject if title is mostly garbage characters
          const garbageRatio = (title.match(/[^\p{L}\p{N}\s.,!?\-:;()'"]/gu) || []).length / title.length;
          const isGarbage = garbageRatio > garbageThreshold || hasGarbagePatterns;

          // Debug logging
          if (!hasValidTitle || isGarbage) {
            console.log(`[Backend Gemini] Debug pack ${idx + 1}:`, {
              title: title.substring(0, 50),
              language,
              hasEnglish,
              hasSinhala,
              hasTamil,
              hasValidTitle,
              garbageRatio: garbageRatio.toFixed(3),
              hasGarbagePatterns,
              isGarbage
            });
          }

          // Language-specific validation
          if (language === 'Sinhala' && !hasSinhala) {
            console.warn(`[Backend Gemini] Pack ${idx + 1} claims Sinhala but has no Sinhala characters: "${title.substring(0, 50)}"`);
            return false;
          }
          if (language === 'Tamil' && !hasTamil) {
            console.warn(`[Backend Gemini] Pack ${idx + 1} claims Tamil but has no Tamil characters: "${title.substring(0, 50)}"`);
            return false;
          }

          if (!hasValidTitle || isGarbage) {
            console.warn(`[Backend Gemini] Filtering out invalid pack ${idx + 1}: "${title.substring(0, 50)}"`);
            return false;
          }

          return true;
        })
        // No slice limit - create packs for ALL valid chapters found
        .map((p, idx) => {
          const title = String(p.title || `Learning Pack ${idx + 1}`);
          const content = String(p.content || '');
          // Detect language from title and content if not provided
          const detectedLanguage = p.language || detectLanguageFromText(title + ' ' + content);

          return {
            title: title,
            content: content,
            order: idx + 1,
            language: detectedLanguage
          };
        });

      console.log(`[Backend Gemini] Validated ${validPacks.length} packs from ${packs.length} generated`);

      // If no valid packs or too many filtered as garbage, return error to force retry
      if (validPacks.length === 0) {
        console.error(`[Backend Gemini] ❌ ALL ${packs.length} packs were filtered as garbage/invalid!`);
        console.error('[Backend Gemini] Sample garbage titles:', packs.slice(0, 3).map(p => p.title?.substring(0, 60)));
        throw new Error('Generated packs contain corrupted text. Please try uploading again or use a different file format.');
      }

      const filteredPercentage = ((packs.length - validPacks.length) / packs.length) * 100;
      if (filteredPercentage > 50) {
        console.warn(`[Backend Gemini] ⚠️ Filtered ${filteredPercentage.toFixed(0)}% of packs as garbage`);
      }

      return validPacks;
    }

    // Text-first path for DOCX/TXT
    if (isDoc) throw new Error('DOC format is not supported. Please convert to PDF or DOCX.');

    if (isDocx) {
      const { default: mammoth } = await import('mammoth');
      const buffer = Buffer.from(base64Data, 'base64');
      const { value } = await mammoth.extractRawText({ buffer });
      textForChapters = value || '';
    } else if (isTxt) {
      textForChapters = Buffer.from(base64Data, 'base64').toString('utf-8');
    } else {
      throw new Error(`Unsupported MIME type: ${mimeType}`);
    }

    if (!textForChapters?.trim()) throw new Error('No text could be extracted for chapter analysis');

    prompt = `You are an expert educational content creator for the Sri Lankan local syllabus (Grades 6-11) with advanced multilingual capabilities in English, Sinhala, and Tamil.

⚠️ ABSOLUTE RULES - VIOLATION WILL RESULT IN REJECTION:
1. Generate MAXIMUM 10 learning packs - NEVER exceed this limit
2. Each pack must have a REAL, meaningful title from the document
3. Use ONLY clean Unicode - NO garbage characters, NO corrupted text
4. ALL content must be in the DETECTED language (English/Sinhala/Tamil)

---

### STEP 1: Language Detection
Analyze the text and identify the PRIMARY language:
- **English**: If you see Latin alphabet (A-Z, a-z)
- **Sinhala**: If you see Sinhala script (ක, ග, ච, ජ, ට, ඩ, ණ, ත, ද, න, ප, බ, ම, ය, ර, ල, ව, ශ, ෂ, ස, හ, ළ, etc.)
- **Tamil**: If you see Tamil script (க, ங, ச, ஞ, ட, ண, த, ந, ப, ம, ய, ர, ல, வ, ழ, ள, ற, ன, etc.)

Return ONLY: "English", "Sinhala", or "Tamil"

### STEP 2: Extract REAL Chapters
Look for ACTUAL chapter markers in the text:
- English: "Chapter 1", "Unit 1", "Lesson 1", "Section 1.1"
- Sinhala: "පරිච්ඡේදය 1", "පාඩම 1", "ඒකකය 1"
- Tamil: "அத்தியாயம் 1", "பாடம் 1", "அலகு 1"

**CRITICAL**: If you find 5 real chapters, create 5 packs. If you find 8, create 8. MAXIMUM 10 packs total.

### STEP 3: Create Learning Packs
For EACH identified chapter:
- **title**: Extract the EXACT chapter title from the text (in detected language)
- **content**: Write a 150-300 word summary of that chapter's key concepts (in detected language)
- **language**: The detected language

### IF NO CLEAR CHAPTERS EXIST:
Create 3-5 topic-based packs covering the main themes of the document.

### VALIDATION RULES:
✓ Each title must be meaningful and readable
✓ NO random characters like "fkdñ,a fnod yeÿ iyd h'"
✓ NO corrupted text or encoding errors
✓ Use proper Unicode for Sinhala (0D80-0DFF) and Tamil (0B80-0BFF)
✓ Maximum 10 packs - reject if more

### OUTPUT FORMAT:
<BEGIN_JSON>
[
  {
    "title": "පළමු පරිච්ඡේදය: සංඛ්‍යා පද්ධති",
    "content": "මෙම පරිච්ඡේදයෙන් සංඛ්‍යා පද්ධති පිළිබඳ මූලික සංකල්ප විස්තර කෙරේ...",
    "language": "Sinhala"
  }
]
<END_JSON>

⚠️ REMEMBER: Maximum 10 packs, clean Unicode only, real chapter titles!

SOURCE TEXT (may be truncated):\n${textForChapters.substring(0, 120000)}`;

    let result2;
    try {
      result2 = await withRetry(() => model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      }), { maxAttempts: 4, baseDelay: 1500 });
    } catch (e) {
      return await localFallbackPacks();
    }

    let raw2 = result2.response.text();
    const block2 = raw2.match(/<BEGIN_JSON>[\s\S]*?<END_JSON>/);
    if (block2) raw2 = block2[0].replace(/<BEGIN_JSON>|<END_JSON>/g, '').trim();
    raw2 = sanitizeJsonArrayString(raw2);
    let packs2;
    try {
      packs2 = JSON.parse(raw2);
    } catch (e1) {
      const repairPrompt2 = `Fix to a valid JSON array only. No extra text.\n\n<INPUT>\n${raw2}\n</INPUT>`;
      try {
        const repair2 = await withRetry(() => model.generateContent({ contents: [{ role: 'user', parts: [{ text: repairPrompt2 }] }] }), { maxAttempts: 3, baseDelay: 800 });
        const repairedText2 = repair2.response.text();
        const repaired2 = sanitizeJsonArrayString(repairedText2);
        packs2 = JSON.parse(repaired2);
      } catch (e2) {
        return await localFallbackPacks();
      }
    }
    // Validate and filter packs
    const validPacks2 = packs2
      .filter((p, idx) => {
        const title = String(p.title || '');
        const content = String(p.content || '');
        const language = p.language || 'English';

        // Check if title has meaningful content (not just garbage)
        const hasEnglish = /[a-zA-Z]{3,}/.test(title);
        const hasSinhala = /[\u0D80-\u0DFF]{3,}/.test(title);
        const hasTamil = /[\u0B80-\u0BFF]{3,}/.test(title);
        const hasValidTitle = title.length > 3 && (hasEnglish || hasSinhala || hasTamil);

        // Specific garbage patterns for Sinhala/Tamil corruption
        const hasGarbagePatterns = /fkd[ñ,a]|fnod|yeÿ|iyd|ksoi|mqkl|wdh|kfh|bEö|fjk|;d;a|o¾Y|,>q\.|>k jia|mDIaG|mßud|oaúm|ùÔh|iudka;r|f¾Ld|m%;s|fldgia/.test(title);

        // For Tamil/Sinhala, be more lenient with garbage ratio due to combining characters
        // For English, use stricter threshold
        const garbageThreshold = (hasTamil || hasSinhala) ? 0.5 : 0.3;

        // Reject if title is mostly garbage characters
        const garbageRatio = (title.match(/[^\p{L}\p{N}\s.,!?\-:;()'"]/gu) || []).length / title.length;
        const isGarbage = garbageRatio > garbageThreshold || hasGarbagePatterns;

        // Debug logging
        if (!hasValidTitle || isGarbage) {
          console.log(`[Backend Gemini] Debug pack ${idx + 1}:`, {
            title: title.substring(0, 50),
            language,
            hasEnglish,
            hasSinhala,
            hasTamil,
            hasValidTitle,
            garbageRatio: garbageRatio.toFixed(3),
            hasGarbagePatterns,
            isGarbage
          });
        }

        // Language-specific validation
        if (language === 'Sinhala' && !hasSinhala) {
          console.warn(`[Backend Gemini] Pack ${idx + 1} claims Sinhala but has no Sinhala characters: "${title.substring(0, 50)}"`);
          return false;
        }
        if (language === 'Tamil' && !hasTamil) {
          console.warn(`[Backend Gemini] Pack ${idx + 1} claims Tamil but has no Tamil characters: "${title.substring(0, 50)}"`);
          return false;
        }

        if (!hasValidTitle || isGarbage) {
          console.warn(`[Backend Gemini] Filtering out invalid pack ${idx + 1}: "${title.substring(0, 50)}"`);
          return false;
        }

        return true;
      })
      .slice(0, 10) // Enforce maximum 10 packs
      .map((p, idx) => {
        const title = String(p.title || `Learning Pack ${idx + 1}`);
        const content = String(p.content || '');
        // Detect language from title and content if not provided
        const detectedLanguage = p.language || detectLanguageFromText(title + ' ' + content);

        return {
          title: title,
          content: content,
          order: idx + 1,
          language: detectedLanguage
        };
      });

    console.log(`[Backend Gemini] Validated ${validPacks2.length} packs from ${packs2.length} generated`);
    return validPacks2;
  } catch (error) {
    await logGeminiApiError(error, {
      apiEndpoint: 'generateLearningPacksFromBase64',
      fileType: mimeType,
      endpoint: 'generateLearningPacksFromBase64'
    });
    console.error('[Backend Gemini] generateLearningPacksFromBase64 error:', error);
    throw new Error(`Failed to generate learning packs: ${error.message}`);
  }
};

// Sri Lankan education system - 8 Compulsory Subjects (Grades 6-11)
const COMPULSORY_SUBJECTS = [
  'Mathematics',
  'Science',
  'Social Studies', // includes History, Geography, Civics
  'Language & Literature (Sinhala)', // First Language
  'Language & Literature (Tamil)', // First Language
  'English Language',
  'Information & Communication Technology (ICT)',
  'Religion' // Buddhism / Islam / Hinduism / Christianity
];

const AESTHETIC_SUBJECTS = [
  'Health & Physical Education',
  'Aesthetic Education', // includes Art & Music
  'Health Science',
  'Physical Education',
  'Art',
  'Music'
];

const GRADE_RANGE = {
  min: 6,
  max: 11
};

/**
 * Generate 5-8 bullet summary from text content
 */
export const generateSummaryFromText = async (text, language = 'English', packTitle = '', packDescription = '') => {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const scopePrompt = packTitle ? `
🚨 SUMMARY SCOPE - CRITICAL INSTRUCTIONS:

YOU ARE SUMMARIZING: "${packTitle}"
${packDescription ? `SPECIFIC CONTEXT: ${packDescription}` : ''}

**RESTRICTION:** Generate summary ONLY from content related to this specific learning pack.
**PROHIBITED:** Do NOT include information from other chapters or general knowledge.
**FOCUS:** Every bullet point must be directly relevant to "${packTitle}"

CONTENT TO SUMMARIZE:
${text}
` : '';

    const prompt = `SYSTEM:
You are EduQuestLab. Summarize ONLY in ${language}. For Sinhala/Tamil, use clean Unicode.

${scopePrompt}

🚨 CRITICAL RULES - VIOLATION WILL RESULT IN REJECTION:
1. DO NOT mention figure numbers, page numbers, chapter numbers, or textbook names
2. DO NOT reference "the document", "the text", or "the content" 
3. DO NOT use phrases like "according to", "based on", "as shown in"
4. Focus ONLY on the actual concepts and knowledge relevant to "${packTitle || 'the specific topic'}"
5. Write as universal facts, not as references to source material
6. If the pack is about cells, summarize ONLY cells - NOT other biology topics

TASK:
Produce 5-8 concise bullet points strictly grounded in the content relevant to "${packTitle || 'the main topic'}".

OUTPUT: JSON object {"bullets": string[]} with 5-8 items.`;

    const result = await model.generateContent(prompt);
    const textOut = result.response.text();
    const match = textOut.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid summary response');
    const parsed = JSON.parse(match[0]);
    const bullets = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 8) : [];
    return bullets;
  } catch (err) {
    console.error('[Backend Gemini] Summary (text) error:', err);
    return [];
  }
};

/**
 * Generate a Learning Pack directly from a base64 file using Gemini Vision API
 * Returns structured markdown/plain text according to the provided prompt
 * @param {string} base64Data - Base64 encoded file data
 * @param {string} mimeType - MIME type of the file (e.g., application/pdf, image/png)
 * @param {string} userPrompt - The user-provided instruction prompt
 * @returns {Promise<string>} - Generated learning pack text
 */
export const generateLearningPackFromBase64 = async (base64Data, mimeType, userPrompt) => {
  try {
    const prompt = userPrompt || 'You are an expert educational content creator. Generate a concise learning pack.';

    // Route by MIME type: PDFs/images via Vision (inlineData). Others (e.g., DOCX) -> extract text and send as text-only.
    const isPdf = mimeType === 'application/pdf';
    const isImage = /^image\//.test(mimeType);
    const isDocx = mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const isDoc = mimeType === 'application/msword';
    const isTxt = mimeType === 'text/plain';

    let contents;

    if (isPdf || isImage) {
      // Use Vision with inlineData
      const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
      const imagePart = { inlineData: { data: base64Data, mimeType } };
      contents = [{ role: 'user', parts: [{ text: prompt }, imagePart] }];

      const result = await withRetry(() => model.generateContent({ contents }), { maxAttempts: 4, baseDelay: 1500 });
      const response = await result.response;
      const text = response.text();
      return String(text || '').replace(/\u0000/g, '').trim();
    }

    // For DOCX/DOC/TXT, convert to plain text then send as text-only prompt
    let extractedText = '';
    try {
      if (isDocx) {
        // Use mammoth to extract DOCX text (dynamic import to keep optional)
        const { default: mammoth } = await import('mammoth');
        const buffer = Buffer.from(base64Data, 'base64');
        const { value } = await mammoth.extractRawText({ buffer });
        extractedText = value || '';
      } else if (isDoc) {
        throw new Error('DOC format is not supported. Please convert to PDF or DOCX.');
      } else if (isTxt) {
        extractedText = Buffer.from(base64Data, 'base64').toString('utf-8');
      } else {
        throw new Error(`Unsupported MIME type: ${mimeType}`);
      }
    } catch (e) {
      console.error('[Backend Gemini] Text extraction for non-vision file failed:', e);
      throw e;
    }

    if (!extractedText || !extractedText.trim()) {
      throw new Error('No text could be extracted from the file');
    }

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
    const textPrompt = `${prompt}\n\nSOURCE TEXT (clean Unicode):\n${extractedText.substring(0, 120000)}`; // safety cap
    const result = await withRetry(() => model.generateContent(textPrompt), { maxAttempts: 4, baseDelay: 1500 });
    const text = result.response.text();
    return String(text || '').replace(/\u0000/g, '').trim();
  } catch (error) {
    console.error('[Backend Gemini] Learning Pack generation error:', error);
    throw new Error(`Failed to generate learning pack: ${error.message}`);
  }
};

/**
 * Generate 5-8 bullet summary from image/PDF using Vision
 */
export const generateSummaryFromVision = async (base64Data, mimeType, language = 'English', packTitle = '', packDescription = '') => {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    // Add debug logging for pack context
    console.log('[generateSummaryFromVision] DEBUG - Pack Context:', {
      packTitle: packTitle ? `"${packTitle}"` : 'not provided',
      packDescription: packDescription ? `"${packDescription.substring(0, 50)}${packDescription.length > 50 ? '...' : ''}"` : 'not provided'
    });

    const prompt = `SYSTEM:
You are EduQuestLab. Summarize ONLY in ${language}. For Sinhala/Tamil, use clean Unicode.

🚨 SUMMARY SCOPE - CRITICAL INSTRUCTIONS:

YOU ARE SUMMARIZING: "${packTitle || 'the specific learning pack'}"
${packDescription ? `SPECIFIC CONTEXT: ${packDescription}` : ''}

**RESTRICTION:** Generate summary ONLY from content related to this specific learning pack.
**PROHIBITED:** Ignore other chapters, sections, or general knowledge.
**FOCUS:** Extract and summarize ONLY the material relevant to "${packTitle || 'the main topic'}"

🚨 CRITICAL INSTRUCTIONS - VIOLATION WILL RESULT IN REJECTION:
- DO NOT mention figure numbers, page numbers, chapter numbers, or textbook names in the summary
- NEVER use phrases like "according to the document", "based on the content", "in this text", "as shown", "as mentioned"
- NEVER refer to "the document", "the content", "the text", "the image", "the file", or "the uploaded material"
- NEVER start bullet points with "According to...", "As mentioned in...", "As shown in...", "Based on..."
- Write bullet points as if they are from a textbook - these are established facts
- Focus ONLY on the actual concepts and knowledge related to "${packTitle || 'the specified focus area'}"

TASK:
Produce 5-8 concise bullet points strictly grounded in content relevant to "${packTitle || 'the main topic'}". 

OUTPUT: JSON object {"bullets": string[]} with 5-8 items.`;

    const imagePart = { inlineData: { data: base64Data, mimeType } };
    const result = await withRetry(() => model.generateContent([prompt, imagePart]));
    const textOut = result.response.text();
    const match = textOut.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Invalid summary response');
    const parsed = JSON.parse(match[0]);
    const bullets = Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 8) : [];
    return bullets;
  } catch (err) {
    console.error('[Backend Gemini] Summary (vision) error:', err);
    return [];
  }
};

/**
 * Download a file and produce a 5-8 bullet summary in the specified language
 */
export const generateSummaryFromFile = async (fileUrl, fileType, language = 'English', packTitle = '', packDescription = '') => {
  try {
    const buffer = await downloadAny(fileUrl);
    const mimeType = getMimeType(fileType, fileUrl);

    console.log('[generateSummaryFromFile] DEBUG - Pack Context:', {
      packTitle: packTitle ? `"${packTitle}"` : 'not provided',
      packDescription: packDescription ? `"${packDescription.substring(0, 50)}${packDescription.length > 50 ? '...' : ''}"` : 'not provided',
      fileType,
      language
    });

    if (fileType === 'image' || fileType === 'pdf') {
      const base64Data = buffer.toString('base64');
      return await generateSummaryFromVision(base64Data, mimeType, language, packTitle, packDescription);
    } else {
      const text = buffer.toString('utf-8');
      return await generateSummaryFromText(text, language, packTitle, packDescription);
    }
  } catch (err) {
    console.error('[Backend Gemini] Summary (file) error:', err);
    return [];
  }
}

/**
 * Generate structured study material (summary + sections + subtopics) from an uploaded file
 * @param {string} fileUrl
 * @param {string} fileType - 'image' | 'pdf' | 'document'
 * @returns {Promise<Object>} - Structured material JSON
 */
export const generateStructuredMaterialFromFile = async (fileUrl, fileType) => {
  try {

    // Parse path and download file (reuse logic)
    const buffer = await downloadAny(fileUrl);
    const base64Data = buffer.toString('base64');
    const mimeType = getMimeType(fileType, fileUrl);

    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const schema = {
      type: 'OBJECT',
      properties: {
        summary: { type: 'STRING' },
        key_points: { type: 'ARRAY', items: { type: 'STRING' } },
        sections: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              summary: { type: 'STRING' },
              subtopics: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    title: { type: 'STRING' },
                    points: { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                  required: ['title']
                }
              }
            },
            required: ['title']
          }
        },
        glossary: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              term: { type: 'STRING' },
              definition: { type: 'STRING' }
            },
            required: ['term', 'definition']
          }
        },
        diagrams: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              caption: { type: 'STRING' },
              present: { type: 'BOOLEAN' }
            },
            required: ['caption']
          }
        },
        study_time_estimate_min: { type: 'NUMBER' }
      },
      required: ['summary', 'sections']
    };

    const prompt = `Create structured study material from this document.

Return JSON that includes:
- summary: 3-6 sentence overview in clean Unicode
- key_points: bullet points of critical ideas
- sections: array of sections with title, 1-3 sentence summary, and subtopics
  - subtopics: each has title and list of concise bullet points
- glossary: key terms with simple definitions (if applicable)
- diagrams: list captions if diagrams are present, else empty array
- study_time_estimate_min: approximate minutes to study the material (integer)

Keep it concise, accurate, and aligned to Sri Lankan Grades 6-11 context when possible.`;

    const imagePart = { inlineData: { data: base64Data, mimeType } };

    const result = await withRetry(() => model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }, imagePart] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    }));

    const response = await result.response;
    const text = response.text();

    let material;
    try {
      material = JSON.parse(text);
    } catch (e) {
      const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        material = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      } else {
        throw new Error('Failed to parse structured material JSON');
      }
    }

    // Minimal normalization
    material.key_points = Array.isArray(material.key_points) ? material.key_points : [];
    material.sections = Array.isArray(material.sections) ? material.sections : [];
    material.glossary = Array.isArray(material.glossary) ? material.glossary : [];
    material.diagrams = Array.isArray(material.diagrams) ? material.diagrams : [];

    return material;
  } catch (error) {
    console.error('[Backend Gemini] Structured material generation error:', error);
    return {
      summary: 'Unable to generate structured material',
      key_points: [],
      sections: [],
      glossary: [],
      diagrams: [],
      study_time_estimate_min: 0,
      error: error.message
    };
  }
};

/**
 * Extract content metadata from file using Gemini Vision API
 * Extracts: language, grade, subject, chapters, clean text
 * @param {string} base64Data - Base64 encoded file data
 * @param {string} mimeType - MIME type of file
 * @returns {Promise<Object>} - Extracted metadata
 */
export const extractContentMetadata = async (base64Data, mimeType) => {
  try {

    // Define the JSON schema for the response (REQUIRED FOR STRUCTURED OUTPUT)
    const metadataSchema = {
      type: "OBJECT",
      properties: {
        language: { type: "STRING", enum: ["English", "Sinhala", "Tamil", "Mixed", "Unknown"] },
        grade: { type: "STRING", enum: ["6", "7", "8", "9", "10", "11", "Unknown"] },
        subject: { type: "STRING", enum: [...COMPULSORY_SUBJECTS, ...AESTHETIC_SUBJECTS, "Unknown"] },
        chapters: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              content: { type: "STRING" },
              pageNumbers: { type: "ARRAY", items: { type: "NUMBER" } }
            },
            required: ["title", "content"]
          }
        },
        summary: { type: "STRING" },
        hasDiagrams: { type: "BOOLEAN" },
        topics: { type: "ARRAY", items: { type: "STRING" } }
      },
      required: ["language", "grade", "subject", "chapters", "summary", "hasDiagrams", "topics"]
    };

    // 1. Initialize model
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const prompt = `
Analyze this educational document and extract the following metadata in JSON format.

Context: This is from the Sri Lankan Local Syllabus (Grades 6-11) with these 8 COMPULSORY subjects:
1. Mathematics
2. Science
3. Social Studies (includes History, Geography, Civics)
4. Language & Literature (Sinhala or Tamil - First Language)
5. English Language
6. Information & Communication Technology (ICT)
7. Religion (Buddhism / Islam / Hinduism / Christianity)
8. Health & Physical Education / Aesthetic Education (includes Health Science, Physical Education, Art & Music)

Extract:
1. **language**: Detect the primary language (English, Sinhala, Tamil, or Mixed)
2. **grade**: Identify the grade level (6-11 ONLY, or "Unknown" if not in this range)
3. **subject**: Identify the subject from the compulsory/aesthetic subjects above (match exactly, or "Unknown")
4. **chapters**: Array of chapter/section objects with:
    - title: Chapter/section title
    - content: Clean Unicode text content
    - pageNumbers: Array of page numbers (if visible)
5. **summary**: Brief 2-3 sentence summary of the document
6. **hasDiagrams**: Boolean - does it contain diagrams/images?
7. **topics**: Array of main topics covered

IMPORTANT: 
- Grade must be between 6-11 (Sri Lankan local syllabus)
- Subject must match one of the listed subjects.
- For Social Studies, include History/Geography/Civics content
- For Language & Literature, specify if Sinhala or Tamil

Return ONLY valid JSON in the format strictly defined by the schema.
`;
    let normalizedMimeType = mimeType;
    if (!normalizedMimeType || normalizedMimeType === 'application/octet-stream') {
      // You only send PDFs here, so assume PDF
      normalizedMimeType = 'application/pdf';
    }
    const imagePart = {
      inlineData: {
        data: base64Data,
        mimeType: normalizedMimeType
      }
    };

    // 2. CORRECTED API CALL STRUCTURE with better error handling
    const result = await withRetry(
      async () => {
        try {
          const generationConfig = {
            temperature: 0.7,
            topP: 0.95,
            topK: 40,
            maxOutputTokens: 8192,
          };

          const response = await model.generateContent({
            contents: [{
              role: "user",
              parts: [
                { text: prompt },
                imagePart
              ]
            }],
            generationConfig: generationConfig,
          });

          return response;
        } catch (error) {
          await logGeminiApiError(error, {
            apiEndpoint: 'generateContent',
            fileType: mimeType,
            endpoint: 'extractContentMetadata',
          });
          console.error('[Backend Gemini] API call failed:', {
            message: error.message,
            status: error.status,
            code: error.code,
            stack: error.stack?.split('\n').slice(0, 3).join('\n')
          });
          throw error; // Re-throw for retry logic
        }
      },
      { maxAttempts: 5, baseDelay: 2000 }
    );

    const response = await result.response;
    const text = response.text();

    // Parse JSON response with better error handling
    let metadata;
    try {
      // First try direct JSON parse
      metadata = JSON.parse(text);
    } catch (parseError) {
      console.warn('[Backend Gemini] Initial JSON parse failed, trying to extract from markdown');

      // Try to extract JSON from markdown code blocks
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
        text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        try {
          const jsonStr = (jsonMatch[1] || jsonMatch[0]).trim();
          metadata = JSON.parse(jsonStr);
        } catch (e) {
          console.error('[Backend Gemini] Failed to parse extracted JSON:', e);
          throw new Error(`Failed to parse JSON from response: ${e.message}`);
        }
      } else {
        console.error('[Backend Gemini] No valid JSON found in response');
        throw new Error('No valid JSON found in API response');
      }
    }

    // Ensure the response has the necessary fields (fallback if schema wasn't fully respected)
    if (!metadata.chapters) {
      metadata.chapters = [];
    }
    if (!metadata.topics) {
      metadata.topics = [];
    }


    console.log('[Backend Gemini] Extracted metadata:', {
      language: metadata.language,
      grade: metadata.grade,
      subject: metadata.subject,
      chaptersCount: metadata.chapters?.length || 0,
      hasDiagrams: metadata.hasDiagrams
    });

    return metadata;

  } catch (error) {
    await logGeminiApiError(error, {
      apiEndpoint: 'extractContentMetadata',
      fileType: mimeType,
      endpoint: 'extractContentMetadata'
    });
    console.error('[Backend Gemini] Metadata extraction error:', {
      message: error.message,
      status: error.status,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 3).join('\n')
    });

    // Return default metadata with error details
    return {
      language: 'English', // Default to English instead of Unknown
      grade: '10', // Default to grade 10
      subject: 'General', // Default subject
      chapters: [{
        title: 'Document Content',
        content: 'Content extraction failed. Please try again or check the document format.',
        pageNumbers: [1]
      }],
      summary: 'Unable to extract content. The document may be in an unsupported format or the service is temporarily unavailable.',
      hasDiagrams: false,
      topics: ['General Knowledge'],
      hasDiagrams: false,
      topics: [],
      error: error.message
    };
  }
};

/**
 * Generate questions from text content using Gemini AI
 * @param {string} content - Text content to generate questions from
 * @param {Object} options - Generation options
 * @param {number} options.count - Number of questions to generate
 * @param {string} options.difficulty - Difficulty level (Easy, Intermediate, Hard)
 * @param {Array<string>} options.types - Question types to generate
 * @param {string} options.packTitle - Pack title
 * @param {string} options.packDescription - Pack description
 * @returns {Promise<Array>} - Generated questions
 */


export const generateQuestions = async (content, options = {}) => {
  try {
    const {
      count = 5,
      difficulty = 'Intermediate',
      types = ['MCQ', 'FIIB', 'TF', 'HOQ'],
      language = 'English',
      bloom_level = 'Understand',
      packTitle = '',
      packDescription = ''
    } = options;
    console.log(' From generateQuestion packTitle:', packTitle);
    console.log(' From generateQuestions packDescription:', packDescription);
    const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

    const prompt = `
SYSTEM:
You are EduQuestLab, a multilingual pedagogy-aware generator. Always obey requested language; align to Bloom's level; ground strictly in provided context.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 SCHOOL TEXTBOOK MATH NOTATION (STRICT)
- Do NOT use caret notation "^" anywhere. (Forbidden: a^m, (a^m)^n, a^(mn))
- Use superscripts only: aᵐ, aⁿ, 2³, 5², 2¹²
- Power of a power MUST be written as: (aᵐ)ⁿ = aᵐⁿ
  Example: (2³)⁴ = 2¹²  (you may show: (2³)⁴ = 2³×⁴ = 2¹²)
- If you cannot follow this notation, regenerate the question.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


🚨 🚨 🚨 CRITICAL UNICODE REQUIREMENT FOR SINHALA AND TAMIL 🚨 🚨 🚨
${language === 'Sinhala' || language === 'Tamil' ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ ABSOLUTE REQUIREMENT: You MUST output PROPER UNICODE characters for ${language}. 
⚠️ ANY LATIN CHARACTERS = COMPLETE FAILURE
⚠️ ANY GARBAGE CHARACTERS = COMPLETE FAILURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**❌❌❌ FORBIDDEN OUTPUT - THESE ARE GARBAGE - NEVER PRODUCE THESE ❌❌❌**
${language === 'Sinhala' ? `
❌ "msróvhla", "y\`Èkafõ", ";s%fldaKdldr", "fkdjk", "uqyqK;g", "hehs", "lshkq", ",efõ"
❌ "wdOdrlh", "YS¾Ihwe", "odrh;s%fldaKdldr", "uqyqK;", "wrh", "jQ", "f.da,hl"
❌ "mßudj", "iQ;%fhka", ",efí", "f.da,fha", "fiùfï", "ksjerÈ", "iQ;%h", "fõ"
❌ ANY text with Latin letters (a-z, A-Z) mixed with symbols
` : `
❌ "¸USP", "©hUøP", "AmhÁønø¯", "£¯ß£kzv", "Gs÷PõøÁPøÍa", "_¸UPÀ", "÷Áõ®"
❌ "Euõµn[PÎß", "ö\´²®", "Âuzøua", "Po¨¦a", "£õh¡À", "C»Á\", "÷©ØSÔzu"
❌ "lg P", "antilog", "öPõÒ÷Áõ®", "A¨÷£õx", "Âv", "ö£Ö©õÚ[", "PõsP"
❌ ANY text with Latin letters (a-z, A-Z) mixed with symbols
`}

**✅✅✅ REQUIRED OUTPUT - ONLY USE THESE PROPER UNICODE CHARACTERS ✅✅✅**
${language === 'Sinhala' ? `
✅ "පළමු", "දෙවන", "තුන්වන", "සිව්වන", "පස්වන"
✅ "ගණිතය", "විද්‍යාව", "ඉතිහාසය", "භූගෝල විද්‍යාව", "සිංහල"
✅ "පරිච්ඡේදය", "පාඩම", "ප්‍රශ්නය", "පිළිතුර", "විකල්පය", "පැහැදිලි කිරීම"
✅ "සත්‍ය", "අසත්‍ය", "නිවැරදි", "වැරදි", "නිවැරදි පිළිතුර"
✅ ONLY characters from Unicode range: U+0D80 to U+0DFF
✅ NO Latin letters (a-z, A-Z) allowed AT ALL
` : `
✅ "முதல்", "இரண்டாவது", "மூன்றாவது", "நான்காவது", "ஐந்தாவது"
✅ "கணிதம்", "அறிவியல்", "வரலாறு", "புவியியல்", "தமிழ்"
✅ "அத்தியாயம்", "பாடம்", "கேள்வி", "பதில்", "விருப்பம்", "விளக்கம்"
✅ "உண்மை", "தவறு", "சரியான", "தவறான", "சரியான பதில்"
✅ ONLY characters from Unicode range: U+0B80 to U+0BFF
✅ NO Latin letters (a-z, A-Z) allowed AT ALL
`}

**🔍🔍🔍 MANDATORY SELF-VALIDATION BEFORE RESPONDING 🔍🔍🔍**
Before you output ANYTHING, you MUST check EVERY SINGLE CHARACTER:
1. ✓ Does EVERY character come from the CORRECT Unicode range (${language === 'Sinhala' ? 'U+0D80-U+0DFF' : 'U+0B80-U+0BFF'})?
2. ✓ Are there ZERO Latin letters (a-z, A-Z) in my output?
3. ✓ Do the words look like REAL ${language} words that a native speaker would recognize?
4. ✓ Is there NO mixing of symbols and Latin characters (like "lg", "antilog", "A¨÷£õx")?
5. ✓ Would a ${language} teacher approve this text?

❌ If ANY answer is NO → STOP → Re-read the content → Try again with PROPER Unicode
✅ If ALL answers are YES → Proceed with output

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : ''}

TASK:
Generate EXACTLY ${count} questions strictly from the provided content.

${packTitle ? `FOCUS AREA: ${packTitle}` : ''}
${packDescription ? `SPECIFIC CONTEXT: ${packDescription}` : ''}

Content (use only this):
${content}

Constraints:
- All text must be in ${language}. ${language === 'Sinhala' || language === 'Tamil' ? 'Use ONLY proper Unicode characters - NO Latin characters allowed!' : ''}
- Difficulty: ${difficulty}
- Bloom level: ${bloom_level}
- ⚠️ CRITICAL: Generate ONLY these question types: ${types.join(', ')} - NO OTHER TYPES ALLOWED! (ignore any other types)
- Generate EXACTLY ${count} questions - no more, no less

Question Format Requirements:
1. MCQ (Multiple Choice):
   - question_type: "MCQ"
   - question_text: Clear, unambiguous question testing key concepts
   - correct_answer: Precise and correct
   - options: 4 plausible options with ONE clearly correct answer
   - explanation: Brief reasoning

2. FIIB (Fill In The Blank):
   - question_type: "FIIB" 
   - question_text: Sentence with ___ for blank testing important terms
   - correct_answer: Key term or concept
   - options: 4-6 related terms including correct answer
   - explanation: Clear, direct explanation of why this term is correct (NO references to "file", "image", "document", or "uploaded content")

3.  TF (True/False):
   - question_type: "TF"
   - question_text: Clear factual statement
   - correct_answer: "True" or "False"
   - explanation: Clear, direct evidence for why true/false (NO references to "file", "image", "document", or "uploaded content")

4. HOQ (Higher Order Question - Short Answer):
   - question_type: "HOQ"
   - question_text: Analytical/evaluative question requiring critical thinking
   - correct_answer: CONCISE answer (1-2 sentences, 15-25 words MAX)
   - explanation: Clear, direct key points and reasoning (NO references to "file", "image", "document", or "uploaded content")
   - ⚠️ HOQ answers MUST be SHORT - no essays!

⚠️ CRITICAL FOR EXPLANATIONS - VIOLATION WILL RESULT IN REJECTION:
- Write explanations as if they are from a textbook - these are established facts
- NEVER mention "based on the file", "according to the image", "from the document", "uploaded content"
- NEVER use phrases like "according to the document", "based on the content", "in this text", "as shown", "as mentioned"
- NEVER refer to "the document", "the content", "the text", "the image", "the file", or "the uploaded material"
- NEVER start explanations with "According to...", "As mentioned in...", "As shown in...", "Based on..."
- Provide direct, factual explanations without referencing the source
- Example GOOD: "Water boils at 100°C at sea level due to atmospheric pressure."
- Example BAD: "Based on the uploaded file, water boils at 100°C."
- Example BAD: "According to the document, water boils at 100°C."
- Example BAD: "As mentioned in the text, water boils at 100°C."

Output: JSON array only. Each item object must include:
- type (MCQ|FIIB|TF|HOQ)
- difficulty
- question
- answer
- options (array for MCQ and FIIB only)

Example for FIIB:
{
  "type": "FIIB",
  "difficulty": "Intermediate",
  "question": "The process of converting light energy into chemical energy is called ___",
  "answer": "photosynthesis",
  "options": ["photosynthesis", "respiration", "digestion", "transpiration", "fermentation"]
}
`;

    console.log('[generateQuestions] Calling Gemini API with:', {
      language,
      count,
      difficulty,
      types,
      contentLength: content?.length || 0,
      packTitle: packTitle ? `"${packTitle}"` : 'not provided',
      packDescription: packDescription ? `"${packDescription.substring(0, 50)}${packDescription.length > 50 ? '...' : ''}"` : 'not provided'
    });

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    console.log('[generateQuestions] Gemini response received, length:', text?.length || 0);

    // Parse JSON response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('[generateQuestions] ❌ No JSON array found in response:', {
        responsePreview: text.substring(0, 500),
        responseLength: text.length
      });

      await logGeminiParsingError(
        new Error('Invalid response format from Gemini'),
        {
          apiEndpoint: 'generateContent',
          prompt: prompt.substring(0, 500),
          responseText: text.substring(0, 1000),
          language: options.language,
          questionTypes: options.types,
          questionCount: options.count
        }
      );
      throw new Error('Invalid response format from Gemini - no JSON array found');
    }

    console.log('[generateQuestions] JSON match found, parsing...');
    const questions = JSON.parse(jsonMatch[0]);
    console.log('[generateQuestions] ✅ Parsed questions count:', questions?.length || 0);

    // Helper function to detect garbage characters for Sinhala/Tamil
    const hasGarbageCharacters = (text, lang) => {
      if (!text) return false;

      if (lang === 'Sinhala') {
        // Check for common garbage patterns in Sinhala
        const garbagePatterns = [
          /[a-zA-Z]{3,}/, // Latin characters (3+ consecutive)
          /[;%`]/,        // Common garbage symbols
          /msró|fkd|uqyq|hehs|lshkq|,efõ|wdOdr|odrh|wrh|jQ|mßud|iQ;%|ksjer|fiù/i
        ];
        return garbagePatterns.some(pattern => pattern.test(text));
      }

      if (lang === 'Tamil') {
        // Check for common garbage patterns in Tamil
        const garbagePatterns = [
          /[a-zA-Z]{3,}/, // Latin characters (3+ consecutive)
          /[;%`¸£©÷ø¨]/,  // Common garbage symbols
          /USP|Á\|õh|Gs÷P|÷Áõ®|Euõµn|Po¨|ö\´|_¸UP|Âv|©hUøP|£¯ß£kzv/i, // Known Tamil garbage
          /[©£÷ø¨õ]{5,}/ // Too many Tamil-looking garbage chars in sequence
        ];
        return garbagePatterns.some(pattern => pattern.test(text));
      }

      return false;
    };

    // Log ALL generated questions before filtering
    console.log(`[Backend Gemini] 📋 RAW TEXT-GENERATED QUESTIONS (${questions.length} total):`);
    questions.forEach((q, index) => {
      const qType = (q.type || 'MCQ').toUpperCase();
      const qText = String(q.question || `Question ${index + 1}`).trim();
      const qAnswer = String(q.answer || '').trim();
      const qOptions = Array.isArray(q.options) ? q.options.map(String).filter(Boolean) : [];
      
      console.log(`[Backend Gemini] Text Question ${index + 1} (${qType}):`, {
        question: qText.substring(0, 100),
        answer: qAnswer.substring(0, 50),
        optionsCount: qOptions.length,
        options: qOptions.slice(0, 3).map(o => o.substring(0, 30)),
        fullQuestion: qText,
        fullAnswer: qAnswer,
        fullOptions: qOptions
      });
    });

    // Validate and fix FIIB questions to ensure they have options
    const validatedQuestions = questions.map((q, index) => {
      // Debug log to show field mapping for text generation
      console.log(`[Backend Gemini] 🔍 TEXT Field mapping for Question ${index + 1}:`, {
        originalFields: Object.keys(q),
        typeField: { type: q.type, question_type: q.question_type },
        questionField: { question: q.question, question_text: q.question_text },
        answerField: { answer: q.answer, correct_answer: q.correct_answer },
        finalValues: {
          type: q.type || 'MCQ',
          question: (q.question || q.question_text || 'No question').substring(0, 50),
          answer: (q.answer || q.correct_answer || 'EMPTY').substring(0, 30)
        }
      });

      // 🚨 CRITICAL: Check for empty answer field
      if (!q.answer && !q.correct_answer || (q.answer || q.correct_answer).trim() === '') {
        console.error(`[Backend] ❌ TEXT QUESTION REJECTED - EMPTY ANSWER:`, {
          questionIndex: index + 1,
          type: q.type || 'Unknown',
          question: q.question?.substring(0, 100) || 'No question',
          answer: q.answer || 'EMPTY',
          correct_answer: q.correct_answer || 'EMPTY',
          options: (q.options || []).slice(0, 2)
        });
        return null;
      }
      // Check for garbage characters in Sinhala/Tamil
      if (language === 'Sinhala' || language === 'Tamil') {
        const fieldsToCheck = [q.question, q.answer, ...(q.options || [])];
        const hasGarbage = fieldsToCheck.some(field => hasGarbageCharacters(field, language));

        if (hasGarbage) {
          console.error('[Backend] GARBAGE CHARACTERS DETECTED in question:', {
            language,
            question: q.question?.substring(0, 100),
            answer: q.answer?.substring(0, 50)
          });

          // Log this as an error for monitoring
          logGeminiParsingError(
            new Error('Garbage characters detected in generated question'),
            {
              apiEndpoint: 'generateQuestions',
              language,
              questionText: q.question,
              answerText: q.answer
            }
          ).catch(console.error);
        }
      }

      if (q.type === 'FIIB') {
        if (!Array.isArray(q.options) || q.options.length === 0) {
          console.warn('[Backend] FIIB question missing options, generating defaults:', q.question);
          // Generate default options if missing
          const answer = q.answer || 'answer';
          q.options = [
            answer,
            'option1',
            'option2',
            'option3',
            'option4'
          ];
        }
      }
      return q;
    });

    return validatedQuestions;

  } catch (error) {
    console.error('[generateQuestions] ❌ CRITICAL ERROR:', {
      errorMessage: error.message,
      errorName: error.name,
      errorStack: error.stack?.substring(0, 500),
      language: options.language,
      questionTypes: options.types,
      questionCount: options.count,
      contentLength: content?.length || 0
    });

    await logGeminiApiError(error, {
      apiEndpoint: 'generateContent',
      prompt: prompt?.substring(0, 500),
      language: options.language,
      questionTypes: options.types,
      questionCount: options.count,
      endpoint: 'generateQuestions'
    });

    // Re-throw the error instead of returning empty array
    throw new Error(`Question generation failed: ${error.message}`);
  }
};

/**
 * Generate mock questions (fallback)
 * @param {number} count - Number of questions
 * @param {string} reason - Reason for using mock data
 * @returns {Array} - Mock questions
 */
const generateMockQuestions = (count, reason = 'API unavailable') => {
  const mockQuestions = [
    {
      type: 'MCQ',
      difficulty: 'Easy',
      question: 'What is the primary function of mitochondria?',
      answer: 'Energy production',
      options: ['Energy production', 'Protein synthesis', 'DNA replication', 'Cell division']
    },
    {
      type: 'FIIB',
      difficulty: 'Intermediate',
      question: 'The powerhouse of the cell is called ___',
      answer: 'mitochondria'
    },
    {
      type: 'TF',
      difficulty: 'Easy',
      question: 'Cells are the basic unit of life',
      answer: 'True'
    },
    {
      type: 'HOQ',
      difficulty: 'Hard',
      question: 'Explain the process of cellular respiration',
      answer: 'Cellular respiration is a metabolic process that converts glucose into ATP...'
    },
    {
      type: 'Summary',
      difficulty: 'Intermediate',
      question: 'Summarize the main points about cell structure',
      answer: 'Cells contain nucleus, cytoplasm, and organelles...'
    }
  ];

  return mockQuestions.slice(0, count);
};

/**
 * Generate questions from uploaded file using Gemini Vision API
 * @param {string} fileUrl - Public URL of uploaded file
 * @param {string} fileType - File type (image, pdf, document)
 * @param {Object} options - Generation options
 * @returns {Promise<Array>} - Generated questions
 */
export const generateQuestionsFromFile = async (fileUrl, fileType, options = {}) => {
  try {
    const {
      count = 5,
      difficulty = 'Intermediate',
      types = ['MCQ', 'FIIB', 'TF', 'HOQ'],
      language = 'English',
      grade = 'Unknown',
      subject = 'Unknown',
      bloom_level = 'Understand',
      packTitle = '',
      packDescription = ''
    } = options;

    console.log(`[generateQuestionsFromFile] Starting generation for ${count} questions`, {
      fileType,
      language,
      types,
      packTitle: packTitle?.substring(0, 50),
      packDescription: packDescription?.substring(0, 100)
    });

    const buffer = await downloadAny(fileUrl);
    const base64Data = buffer.toString('base64');
    const mimeType = getMimeType(fileType, fileUrl);

    // Calculate type distribution
    const typeCounts = calculateTypeCounts(count, types, options.counts);
    console.log(`[generateQuestionsFromFile] Type distribution:`, typeCounts);

    let allQuestions = [];

    // TRY 1: Direct Vision API with pack context (most reliable for Tamil/Sinhala)
    try {
      console.log(`[generateQuestionsFromFile] Attempt 1: Using Vision API with pack context`);

      const visionQuestions = await generateQuestionsFromVision(base64Data, mimeType, {
        count: count,
        difficulty,
        types: types,
        counts: typeCounts,
        language,
        bloom_level,
        packTitle,
        packDescription
      });

      console.log(`[generateQuestionsFromFile] Vision API generated ${visionQuestions?.length || 0} questions`);

      if (visionQuestions && visionQuestions.length > 0) {
        allQuestions = visionQuestions.slice(0, count);
      }
    } catch (visionError) {
      console.error(`[generateQuestionsFromFile] Vision API failed:`, visionError.message);
    }

    // TRY 2: If Vision didn't produce enough questions, try text extraction
    if (allQuestions.length < count) {
      try {
        console.log(`[generateQuestionsFromFile] Attempt 2: Trying text extraction (need ${count - allQuestions.length} more)`);

        let text = '';
        try {
          text = await extractTextFromFile(base64Data, mimeType);
          console.log(`[generateQuestionsFromFile] Text extraction successful, length: ${text?.length || 0}`);
        } catch (textError) {
          console.warn(`[generateQuestionsFromFile] Text extraction failed, using buffer:`, textError.message);
          text = buffer.toString('utf-8').substring(0, 50000); // Safety limit
        }

        if (text && text.trim().length > 100) {
          const remaining = count - allQuestions.length;
          const textQuestions = await generateQuestions(text, {
            count: Math.min(remaining * 2, 40), // Generate extra but cap at 40
            difficulty,
            types: types,
            counts: typeCounts,
            language,
            bloom_level,
            packTitle,
            packDescription
          });

          console.log(`[generateQuestionsFromFile] Text-based generated ${textQuestions?.length || 0} questions`);

          // Add unique questions
          const existingTexts = new Set(allQuestions.map(q => q.question));
          const newQuestions = textQuestions
            .filter(q => !existingTexts.has(q.question))
            .slice(0, remaining);

          allQuestions.push(...newQuestions);
          console.log(`[generateQuestionsFromFile] Added ${newQuestions.length} text-based questions`);
        }
      } catch (textError) {
        console.error(`[generateQuestionsFromFile] Text-based generation failed:`, textError.message);
      }
    }

    // TRY 3: Final fallback - Vision without context
    if (allQuestions.length < Math.floor(count * 0.5)) {
      try {
        console.log(`[generateQuestionsFromFile] Attempt 3: Final fallback without context (have ${allQuestions.length}, need at least ${count})`);

        const remaining = count - allQuestions.length;
        const fallbackQuestions = await generateQuestionsFromVision(base64Data, mimeType, {
          count: Math.min(remaining * 3, 60), // Generate more for filtering
          difficulty,
          types: types,
          language,
          bloom_level
          // No pack context for fallback
        });

        console.log(`[generateQuestionsFromFile] Fallback generated ${fallbackQuestions?.length || 0} questions`);

        // Add unique questions with type distribution
        const existingTexts = new Set(allQuestions.map(q => q.question));
        const typeBuckets = {};
        types.forEach(type => typeBuckets[type] = []);

        // Sort fallback questions by type
        fallbackQuestions.forEach(q => {
          const qType = q.type || q.question_type;
          if (typeBuckets[qType] && existingTexts.has(q.question) === false) {
            typeBuckets[qType].push(q);
          }
        });

        // Add questions respecting type distribution
        let added = 0;
        const maxToAdd = remaining;

        for (const type of types) {
          if (added >= maxToAdd) break;

          const requested = typeCounts[type] || 0;
          const currentCount = allQuestions.filter(q => (q.type || q.question_type) === type).length;
          const needed = Math.max(0, requested - currentCount);
          const available = typeBuckets[type] || [];
          const toAdd = Math.min(needed, available.length, maxToAdd - added);

          if (toAdd > 0) {
            allQuestions.push(...available.slice(0, toAdd));
            added += toAdd;
            console.log(`[generateQuestionsFromFile] Added ${toAdd} ${type} questions from fallback`);
          }
        }
      } catch (fallbackError) {
        console.error(`[generateQuestionsFromFile] Final fallback failed:`, fallbackError.message);
      }
    }

    // Filter questions to ONLY include requested types
    const filteredQuestions = allQuestions.filter(q => {
      const qType = q.type || q.question_type;
      return types.includes(qType);
    });

    console.log(`[generateQuestionsFromFile] Type filtering: ${filteredQuestions.length}/${allQuestions.length} questions match requested types [${types.join(', ')}]`);

    // If we don't have enough questions after filtering, generate more
    if (filteredQuestions.length < count) {
      const shortage = count - filteredQuestions.length;
      console.log(`[generateQuestionsFromFile] Need ${shortage} more questions after filtering, generating additional questions...`);
      
      try {
        const additionalQuestions = await generateQuestions(buffer.toString('utf-8').substring(0, 50000), {
          count: Math.min(shortage * 2, 40), // Generate extra to account for potential filtering
          difficulty,
          types: types, // Only requested types
          language,
          bloom_level,
          packTitle,
          packDescription
        });

        console.log(`[generateQuestionsFromFile] Generated ${additionalQuestions?.length || 0} additional questions`);

        if (additionalQuestions && additionalQuestions.length > 0) {
          // Filter the additional questions too
          const filteredAdditional = additionalQuestions.filter(q => {
            const qType = q.type || q.question_type;
            return types.includes(qType);
          });

          console.log(`[generateQuestionsFromFile] Additional filtering: ${filteredAdditional.length}/${additionalQuestions.length} questions match requested types`);
          
          // Add the filtered additional questions
          filteredQuestions.push(...filteredAdditional);
        }
      } catch (additionalError) {
        console.error(`[generateQuestionsFromFile] Failed to generate additional questions:`, additionalError.message);
      }
    }

    // Final validation and limiting
    const finalQuestions = filteredQuestions.slice(0, count);

    // Ensure type distribution as close as possible to requested
    const distributedQuestions = distributeQuestionsByType(finalQuestions, typeCounts, count);

    console.log(`[generateQuestionsFromFile] Final result: ${distributedQuestions.length}/${count} questions`);

    // Log type distribution
    const finalDistribution = distributedQuestions.reduce((acc, q) => {
      const type = q.type || q.question_type;
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    console.log(`[generateQuestionsFromFile] Final type distribution:`, finalDistribution);

    // Attach metadata
    return distributedQuestions.map(q => ({
      ...q,
      metadata: {
        language: language,
        grade: grade,
        subject: subject,
        packTitle: packTitle,
        packDescription: packDescription
      }
    }));

  } catch (error) {
    console.error('[Backend Gemini] ❌ CRITICAL ERROR in generateQuestionsFromFile:', {
      errorMessage: error.message,
      fileType,
      language: options.language,
      questionCount: options.count
    });

    await logGeminiApiError(error, {
      apiEndpoint: 'generateQuestionsFromFile',
      fileType,
      language: options.language,
      questionCount: options.count,
      endpoint: 'generateQuestionsFromFile'
    });

    // Return empty array instead of throwing to prevent complete failure
    return [];
  }
};

// Helper function to calculate type counts
function calculateTypeCounts(totalCount, types, customCounts = {}) {
  if (customCounts && Object.keys(customCounts).length > 0) {
    return customCounts;
  }

  const typeCounts = {};
  const baseCount = Math.floor(totalCount / types.length);
  const remainder = totalCount % types.length;

  types.forEach((type, index) => {
    typeCounts[type] = index < remainder ? baseCount + 1 : baseCount;
  });

  return typeCounts;
}

// Helper function to distribute questions by type
function distributeQuestionsByType(questions, typeCounts, totalCount) {
  const typeBuckets = {};
  Object.keys(typeCounts).forEach(type => typeBuckets[type] = []);

  // Sort questions into type buckets
  questions.forEach(q => {
    const type = q.type || q.question_type;
    if (typeBuckets[type]) {
      typeBuckets[type].push(q);
    }
  });

  const result = [];

  // Add questions up to requested counts
  Object.entries(typeCounts).forEach(([type, count]) => {
    const available = typeBuckets[type] || [];
    const toTake = Math.min(count, available.length);
    result.push(...available.slice(0, toTake));
  });

  // If we have space, add remaining questions
  if (result.length < totalCount) {
    const remaining = totalCount - result.length;
    const allRemaining = questions.filter(q => !result.includes(q));
    result.push(...allRemaining.slice(0, remaining));
  }

  return result.slice(0, totalCount);
}

/**
 * Generate questions from image/PDF using Gemini Vision API
 */
export const generateQuestionsFromVision = async (base64Data, mimeType, params = {}) => {
  const {
    count = 5,
    difficulty = 'Intermediate',
    types = ['MCQ', 'FIIB', 'TF', 'HOQ'],
    language = 'English',
    bloom_level = 'Understand',
    counts = {},
    packTitle = '',
    packDescription = ''
  } = params;

  console.log('packTitle:', packTitle);
  console.log('packDescription:', packDescription);

  const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

  // Build type-specific count requirements
  let typeRequirements = '';
  if (Object.keys(counts).length > 0) {
    typeRequirements = '\n\nEXACT QUESTION TYPE COUNTS REQUIRED:\n';
    Object.entries(counts).forEach(([type, cnt]) => {
      if (cnt > 0) {
        typeRequirements += `- Generate EXACTLY ${cnt} ${type} questions\n`;
      }
    });
  } else {
    typeRequirements = `\n\nGenerate EXACTLY ${count} questions using these types: ${types.join(', ')}`;
  }
  const packScopePrompt = packTitle ? `
🚨 VISION CONTEXT SCOPING:

YOU ARE ANALYZING: "${packTitle}"
${packDescription ? `SPECIFIC CONTEXT: ${packDescription}` : ''}

**RESTRICTION:** Generate questions ONLY from this specific learning pack's content.
**PROHIBITED:** Ignore other chapters, sections, or general knowledge.
**FOCUS:** Extract and question ONLY the material relevant to "${packTitle}"

` : '';

  const prompt = `SYSTEM:
You are EduQuestLab, a multilingual pedagogy-aware generator. Analyze the provided document/image and generate educational questions.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 SCHOOL TEXTBOOK MATH NOTATION (STRICT)
- Do NOT use caret notation "^" anywhere. (Forbidden: a^m, (a^m)^n, a^(mn))
- Use superscripts only: aᵐ, aⁿ, 2³, 5², 2¹²
- Power of a power MUST be written as: (aᵐ)ⁿ = aᵐⁿ
  Example: (2³)⁴ = 2¹²  (you may show: (2³)⁴ = 2³×⁴ = 2¹²)
- If you cannot follow this notation, regenerate the question.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━


🚨 CRITICAL UNICODE REQUIREMENT FOR SINHALA/TAMIL:
${language === 'Sinhala' || language === 'Tamil' ? `
⚠️ ABSOLUTE REQUIREMENT: You MUST output PURE Unicode characters. NO EXCEPTIONS.

**FORBIDDEN OUTPUT (GARBAGE - DO NOT PRODUCE):**
❌ "f.da,hlska odr fyda YS¾I"
❌ ";d;aúl ixLHd"
❌ "o¾Yl yd ,>q.Kl"
❌ "fkdñ,a fnod yeÿ"
❌ ">k jia;=j,"
❌ "iudka;r f¾Ld"

**REQUIRED OUTPUT (Proper Unicode):**
${language === 'Sinhala' ? '✅ Sinhala: "පළමු පරිච්ඡේදය", "ගණිතය", "සංඛ්‍යා පද්ධති", "වීජ ගණිතය"' : ''}
${language === 'Tamil' ? '✅ Tamil: "முதல் அத்தியாயம்", "கணிதம்", "எண் முறைகள்", "இயற்கணிதம்"' : ''}

**SELF-VALIDATION BEFORE RESPONDING:**
1. Does my output contain characters from the CORRECT Unicode range?
   - Sinhala: U+0D80 to U+0DFF (ක ග ච ජ ට ඩ ණ ත ද න ප බ ම ය ර ල ව ශ ෂ ස හ ළ)
   - Tamil: U+0B80 to U+0BFF (க ங ச ஞ ட ண த ந ப ம ய ர ல வ ழ ள ற ன)
2. Do the words look like real ${language} words (not Latin gibberish)?
3. Would a native speaker recognize these as proper words?

If ANY answer is NO, you MUST re-read the image and try again.

⚠️ CRITICAL: Questions with garbage characters will be REJECTED. Generate ONLY clean Unicode!
⚠️ If you generate garbage, the user will receive FEWER questions than requested!
⚠️ DOUBLE-CHECK every character before responding!
` : ''}

TASK:
Generate questions strictly from the provided document/image content.
${packScopePrompt}

${typeRequirements}

⚠️ IMPORTANT: Generate EXACTLY the requested number of questions. Do NOT generate extra.
⚠️ ALL questions must be clean and valid - garbage questions will be rejected!
- NEVER include grade levels in question text
- NEVER use phrases like "according to the document", "based on the content", "in this text", "as shown", "as mentioned"
- NEVER refer to "the document", "the content", "the text", "the image", "the file", or "the uploaded material"
- NEVER start explanations with "According to...", "As mentioned in...", "As shown in...", "Based on..."
- Focus ONLY on the actual concepts and knowledge
- Write questions as if testing pure understanding, not document navigation
- Write explanations as if they are from a textbook - these are established facts
- Example: Instead of "According to Figure 2.1, what is...", write "What is..."
- Example: Instead of "On page 15, the text states...", write "The concept states..."
- Example GOOD: "Water boils at 100°C at sea level due to atmospheric pressure."
- Example BAD: "Based on the uploaded file, water boils at 100°C."
- Example BAD: "According to the document, water boils at 100°C."
- Example BAD: "As mentioned in the text, water boils at 100°C."

Constraints:
- All text must be in ${language}. ${language === 'Sinhala' || language === 'Tamil' ? 'Use PURE Unicode only - NO garbage characters!' : ''}

- ⚠️ CRITICAL: Generate ONLY these question types: ${types.join(', ')} - NO OTHER TYPES ALLOWED!

Question Format Requirements:
1. MCQ (Multiple Choice):
   - question_type: "MCQ"
   - question_text: The question
   - correct_answer: The correct answer
   - options: Array of 4 options (including the correct answer)
   - explanation: WHY the correct answer is correct (2-3 sentences explaining the reasoning)

2. FIIB (Fill In The Blank):
   - question_type: "FIIB"
   - question_text: Text with ___ for blank (e.g., "The capital of France is ___")
   - correct_answer: The correct word/phrase to fill the blank
   - options: REQUIRED Array of 4-6 possible answers (MUST include correct answer and distractors) for drag-and-drop
   - explanation: WHY this answer fills the blank correctly (2-3 sentences)
   - ⚠️ CRITICAL: FIIB questions MUST have an options array - this is mandatory!

3. TF (True/False):
   - question_type: "TF"
   - question_text: A statement
   - correct_answer: "True" or "False"
   - explanation: WHY the statement is true or false (2-3 sentences with evidence)

4. HOQ (Higher Order Question - Open-ended):
   - question_type: "HOQ"
   - question_text: An analytical, evaluative, or creative question requiring extended response
   - correct_answer: A SHORT, concise model answer (1-2 sentences ONLY) demonstrating key understanding
   - explanation: REQUIRED - Brief guidance on key points to include (2 sentences in ${language})
   - Example HOQ explanation: "A good answer should identify the main causes and provide one specific example. This question assesses critical thinking and analysis skills."

⚠️ CRITICAL: ALL questions MUST include an "explanation" field in ${language}!
⚠️ HOQ questions MUST have detailed explanations that guide students on how to approach the answer!

OUTPUT FORMAT: Return ONLY a valid JSON array. Example for FIIB:
[{
  "question_type": "FIIB",
  "difficulty": "Medium",
  "blooms_taxonomy": "Understand",
  "question_text": "The process of converting light energy into chemical energy is called ___",
  "correct_answer": "photosynthesis",
  "options": ["photosynthesis", "respiration", "digestion", "transpiration", "fermentation"],
  "explanation": "Photosynthesis is the process by which plants convert light energy from the sun into chemical energy stored in glucose. This occurs in the chloroplasts of plant cells using chlorophyll."
}]

IMPORTANT: Respect the exact question type counts requested above!`;
  let normalizedMimeType = mimeType;
  if (!normalizedMimeType || normalizedMimeType === 'application/octet-stream') {
    normalizedMimeType = 'application/pdf'; // adjust if you also support images
  }

  const imagePart = {
    inlineData: {
      data: base64Data,
      mimeType: normalizedMimeType
    }
  };

  // Add debug logging for pack context
  console.log('[generateQuestionsFromVision] DEBUG - Pack Context:', {
    packTitle: packTitle ? `"${packTitle}"` : 'not provided',
    packDescription: packDescription ? `"${packDescription.substring(0, 50)}${packDescription.length > 50 ? '...' : ''}"` : 'not provided'
  });

  try {
    const result = await model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();

    // Parse JSON response with better error handling
    let jsonText = text.trim();

    // Try to extract JSON from markdown code blocks
    const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ||
      jsonText.match(/\[[\s\S]*\]/);

    if (!jsonMatch) {
      await logGeminiParsingError(
        new Error('No valid JSON array found in response'),
        {
          apiEndpoint: 'generateContent',
          prompt: prompt.substring(0, 500),
          responseText: text.substring(0, 1000),
          fileType: mimeType,
          language,
          questionTypes: types,
          questionCount: count
        }
      );
      throw new Error('No valid JSON array found in response');
    }

    // Clean and parse the JSON
    let questions;
    try {
      const jsonStr = (jsonMatch[1] || jsonMatch[0]).trim();
      questions = JSON.parse(jsonStr);

      if (!Array.isArray(questions)) {
        throw new Error('Expected an array of questions');
      }
    } catch (parseError) {
      console.error('[Backend Gemini] JSON parse error:', parseError);
      throw new Error(`Failed to parse questions: ${parseError.message}`);
    }

    // Log ALL generated Vision questions before filtering
    console.log(`[Backend Gemini] 📋 RAW VISION-GENERATED QUESTIONS (${questions.length} total):`);
    questions.forEach((q, index) => {
      const qType = (q.type || q.question_type || 'MCQ').toUpperCase();
      const qText = String(q.question || q.question_text || `Question ${index + 1}`).trim();
      const qAnswer = String(q.answer || q.correct_answer || '').trim();
      const qOptions = Array.isArray(q.options) ? q.options.map(String).filter(Boolean) : [];

      console.log(`[Backend Gemini] Vision Question ${index + 1} (${qType}):`, {
        question: qText.substring(0, 100),
        answer: qAnswer.substring(0, 50),
        optionsCount: qOptions.length,
        options: qOptions.slice(0, 3).map(o => o.substring(0, 30)),
        fullQuestion: qText,
        fullAnswer: qAnswer,
        fullOptions: qOptions
      });
    });

    // Process and validate questions (don't slice yet - we need to account for rejections)
    const processedQuestions = questions.map((q, index) => {
      const questionType = (q.type || q.question_type || 'MCQ').toUpperCase();
      const validTypes = ['MCQ', 'FIIB', 'TF', 'HOQ'];

      if (!validTypes.includes(questionType)) {
        console.warn(`[Backend Gemini] Invalid question type: ${questionType}, defaulting to MCQ`);
      }

      const finalType = validTypes.includes(questionType) ? questionType : 'MCQ';
      let questionText = String(q.question || q.question_text || `Question ${index + 1}`).trim();
      let answer = String(q.answer || q.correct_answer || '').trim();
      let options = Array.isArray(q.options) ? q.options.map(String).filter(Boolean) : [];

      // Debug log for HOQ questions
      if (finalType === 'HOQ') {
        console.log(`[Backend Gemini] 🔍 Processing HOQ question ${index + 1}:`, {
          question: questionText.substring(0, 100),
          answer: answer.substring(0, 100),
          language
        });
      }

      // 🚨 CRITICAL: Validate Sinhala/Tamil Unicode - REJECT garbage characters
      if (language === 'Sinhala' || language === 'Tamil') {
        const garbagePatterns = /fkd[ñ,a]|fnod|yeÿ|iyd|ksoi|mqkl|wdh|kfh|bEö|fjk|;d;a|o¾Y|,>q\.|>k jia|mDIaG|mßud|oaúm|ùÔh|iudka;r|f¾Ld|m%;s|fldgia|YS¾I|msróvhla|hehs|lshkq|,efnkafka|nyq-wi%dldr|wdOdrlhlata|;%sfldaKdldr|uqyqK;a|lshk|fmdÿ|,laIHhlg|hd ùu|u\.ska|we;sjk|iup;=ri%dldr|wdOdrlhla|Rcq msróvhl|uq¿|j¾\.M,h|iQ;%fhka|,ndfok|,ïn Wi|iïnkaO;dj|úia;r|me;a;l|;s%fldaKdldr|uqyqK;l|flakaøh|YS¾Ih olajd|ÿr fõ|mhs;\.ria|m%fïhh|Ndú;fhka|oelafõ|tneúka|meyeÈ,s|ms<sn\|j|iklaldfha|oelafjk|ksjerÈ|m%ldYh|jkafka|ljr o\?|jD;a;dldr|b;sß|ish,a,|p;=ri%dldr|yudre/;

        const hasGarbage = garbagePatterns.test(questionText) ||
          garbagePatterns.test(answer) ||
          options.some(opt => garbagePatterns.test(opt));

        if (hasGarbage) {
          logGeminiValidationError(
            'Question contains garbage characters',
            {
              apiEndpoint: 'generateContent',
              language,
              garbagePatterns: Array.from(questionText.match(garbagePatterns) || []).slice(0, 5),
              contentSample: questionText.substring(0, 200),
              validationRules: 'Sinhala/Tamil Unicode validation',
              metadata: {
                questionType: finalType,
                questionIndex: index
              }
            }
          );
          console.error(`[Backend Gemini] ❌ REJECTED Question ${index + 1} (${finalType}) - Contains garbage characters:`, {
            question: questionText.substring(0, 100),
            language
          });

          if (finalType === 'HOQ') {
            console.error(`[Backend Gemini] ⚠️ HOQ question was rejected! This is why it's not displayed.`);
          }

          // Skip this question - it will not be included in the final array
          return null;
        }

        // Validate proper Unicode range
        const hasProperUnicode = language === 'Sinhala'
          ? /[\u0D80-\u0DFF]{3,}/.test(questionText)
          : /[\u0B80-\u0BFF]{3,}/.test(questionText);

        if (!hasProperUnicode) {
          console.warn(`[Backend Gemini] ⚠️ Question ${index + 1} missing proper ${language} Unicode:`, questionText.substring(0, 50));
        }
      }

      // Validate FIIB questions have options
      if (finalType === 'FIIB') {
        if (!options || options.length === 0) {
          console.warn('[Backend Gemini] FIIB question missing options, generating defaults:', questionText.substring(0, 50));
          // Generate default options if missing
          options = [
            answer,
            'option1',
            'option2',
            'option3',
            'option4'
          ];
        }
        console.log('[Backend Gemini] Vision FIIB question validated:', {
          question: questionText.substring(0, 50),
          answer: answer,
          optionsCount: options.length
        });
      }

      // Add True/False options for TF questions
      if (finalType === 'TF') {
        options = ['True', 'False'];
        // Normalize answer to "True" or "False"
        if (answer.toLowerCase().includes('true') || answer.toLowerCase() === 't') {
          answer = 'True';
        } else if (answer.toLowerCase().includes('false') || answer.toLowerCase() === 'f') {
          answer = 'False';
        }
        console.log('[Backend Gemini] TF question validated:', {
          question: questionText.substring(0, 50),
          answer: answer,
          options: options
        });
      }

      // ✅ CRITICAL: Ensure ALL questions have explanations
      let explanation = q.explanation || q.reasoning || '';

      // Generate default explanation if missing
      if (!explanation || explanation.trim().length < 10) {
        console.warn(`[Backend Gemini] Question ${index + 1} missing explanation, generating default`);

        // Generate type-specific default explanations
        if (finalType === 'MCQ') {
          explanation = `The correct answer is "${answer}" based on the content provided.`;
        } else if (finalType === 'FIIB') {
          explanation = `"${answer}" correctly fills the blank in this context.`;
        } else if (finalType === 'TF') {
          explanation = `This statement is ${answer} according to the source material.`;
        } else if (finalType === 'HOQ') {
          explanation = `This answer addresses the key concepts and demonstrates understanding of the topic.`;
        }
      }

      return {
        id: `gen-${Date.now()}-${index}`,
        type: finalType,
        difficulty: ['Easy', 'Intermediate', 'Hard'].includes(q.difficulty)
          ? q.difficulty
          : difficulty,
        blooms_taxonomy: [
          'Remember', 'Understand', 'Apply',
          'Analyze', 'Evaluate', 'Create'
        ].includes(q.blooms_taxonomy) ? q.blooms_taxonomy : bloom_level,
        question: questionText,
        answer: answer,
        options: options,
        explanation: explanation, // ✅ ALWAYS has a value now
        generated: true,
        source: 'gemini-vision'
      };
    });

    // Filter out null values (rejected questions with garbage characters)
    const validQuestions = processedQuestions.filter(q => q !== null);

    const rejectedCount = processedQuestions.length - validQuestions.length;
    if (rejectedCount > 0) {
      console.warn(`[Backend Gemini] ⚠️ Rejected ${rejectedCount} questions due to garbage characters`);
      console.warn(`[Backend Gemini] Valid questions: ${validQuestions.length}, Requested: ${count}`);

      // If we rejected too many and don't have enough valid questions, warn the user
      if (validQuestions.length < count * 0.5) {
        console.error(`[Backend Gemini] ❌ CRITICAL: Only ${validQuestions.length}/${count} valid questions generated!`);
        console.error(`[Backend Gemini] The PDF may have encoding issues. Consider re-scanning or using a different file.`);
      }
    }

    // Log question type distribution
    const typeDistribution = validQuestions.reduce((acc, q) => {
      acc[q.type] = (acc[q.type] || 0) + 1;
      return acc;
    }, {});
    console.log(`[Backend Gemini] Question type distribution:`, typeDistribution);
    console.log(`[Backend Gemini] Successfully generated ${validQuestions.length} valid questions (${rejectedCount} rejected)`);

    return validQuestions;

  } catch (error) {
    await logGeminiApiError(error, {
      apiEndpoint: 'generateContent',
      prompt: prompt?.substring(0, 500),
      fileType: mimeType,
      language,
      questionTypes: types,
      questionCount: count,
      endpoint: 'generateQuestionsFromVision',
      metadata: {
        promptLength: prompt?.length,
        responseLength: text?.length
      }
    });
    console.error('[Backend Gemini] Vision question generation error:', error);
    return [];
  }
}

/**
 * Get MIME type from file type and URL
 * @param {string} fileType - File type
 * @param {string} fileUrl - File URL
 * @returns {string} - MIME type
 */
const getMimeType = (fileType, fileUrl) => {
  // Strip query string (e.g. ?token=...)
  const cleanUrl = fileUrl.split('?')[0];
  const extension = cleanUrl.split('.').pop().toLowerCase();

  const mimeTypes = {
    // Images
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    // Documents
    pdf: 'application/pdf',
    txt: 'text/plain',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  };

  return mimeTypes[extension] || 'application/octet-stream';
};

export { detectLanguageFromText };

export default {
  generateQuestions,
  generateQuestionsFromFile,
  generateStructuredMaterialFromFile,
  generateLearningPackFromBase64,
  generateLearningPacksFromBase64
};
//save
