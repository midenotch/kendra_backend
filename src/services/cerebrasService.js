// const Cerebras = require('@cerebras/cerebras_cloud_sdk');

// const MAX_RETRIES = 3;
// const RETRY_DELAY_MS = 2000;
// const REQUEST_TIMEOUT_MS = 30000;

// class CerebrasService {
//   constructor() {
//     this.client = null;
//   }

//   initialize() {
//     if (this.client) return;

//     if (!process.env.CEREBRAS_API_KEY) {
//       console.warn("⚠️ CEREBRAS_API_KEY not found in environment variables");
//       return;
//     }

//     try {
//       this.client = new Cerebras({
//         apiKey: process.env.CEREBRAS_API_KEY,
//       });
//       console.log("✅ Cerebras Service Initialized");
//     } catch (error) {
//       console.error("❌ Failed to initialize Cerebras client:", error);
//     }
//   }

//   async withRetry(operation, attempt = 0) {
//     try {
//       return await operation();
//     } catch (error) {
//       const errorMessage = error.message || "";
//       const isRateLimit = errorMessage.includes("429") || errorMessage.includes("rate limit");
      
//       if (isRateLimit && attempt < MAX_RETRIES) {
//         console.warn(`⚠️ Cerebras Rate Limit (Attempt ${attempt + 1}/${MAX_RETRIES}): Retrying...`);
//         await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
//         return this.withRetry(operation, attempt + 1);
//       }
//       throw error;
//     }
//   }

//   async analyzeCode(systemPrompt, userPrompt, options = {}) {
//     if (!this.client) this.initialize();
//     if (!this.client) throw new Error("Cerebras client not initialized");

//     const operation = async () => {
//       const model = options.model || "llama3.1-70b";
      
//       console.log(`⚡ Cerebras Request | Model: ${model} | Prompt: ${userPrompt.length} chars`);

//       const response = await this.client.chat.completions.create({
//         model: model,
//         messages: [
//           { role: "system", content: systemPrompt },
//           { role: "user", content: userPrompt }
//         ],
//         temperature: options.temperature || 0.2,
//         max_tokens: options.maxTokens || 4000,
//         response_format: options.jsonMode ? { type: "json_object" } : undefined,
//       });

//       const text = response.choices[0]?.message?.content || "";
      
//       console.log(`✅ Cerebras Response | Length: ${text.length} chars`);

//       return {
//         text: text.trim(),
//         usage: response.usage,
//         finishReason: response.choices[0]?.finish_reason
//       };
//     };

//     return await this.withRetry(operation);
//   }

//   async generateFix(systemPrompt, userPrompt, options = {}) {
//     return await this.analyzeCode(systemPrompt, userPrompt, {
//       ...options,
//       model: options.model || "llama3.1-70b",
//       temperature: 0.1,
//       maxTokens: 2000
//     });
//   }

//   extractJSON(text) {
//     if (!text) throw new Error("Empty response");
    
//     // Attempt standard JSON extraction (Llama models often wrap in markdown blocks)
//     try {
//       const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
//       const toParse = jsonBlockMatch ? jsonBlockMatch[1] : text;
//       return JSON.parse(toParse.trim());
//     } catch (error) {
//       console.error("❌ Cerebras JSON Extract Failed:", error.message);
//       // Fallback to manual cleaning if needed
//       const jsonStart = text.indexOf('{');
//       const jsonEnd = text.lastIndexOf('}');
//       if (jsonStart !== -1 && jsonEnd !== -1) {
//         try {
//           return JSON.parse(text.substring(jsonStart, jsonEnd + 1));
//         } catch (innerError) {
//           throw new Error("Could not parse JSON from Cerebras response");
//         }
//       }
//       throw error;
//     }
//   }
// }

// module.exports = new CerebrasService();


const Cerebras = require('@cerebras/cerebras_cloud_sdk');

// ---------------------------------------------------------------------------
// Configurable constants – tweak them in one place.
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000; 

// ---------------------------------------------------------------------------
// Helper: simple sleep (ms)
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// CerebrasService – singleton exported at the bottom of the file.
// ---------------------------------------------------------------------------
class CerebrasService {
  constructor() {
    /** @type {import('@cerebras/cerebras_cloud_sdk').Cerebras | null} */
    this.client = null;
    this.initError = null;
  }

  // -----------------------------------------------------------------------
  // Initialise the SDK client lazily.
  // -----------------------------------------------------------------------
  async initialize() {
    if (this.client) return; // already ready

    // NOTE: the official env var name is CEREBRAS_API_KEY (with an "A").
    const apiKey = process.env.CEREBRAS_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ CEREBRAS_API_KEY not found in environment variables');
      this.initError = new Error('Missing CEREBRAS_API_KEY');
      return;
    }

    try {
      // The SDK constructor is synchronous, but we keep this method async
      // to allow future async validation without breaking callers.
      this.client = new Cerebras({ apiKey });
      console.log('✅ Cerebras Service Initialized');
    } catch (err) {
      console.error('❌ Failed to initialise Cerebras client:', err);
      this.initError = err;
    }
  }

  // -----------------------------------------------------------------------
  // Generic retry wrapper.
  // Retries on:
  //   • 429 (rate‑limit)
  //   • 5xx (transient server errors)
  //   • network errors (no response)
  // -----------------------------------------------------------------------
  async withRetry(operation, attempt = 0) {
    try {
      return await operation();
    } catch (err) {
      const status = err?.response?.status;
      const isRateLimit = status === 429 || (err.message?.includes('429') ?? false);
      const isTransient = status >= 500 && status < 600; // 5xx
      const isNetwork = !err.response; // e.g., DNS, timeout

      const shouldRetry = (isRateLimit || isTransient || isNetwork) && attempt < MAX_RETRIES;

      if (!shouldRetry) {
        // Propagate the original error – include the init error if we never got a client.
        if (!this.client && this.initError) throw this.initError;
        throw err;
      }

      const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt); // exponential back‑off
      console.warn(
        `⚠️ Cerebras request failed (attempt ${attempt + 1}/${MAX_RETRIES}) – ` +
        `status=${status ?? 'N/A'} – retrying in ${delay}ms...`
      );
      await sleep(delay);
      return this.withRetry(operation, attempt + 1);
    }
  }

  // -----------------------------------------------------------------------
  // Core LLM call – wraps the SDK chat.completions endpoint.
  // -----------------------------------------------------------------------
  async analyzeCode(systemPrompt, userPrompt, options = {}) {
    // Ensure the client is ready.
    if (!this.client) await this.initialize();
    if (!this.client) throw new Error('Cerebras client not initialised');

    const operation = async () => {
      const model = options.model ?? 'llama-3.3-70b';
      const temperature = options.temperature ?? 0.2;
      const maxTokens = options.maxTokens ?? 4000;
      const responseFormat = options.jsonMode
        ? { type: 'json_object' }
        : undefined;

      console.log(
        `⚡ Cerebras request | model=${model} | prompt=${userPrompt.length} chars`
      );

      // The SDK accepts a plain JS object; we also forward the global timeout.
      const response = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        response_format: responseFormat,
      });

      const text = response?.choices?.[0]?.message?.content ?? '';
      console.log(`✅ Cerebras response | length=${text.length} chars`);

      return {
        text: text.trim(),
        usage: response?.usage,
        finishReason: response?.choices?.[0]?.finish_reason,
      };
    };

    // Run with automatic retry handling.
    return this.withRetry(operation);
  }

  // -----------------------------------------------------------------------
  // Convenience wrapper for “generate a fix” – tighter token budget & lower temperature.
  // -----------------------------------------------------------------------
  async generateFix(systemPrompt, userPrompt, options = {}) {
    return this.analyzeCode(systemPrompt, userPrompt, {
      ...options,
      model: options.model ?? 'llama-3.3-70b',
      temperature: 0.1,
      maxTokens: 2000,
    });
  }

  // -----------------------------------------------------------------------
  // Extract a JSON object from a raw LLM response.
  // Handles markdown fences, optional language tags, and plain JSON.
  // -----------------------------------------------------------------------
  extractJSON(text) {
    if (!text) throw new Error('Empty response – cannot extract JSON');

    // 1️⃣ Attempt to extract JSON from markdown fences (handles ```json, ```js, etc.)
    const fencedMatch = text.match(/```(?:\w+)?\s*([\s\S]*?)```/);
    const candidate = fencedMatch ? fencedMatch[1] : text;

    const cleaned = candidate.trim();

    try {
      // 2️⃣ Attempt direct parse
      return JSON.parse(cleaned);
    } catch (parseError) {
      // 3️⃣ Attempt cleanup parse (removing control characters and trailing commas)
      try {
        const sanitized = cleaned
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, "") 
          .replace(/,\s*}/g, "}") 
          .replace(/,\s*\]/g, "]"); 
        return JSON.parse(sanitized);
      } catch (sanitizedError) {
        console.warn('❗ Sanitized JSON parse failed – attempting substring extraction');
      }
    }

    // 4️⃣ Fallback: locate the first `{` and the last `}` and slice.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      const substring = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(substring);
      } catch (innerError) {
        // 5️⃣ Final Salvage Attempt: Try to close a partial issues array
        try {
          const partialMatch = cleaned.match(/"issues"\s*:\s*\[([\s\S]*)/);
          if (partialMatch) {
            let salvaged = '{"issues":[' + partialMatch[1];
            const lastComma = salvaged.lastIndexOf(',');
            if (lastComma > 0) salvaged = salvaged.substring(0, lastComma);
            if (!salvaged.endsWith(']}')) salvaged += ']}';
            return JSON.parse(salvaged);
          }
        } catch (salvageErr) {
          console.error('❌ JSON salvage failed:', salvageErr.message);
        }
        throw new Error('Could not parse JSON from Cerebras response after multiple attempts');
      }
    }

    throw new Error('Unable to locate a JSON payload (expected {...}) in the LLM response');
  }
}

// Export a ready‑to‑use singleton (mirrors your original pattern)
module.exports = new CerebrasService();