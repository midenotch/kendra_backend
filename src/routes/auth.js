// src/routes/auth.js - FIXED VERSION
const express = require("express");
const passport = require("passport");
// GoogleStrategy removed
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const axios = require("axios");
const User = require("../models/User");
const authMiddleware = require("../middleware/auth");
const config = require("../config");

const router = express.Router();

// ==================== HELPER FUNCTIONS ====================

/**
 * Generate a secure OAuth state token with userId embedded
 */
const generateStateToken = (userId) => {
  const state = crypto.randomBytes(32).toString("hex");
  const timestamp = Date.now();

  return {
    plain: state,
    encoded: jwt.sign(
      {
        state: state,
        userId: userId,
        timestamp: timestamp,
      },
      config.jwtSecret,
      { expiresIn: "15m" } 
    ),
  };
};

/**
 * Validate state token
 */
const validateStateToken = (token, expectedState) => {
  try {
    const decoded = jwt.verify(token, config.jwtSecret);

    // Check if token is expired (15 minutes)
    const tokenAge = Date.now() - decoded.timestamp;
    if (tokenAge > 15 * 60 * 1000) {
      return { valid: false, reason: "expired", age: tokenAge };
    }

    // Check if state matches
    if (expectedState !== decoded.state) {
      return { valid: false, reason: "mismatch", decoded: decoded };
    }

    return { valid: true, decoded: decoded };
  } catch (error) {
    return { valid: false, reason: "invalid", error: error.message };
  }
};

// ==================== PASSPORT SETUP ====================

passport.serializeUser((user, done) => {
  done(null, user.id || user._id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error, null);
  }
});

// ==================== ROUTES ====================

// 1. GITHUB OAUTH - Direct Sign-in/Login
router.get("/github", async (req, res) => {
  try {
    const state = crypto.randomBytes(32).toString("hex");

    // Construct GitHub OAuth URL
    const githubAuthUrl = `https://github.com/login/oauth/authorize?${new URLSearchParams(
      {
        client_id: config.githubClientId,
        redirect_uri: `${
          config.nodeEnv === "production"
            ? "https://kendra-backend.onrender.com"
            : "http://localhost:9000"
        }/api/auth/github/callback`,
        scope: "repo read:user user:email",
        state: state,
        allow_signup: "true",
      }
    ).toString()}`;

    // Store state in cookie (simple state for direct login)
    res.cookie("github_oauth_state", `login:${state}`, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      maxAge: 15 * 60 * 1000,
      path: "/",
    });

    res.redirect(githubAuthUrl);
  } catch (error) {
    res.redirect(`${config.frontendUrl}/?error=github_auth_failed`);
  }
});

// 2. GITHUB OAUTH - FIXED VERSION
// Step 1: User clicks "Connect GitHub" - Extract userId from JWT token in query param
router.get("/github/connect", async (req, res) => {
  try {
    console.log("🔗 GitHub connect initiated");

    // Get token from query parameter
    const token =
      req.query.token || req.headers.authorization?.replace("Bearer ", "");

    if (!token) {
      console.error("❌ No token provided");
      return res.redirect(`${config.frontendUrl}/dashboard?error=no_token`);
    }

    // Verify and decode the token
    let decoded;
    try {
      decoded = jwt.verify(token, config.jwtSecret);
      console.log("✅ Token verified, userId:", decoded.userId);
    } catch (err) {
      console.error("❌ Invalid token:", err.message);
      return res.redirect(
        `${config.frontendUrl}/dashboard?error=invalid_token`
      );
    }

    const userId = decoded.userId;

    // Generate secure state token with embedded userId
    const stateToken = generateStateToken(userId);

    // Store state in HTTP-only cookie
    res.cookie("github_oauth_state", stateToken.encoded, {
      httpOnly: true,
      secure: config.nodeEnv === "production",
      sameSite: config.nodeEnv === "production" ? "none" : "lax",
      maxAge: 15 * 60 * 1000, // 15 minutes
      path: "/",
    });

    console.log("✅ State token created and stored in cookie");

    // Construct GitHub OAuth URL
    const githubAuthUrl = `https://github.com/login/oauth/authorize?${new URLSearchParams(
      {
        client_id: config.githubClientId,
        redirect_uri: `${
          config.nodeEnv === "production"
            ? "https://kendra-backend.onrender.com"
            : "http://localhost:9000"
        }/api/auth/github/callback`,
        scope: "repo read:user user:email",
        state: stateToken.plain,
        allow_signup: "true",
      }
    ).toString()}`;

    console.log("🔗 Redirecting to GitHub OAuth");
    res.redirect(githubAuthUrl);
  } catch (error) {
    console.error("❌ GitHub connect error:", error);
    res.redirect(
      `${
        config.frontendUrl
      }/dashboard?error=github_connect_failed&message=${encodeURIComponent(
        error.message
      )}`
    );
  }
});

// Step 2: GitHub redirects back to this callback
router.get("/github/callback", async (req, res) => {
  try {
    console.log("🔄 GitHub callback received");
    console.log("📊 Query params:", req.query);

    const { code, state } = req.query;

    // Validate required parameters
    if (!code) {
      console.error("❌ No authorization code received");
      return res.redirect(
        `${config.frontendUrl}/dashboard?error=github_no_code`
      );
    }

    if (!state) {
      console.error("❌ No state parameter received");
      return res.redirect(
        `${config.frontendUrl}/dashboard?error=github_no_state`
      );
    }

    // Get state token from cookie
    const stateToken = req.cookies.github_oauth_state;

    if (!stateToken) {
      console.error("❌ No state token in cookies");
      return res.redirect(
        `${config.frontendUrl}/?error=github_invalid_state&reason=no_cookie`
      );
    }

    let userId = null;
    let isLoginFlow = false;

    // Handle two different state formats
    if (stateToken.startsWith("login:")) {
      const storedState = stateToken.split(":")[1];
      if (storedState !== state) {
        console.error("❌ Direct login state validation failed");
        return res.redirect(`${config.frontendUrl}/?error=github_invalid_state`);
      }
      isLoginFlow = true;
    } else {
      // It's a connection flow with a JWT state
      const validation = validateStateToken(stateToken, state);
      if (!validation.valid) {
        console.error("❌ Connect state validation failed:", validation.reason);
        res.clearCookie("github_oauth_state", { path: "/" });
        return res.redirect(
          `${config.frontendUrl}/dashboard?error=github_invalid_state&reason=${validation.reason}`
        );
      }
      userId = validation.decoded.userId;
    }

    // Exchange code for access token
    console.log("🔄 Exchanging code for access token...");
    const tokenResponse = await axios.post(
      "https://github.com/login/oauth/access_token",
      {
        client_id: config.githubClientId,
        client_secret: config.githubClientSecret,
        code: code,
      },
      {
        headers: { Accept: "application/json" },
      }
    );

    const tokenData = tokenResponse.data;
    if (tokenData.error) {
      console.error("❌ GitHub token error:", tokenData);
      return res.redirect(
        `${config.frontendUrl}/${isLoginFlow ? "" : "dashboard"}?error=github_token_error&message=${encodeURIComponent(
          tokenData.error_description || tokenData.error
        )}`
      );
    }

    // Get GitHub user info
    console.log("🔄 Fetching GitHub user info...");
    const userResponse = await axios.get("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Kendra-AI-DevOps",
      },
    });

    const githubUser = userResponse.data;

    if (isLoginFlow) {
      // Find or create user
      let user = await User.findOne({ githubId: githubUser.id.toString() });

      if (!user) {
        // Try matching by email if available
        if (githubUser.email) {
          user = await User.findOne({ email: githubUser.email });
        }

        if (user) {
          user.githubId = githubUser.id.toString();
          user.githubUsername = githubUser.login;
          user.githubAccessToken = tokenData.access_token;
          user.githubRefreshToken = tokenData.refresh_token;
          user.isGitHubConnected = true;
          await user.save();
        } else {
          user = await User.create({
            githubId: githubUser.id.toString(),
            githubUserId: githubUser.id,
            githubUsername: githubUser.login,
            email: githubUser.email,
            name: githubUser.name || githubUser.login,
            avatar: githubUser.avatar_url,
            githubAccessToken: tokenData.access_token,
            githubRefreshToken: tokenData.refresh_token,
            isGitHubConnected: true,
            lastLoginAt: new Date(),
          });
        }
      } else {
        user.lastLoginAt = new Date();
        user.githubAccessToken = tokenData.access_token;
        user.githubRefreshToken = tokenData.refresh_token;
        user.githubUsername = githubUser.login;
        user.avatar = githubUser.avatar_url;
        await user.save();
      }

      const token = authMiddleware.generateToken(user._id);
      res.clearCookie("github_oauth_state", { path: "/" });
      return res.redirect(`${config.frontendUrl}/auth/callback?token=${token}`);
    } else {
      // Connection Flow
      await User.findByIdAndUpdate(userId, {
        githubAccessToken: tokenData.access_token,
        githubRefreshToken: tokenData.refresh_token,
        githubUserId: githubUser.id,
        githubUsername: githubUser.login,
        isGitHubConnected: true,
        updatedAt: new Date(),
      });

      res.clearCookie("github_oauth_state", { path: "/" });
      return res.redirect(
        `${config.frontendUrl}/dashboard?github_connected=true&username=${githubUser.login}`
      );
    }
  } catch (error) {
    console.error("❌ GitHub callback error:", error);
    res.clearCookie("github_oauth_state", { path: "/" });

    const errorMessage = encodeURIComponent(
      error.response?.data?.message || error.message || "Unknown error"
    );

    res.redirect(
      `${config.frontendUrl}/dashboard?error=github_connection_failed&message=${errorMessage}`
    );
  }
});

// 3. USER MANAGEMENT ENDPOINTS
router.get("/me", authMiddleware.verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      "-githubAccessToken -githubRefreshToken"
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    res.json({
      success: true,
      user: {
        ...user.toObject(),
        hasGitHubToken: !!user.githubAccessToken,
      },
    });
  } catch (error) {
    console.error("❌ Get user error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch user data",
    });
  }
});

router.get("/github/status", authMiddleware.verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      "isGitHubConnected githubUsername"
    );

    res.json({
      success: true,
      isConnected: user?.isGitHubConnected || false,
      githubUsername: user?.githubUsername || null,
    });
  } catch (error) {
    console.error("❌ GitHub status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to check GitHub status",
    });
  }
});

router.post(
  "/github/disconnect",
  authMiddleware.verifyToken,
  async (req, res) => {
    try {
      await User.findByIdAndUpdate(req.userId, {
        githubAccessToken: null,
        githubRefreshToken: null,
        githubUsername: null,
        githubUserId: null,
        isGitHubConnected: false,
        updatedAt: new Date(),
      });

      res.json({
        success: true,
        message: "GitHub disconnected successfully",
      });
    } catch (error) {
      console.error("❌ GitHub disconnect error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to disconnect GitHub",
      });
    }
  }
);

router.post("/logout", authMiddleware.verifyToken, (req, res) => {
  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

module.exports = router;
