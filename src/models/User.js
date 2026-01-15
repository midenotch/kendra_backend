const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // Basic info
    email: {
      type: String,
      required: false,
      lowercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
    },
    avatar: {
      type: String,
    },

    githubId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    githubUserId: {
      type: Number,
      sparse: true,
      index: true,
    },
    githubUsername: {
      type: String,
      required: true,
    },
    githubAccessToken: {
      type: String,
    },
    githubRefreshToken: {
      type: String,
    },
    isGitHubConnected: {
      type: Boolean,
      default: true,
    },

    // Timestamps
    lastLoginAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
// Indexes removed to avoid duplicates (defined in schema)

const User = mongoose.model("User", userSchema);

module.exports = User;
