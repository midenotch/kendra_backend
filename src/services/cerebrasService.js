const Cerebras = require('@cerebras/cerebras_cloud_sdk');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30000;

class CerebrasService {
  constructor() {
    this.client = null;
  }

  initialize() {
    if (this.client) return;

    if (!process.env.CEREBRAS_API_KEY) {
      console.warn("⚠️ CEREBRAS_API_KEY not found in environment variables");
      return;
    }

    try {
      this.client = new Cerebras({
        apiKey: process.env.CEREBRAS_API_KEY,
      });
      console.log("✅ Cerebras Service Initialized");
    } catch (error) {
      console.error("❌ Failed to initialize Cerebras client:", error);
    }
  }

  async withRetry(operation, attempt = 0) {
    try {
      return await operation();
    } catch (error) {
      const errorMessage = error.message || "";
      const isRateLimit = errorMessage.includes("429") || errorMessage.includes("rate limit");
      
      if (isRateLimit && attempt < MAX_RETRIES) {
        console.warn(`⚠️ Cerebras Rate Limit (Attempt ${attempt + 1}/${MAX_RETRIES}): Retrying...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
        return this.withRetry(operation, attempt + 1);
      }
      throw error;
    }
  }

  async analyzeCode(systemPrompt, userPrompt, options = {}) {
    if (!this.client) this.initialize();
    if (!this.client) throw new Error("Cerebras client not initialized");

    const operation = async () => {
      const model = options.model || "llama3.1-70b";
      
      console.log(`⚡ Cerebras Request | Model: ${model} | Prompt: ${userPrompt.length} chars`);

      const response = await this.client.chat.completions.create({
        model: model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        temperature: options.temperature || 0.2,
        max_tokens: options.maxTokens || 4000,
        response_format: options.jsonMode ? { type: "json_object" } : undefined,
      });

      const text = response.choices[0]?.message?.content || "";
      
      console.log(`✅ Cerebras Response | Length: ${text.length} chars`);

      return {
        text: text.trim(),
        usage: response.usage,
        finishReason: response.choices[0]?.finish_reason
      };
    };

    return await this.withRetry(operation);
  }

  async generateFix(systemPrompt, userPrompt, options = {}) {
    return await this.analyzeCode(systemPrompt, userPrompt, {
      ...options,
      model: options.model || "llama3.1-70b",
      temperature: 0.1,
      maxTokens: 2000
    });
  }

  extractJSON(text) {
    if (!text) throw new Error("Empty response");
    
    // Attempt standard JSON extraction (Llama models often wrap in markdown blocks)
    try {
      const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const toParse = jsonBlockMatch ? jsonBlockMatch[1] : text;
      return JSON.parse(toParse.trim());
    } catch (error) {
      console.error("❌ Cerebras JSON Extract Failed:", error.message);
      // Fallback to manual cleaning if needed
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        try {
          return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
        } catch (innerError) {
          throw new Error("Could not parse JSON from Cerebras response");
        }
      }
      throw error;
    }
  }
}

module.exports = new CerebrasService();
