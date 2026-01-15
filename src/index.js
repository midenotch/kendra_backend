require("dotenv").config();
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const passport = require("passport");
const session = require("express-session");
const config = require("./config");
const cookieParser = require("cookie-parser");
const express = require("express");

// Import routes
const authRoutes = require("./routes/auth");
const repositoriesRoutes = require("./routes/repositories");
const issuesRoutes = require("./routes/issues");
const pullRequestsRoutes = require("./routes/pullRequests");
const webhooksRoutes = require("./routes/webhooks");
const auditRoutes = require("./routes/audit");
const prSyncService = require("./services/prSyncService");
const statsRoutes = require("./routes/stats");

const app = express();
app.set("trust proxy", 1);

// ==================== MIDDLEWARE ====================

// Security headers
app.use(helmet());
app.use(cookieParser());

// Health check (allow all CORS)
app.use("/health", cors());
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "Kendra Backend",
  });
});

// CORS
app.use(cors(config.corsOptions));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use("/api/", limiter);

if (process.env.NODE_ENV === "production") {
  prSyncService.startPeriodicSync();
}

// Body parsing
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Session for OAuth (minimal, just for GitHub flow)
app.use(
  session({
    secret: config.jwtSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.nodeEnv === "production",
      maxAge: 30 * 60 * 1000,
    },
  })
);

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

// ==================== DATABASE CONNECTION ====================

mongoose
  .connect(config.mongoUri)
  .then(() => {
    console.log("✅ Connected to MongoDB");
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });

// ==================== ROUTES ====================

// Health check


// Auth routes
app.use("/api/auth", authRoutes);
app.use("/api/repositories", repositoriesRoutes);
app.use("/api/issues", issuesRoutes);
app.use("/api/pull-requests", pullRequestsRoutes);
app.use("/api/webhooks", webhooksRoutes);
app.use("/api/audit", auditRoutes);
app.use("/api/stats", statsRoutes);

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);

  res.status(err.status || 500).json({
    error:
      config.nodeEnv === "production" ? "Internal server error" : err.message,
  });
});

// ==================== START SERVER ====================

const PORT = config.port;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${config.nodeEnv}`);
  console.log(`🔗 Frontend URL: ${config.frontendUrl}`);
});
