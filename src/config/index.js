// require("dotenv").config();

// const config = {
//   // Server
//   port: process.env.PORT || 4000,
//   nodeEnv: process.env.NODE_ENV || "development",
//   // frontendUrl: process.env.FRONTEND_URL || "http://localhost:5173",
//   frontendUrl: process.env.FRONTEND_URL || "https://pipex-ai.vercel.app",

//   // Database
//   mongoUri: process.env.MONGODB_URI,

//   // Authentication
//   jwtSecret: process.env.JWT_SECRET,
//   jwtExpiry: "7d",

//   // Google OAuth
//   googleClientId: process.env.GOOGLE_CLIENT_ID,
//   googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
//   googleCallbackUrl: "/api/auth/google/callback",

//   // GitHub OAuth
//   githubClientId: process.env.GITHUB_CLIENT_ID,
//   githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
//   githubCallbackUrl:
//     process.env.GITHUB_CALLBACK_URL || "/api/auth/github/callback",
//   githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,

//   // APIs
//   openaiApiKey: process.env.OPENAI_API_KEY,

//   // CORS
//   corsOptions: {
//     origin: function (origin, callback) {
//       const allowedOrigins = [
//         "http://localhost:5173",
//         "https://pipex-ai.vercel.app",
//       ];

//       if (!origin || allowedOrigins.indexOf(origin) !== -1) {
//         callback(null, true);
//       } else {
//         callback(new Error("Not allowed by CORS"));
//       }
//     },
//     credentials: true,
//     optionsSuccessStatus: 200,
//   },
// };

// // Validate required environment variables
// const requiredVars = [
//   "MONGODB_URI",
//   "JWT_SECRET",
//   "GOOGLE_CLIENT_ID",
//   "GOOGLE_CLIENT_SECRET",
//   "GITHUB_CLIENT_ID",
//   "GITHUB_CLIENT_SECRET",
//   "OPENAI_API_KEY",
// ];

// requiredVars.forEach((varName) => {
//   if (!process.env[varName]) {
//     console.error(`❌ Missing required environment variable: ${varName}`);
//     process.exit(1);
//   }
// });

// module.exports = config;

const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

console.log("🔍 Checking environment variables...");

const config = {
  // Server
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || "development",
  frontendUrl: process.env.FRONTEND_URL || "https://kendra-devops.vercel.app",

  // Database
  mongoUri: process.env.MONGODB_URI,

  // Authentication
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiry: "7d",

  // GitHub OAuth
  githubClientId: process.env.GITHUB_CLIENT_ID,
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
  githubCallbackUrl:
    process.env.GITHUB_CALLBACK_URL || "/api/auth/github/callback",
  githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,

  // Gemini API Keys (GEMINI_API_KEY, GEMINI_API_KEY_1, GEMINI_API_KEY_2, ...)
  geminiApiKeys: (() => {
    try {
      const keys = [];

      // Primary key
      if (process.env.GEMINI_API_KEY) {
        keys.push(process.env.GEMINI_API_KEY.trim());
      }

      // Additional keys: GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc.
      for (let i = 1; i <= 10; i++) {
        const key = process.env[`GEMINI_API_KEY_${i}`];
        if (key && key.trim().length > 0) {
          keys.push(key.trim());
        }
      }

      console.log(`🔑 Found ${keys.length} Gemini API key(s)`);

      // Validate keys start with 'AI'
      const validKeys = keys.filter((key) => key.startsWith("AI"));
      if (validKeys.length !== keys.length) {
        console.warn(
          `⚠️ Filtered out ${
            keys.length - validKeys.length
          } invalid keys (should start with 'AI')`
        );
      }

      return validKeys;
    } catch (error) {
      console.error("❌ Error parsing Gemini API keys:", error.message);
      return [];
    }
  })(),

  // CORS
  corsOptions: {
    origin: function (origin, callback) {
      const allowedOrigins = [
        "http://localhost:5173",
        "https://kendra-devops.vercel.app",
        process.env.FRONTEND_URL,
      ];

      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    optionsSuccessStatus: 200,
  },
};

// Validation
console.log("\n=== CONFIG VALIDATION ===");

// Check Gemini API Keys
if (!config.geminiApiKeys || config.geminiApiKeys.length === 0) {
  console.error("❌ ERROR: No valid Gemini API keys found!");
  console.error("   Please set at least one Gemini API key:");
  console.error("   - GEMINI_API_KEY (primary key)");
  console.error(
    "   - GEMINI_API_KEY_1, GEMINI_API_KEY_2, etc. (additional keys)"
  );
  console.error("   Get keys from: https://aistudio.google.com/app/apikey");
  process.exit(1);
}

console.log(`✅ Loaded ${config.geminiApiKeys.length} valid Gemini API key(s)`);
if (config.geminiApiKeys.length > 0) {
  console.log(
    `   First key (masked): ${config.geminiApiKeys[0].substring(0, 15)}...`
  );
}

// Validate required environment variables
const requiredVars = [
  "MONGODB_URI",
  "JWT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_WEBHOOK_SECRET",
];

console.log("\n=== Required Variables Check ===");
const missingVars = requiredVars.filter((varName) => !process.env[varName]);

if (missingVars.length > 0) {
  console.error("❌ Missing required environment variables:");
  missingVars.forEach((varName) => {
    console.error(`   - ${varName}`);
  });
  process.exit(1);
}

console.log("✅ All required environment variables are set");

// Log all found environment variables for debugging
console.log("\n=== Environment Variables Summary ===");
console.log(`Port: ${config.port}`);
console.log(`Node Environment: ${config.nodeEnv}`);
console.log(`Frontend URL: ${config.frontendUrl}`);
console.log(`MongoDB URI: ${config.mongoUri ? "Set" : "Not set"}`);
console.log(`GitHub Client ID: ${config.githubClientId ? "Set" : "Not set"}`);
console.log(`Gemini API Keys: ${config.geminiApiKeys.length} keys loaded`);

module.exports = config;
