const { GoogleGenAI } = require("@google/genai");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const REQUEST_TIMEOUT_MS = 60000;

function getGeminiApiKeys() {
  const keys = [];
  if (process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY);
  }
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`GEMINI_API_KEY_${i}`];
    if (key) keys.push(key);
  }
  console.log(`✅ Loaded ${keys.length} Gemini API key(s)`);
  return keys;
}

class GeminiService {
  constructor() {
    this.apiKeys = [];
    this.currentKeyIndex = 0;
    this.client = null;
    this.keyStatus = [];
  }

  initialize() {
    this.apiKeys = getGeminiApiKeys();
    if (this.apiKeys.length === 0) {
      throw new Error("No Gemini API keys configured");
    }
    this.keyStatus = this.apiKeys.map((_, index) => ({
      index,
      available: true,
      lastError: null,
      errorCount: 0,
    }));
    this.rotateClient();
  }

  rotateClient() {
    if (this.apiKeys.length === 0) {
      throw new Error("No API keys available");
    }
    let attempts = 0;
    while (attempts < this.apiKeys.length) {
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
      const keyInfo = this.keyStatus[this.currentKeyIndex];
      if (keyInfo.available) {
        const key = this.apiKeys[this.currentKeyIndex];
        this.client = new GoogleGenAI({ apiKey: key });
        console.log(`🔄 Switched to Gemini API key #${this.currentKeyIndex + 1}`);
        return;
      }
      attempts++;
    }
    throw new Error("All Gemini API keys are exhausted or unavailable");
  }

  markKeyExhausted(error) {
    const keyInfo = this.keyStatus[this.currentKeyIndex];
    keyInfo.errorCount++;
    keyInfo.lastError = error.message;
    if (
      error.message.includes("quota") ||
      error.message.includes("429") ||
      error.message.includes("RESOURCE_EXHAUSTED")
    ) {
      keyInfo.available = false;
      console.error(`❌ Key #${this.currentKeyIndex + 1} exhausted: ${error.message}`);
    }
  }

  getAllKeyStatus() {
    return this.keyStatus.map((status, i) => ({
      keyNumber: i + 1,
      available: status.available,
      errorCount: status.errorCount,
      lastError: status.lastError,
    }));
  }

  withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timeout")), ms)
      ),
    ]);
  }

  async withRetry(operation, attempt = 0) {
    try {
      return await this.withTimeout(operation(), REQUEST_TIMEOUT_MS);
    } catch (error) {
      const errorMessage = error.message || "";
      const isQuotaError =
        errorMessage.includes("quota") ||
        errorMessage.includes("429") ||
        errorMessage.includes("RESOURCE_EXHAUSTED") ||
        errorMessage.includes("rate limit");
      const retryableErrors = ["503", "timeout", "network", "ECONNRESET", "ETIMEDOUT", "UNAVAILABLE"];
      const isRetryable = retryableErrors.some((code) =>
        errorMessage.toLowerCase().includes(code.toLowerCase())
      );

      if (isQuotaError) {
        console.warn(`⚠️ Quota exceeded on key #${this.currentKeyIndex + 1}`);
        this.markKeyExhausted(error);
        try {
          this.rotateClient();
          console.log("🔄 Retrying with new key...");
          return await this.withRetry(operation, 0);
        } catch (rotateError) {
          throw new Error("All Gemini API keys have exceeded quota");
        }
      }

      if (isRetryable && attempt < MAX_RETRIES) {
        console.warn(`⚠️ Retry ${attempt + 1}/${MAX_RETRIES}: ${errorMessage}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        return this.withRetry(operation, attempt + 1);
      }

      throw error;
    }
  }

  async analyzeCode(systemPrompt, userPrompt, options = {}) {
    if (!this.client) {
      this.initialize();
    }

    const operation = async () => {
      const modelName = options.model || "gemini-2.5-flash";
      
      const maxTokens = options.maxTokens || 16000; 

      console.log(`🤖 Gemini Request | Model: ${modelName} | Max Tokens: ${maxTokens} | Prompt: ${userPrompt.length} chars`);

      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      const result = await this.client.models.generateContent({
        model: modelName,
        contents: [
          {
            role: "user",
            parts: [{ text: fullPrompt }],
          },
        ],
        config: {
          maxOutputTokens: maxTokens,
          temperature: options.temperature || 0.5,
          topP: 0.95,
          topK: 40,
          responseMimeType: options.jsonMode ? "application/json" : "text/plain",
          responseSchema: options.jsonMode
            ? {
                type: "object",
                properties: {
                  issues: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        issueType: { type: "string" },
                        severity: { type: "string" },
                        filePath: { type: "string" },
                        lineNumber: { type: "number" },
                        codeSnippet: { type: "string" },
                        aiConfidence: { type: "number" },
                        aiExplanation: { type: "string" },
                        suggestedFix: { type: "string" },
                      },
                      required: ["title", "description", "issueType", "severity", "filePath"],
                    },
                  },
                },
                required: ["issues"],
              }
            : undefined,
        },
      });

      const responseText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!responseText) {
        console.error("❌ Empty response structure:", JSON.stringify(result, null, 2));
        throw new Error("Empty response from Gemini");
      }

      const finishReason = result?.candidates?.[0]?.finishReason;
      if (finishReason === "MAX_TOKENS" || finishReason === "SAFETY") {
        console.warn(`⚠️ Response truncated: ${finishReason}`);
        console.warn(`⚠️ Response length: ${responseText.length} chars`);
      }

      const text = responseText.trim();
      console.log(`✅ Gemini Response | Length: ${text.length} chars | Finish: ${finishReason || 'STOP'}`);

      return {
        text,
        usage: result.usageMetadata || null,
        finishReason: finishReason,
      };
    };

    return await this.withRetry(operation);
  }

  async generateFix(systemPrompt, userPrompt, options = {}) {
    return await this.analyzeCode(systemPrompt, userPrompt, {
      ...options,
      model: options.model || "gemini-2.5-flash",
      temperature: 0.2,
      maxTokens: 8000,
    });
  }

  extractJSON(text) {
    if (!text) throw new Error("Empty response");

    const cleanText = text.trim();
    console.log(`🔄 Attempting to parse response: ${cleanText.slice(0, 200)}...`);

    try {
      const parsed = JSON.parse(cleanText);
      console.log("✅ Successfully parsed JSON directly");
      return parsed;
    } catch (directErr) {
      console.log(`⚠️ Direct parse failed: ${directErr.message}`);
    }

    const codeBlockMatch = cleanText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        console.log("✅ Successfully parsed JSON from code block");
        return parsed;
      } catch (blockErr) {
        console.log(`⚠️ Code block parse failed: ${blockErr.message}`);
      }
    }

    const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        let cleaned = jsonMatch[0]
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") 
          .replace(/,\s*}/g, "}") 
          .replace(/,\s*\]/g, "]"); 

        const parsed = JSON.parse(cleaned);
        console.log("✅ Successfully parsed cleaned JSON");
        return parsed;
      } catch (cleanErr) {
        console.error("❌ All parsing attempts failed");
        console.error("❌ Last error:", cleanErr.message);
        console.error("❌ Cleaned text sample:", jsonMatch[0].slice(-500));
        
        try {
          const partialMatch = jsonMatch[0].match(/"issues"\s*:\s*\[([\s\S]*)/);
          if (partialMatch) {
            let salvaged = '{"issues":[' + partialMatch[1];
            
            const lastComma = salvaged.lastIndexOf(',');
            if (lastComma > 0) {
              salvaged = salvaged.substring(0, lastComma);
            }
            
            if (!salvaged.endsWith(']}')) {
              salvaged += ']}';
            }
            
            const parsed = JSON.parse(salvaged);
            console.log(`⚠️ Salvaged ${parsed.issues?.length || 0} issues from partial response`);
            return parsed;
          }
        } catch (salvageErr) {
          console.error("❌ Could not salvage partial JSON:", salvageErr.message);
        }
      }
    }

    throw new Error(`Could not extract JSON from response. Response preview: ${cleanText.slice(0, 300)}...`);
  }

  getModelInfo() {
    return {
      analysis: "gemini-2.5-flash",
      fix: "gemini-2.5-flash",
      keysAvailable: this.keyStatus.filter((k) => k.available).length,
      totalKeys: this.apiKeys.length,
    };
  }
}

module.exports = new GeminiService();
