const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const os = require('os');

let genai = null;

function getGenAI() {
  if (genai) return genai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  genai = new GoogleGenAI({ apiKey });
  return genai;
}

/**
 * Generate a b-roll image from a description using Gemini Imagen
 * @param {object} params
 * @param {string} params.description - Description of the image to generate
 * @param {string} params.brandName - Brand name for context
 * @param {string} params.outputDir - Directory to save image
 * @returns {Promise<string>} Path to generated image
 */
async function generateBrollImage({ description, brandName, outputDir }) {
  const ai = getGenAI();

  const prompt = `Professional, cinematic b-roll image for a ${brandName || 'brand'} customer experience video: ${description}.
Style: Clean, modern, high-quality stock photography look. 16:9 aspect ratio.
Warm, inviting lighting. No text or logos.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash-exp',
      contents: prompt,
      config: {
        responseModalities: ['IMAGE', 'TEXT'],
      },
    });

    // Check if image was generated
    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);

    if (imagePart && imagePart.inlineData) {
      const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
      const filename = `broll_${Date.now()}.png`;
      const outputPath = path.join(outputDir || os.tmpdir(), filename);
      fs.writeFileSync(outputPath, imageBuffer);
      return outputPath;
    }

    // Fallback: generate a simple gradient placeholder
    return generatePlaceholderImage({ description, brandName, outputDir });
  } catch (err) {
    console.warn(`B-roll generation failed: ${err.message}. Using placeholder.`);
    return generatePlaceholderImage({ description, brandName, outputDir });
  }
}

/**
 * Generate a placeholder image when AI image generation fails
 * Creates a simple branded gradient image with text
 */
function generatePlaceholderImage({ description, brandName, outputDir }) {
  // We'll create a simple SVG and save it — FFmpeg can handle SVG input
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" style="stop-color:#032D60;stop-opacity:1" />
        <stop offset="100%" style="stop-color:#0176D3;stop-opacity:1" />
      </linearGradient>
    </defs>
    <rect width="1920" height="1080" fill="url(#bg)"/>
    <text x="960" y="500" text-anchor="middle" fill="white" font-family="Arial" font-size="48" font-weight="bold">${escapeXml(brandName || 'Video Builder')}</text>
    <text x="960" y="580" text-anchor="middle" fill="rgba(255,255,255,0.6)" font-family="Arial" font-size="24">${escapeXml(truncate(description || '', 80))}</text>
  </svg>`;

  const filename = `broll_placeholder_${Date.now()}.svg`;
  const outputPath = path.join(outputDir || os.tmpdir(), filename);
  fs.writeFileSync(outputPath, svg);
  return outputPath;
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(str, maxLen) {
  return str.length > maxLen ? str.substring(0, maxLen) + '...' : str;
}

/**
 * Generate all b-roll images for a video
 * @param {Array} segments - B-roll segments from script
 * @param {string} brandName
 * @param {string} outputDir
 * @param {function} onProgress
 * @returns {Promise<Array>} Array of { order, imagePath }
 */
async function generateAllBroll(segments, brandName, outputDir, onProgress) {
  const results = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    console.log(`Generating b-roll ${i + 1}/${segments.length}: ${seg.brollDescription?.substring(0, 50)}...`);

    const imagePath = await generateBrollImage({
      description: seg.brollDescription || 'Professional lifestyle image',
      brandName,
      outputDir,
    });

    results.push({
      order: seg.order,
      imagePath,
    });

    if (onProgress) onProgress(i + 1, segments.length);
  }

  return results;
}

module.exports = { generateBrollImage, generateAllBroll };
