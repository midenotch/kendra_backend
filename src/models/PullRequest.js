const mongoose = require("mongoose");

const PullRequestSchema = new mongoose.Schema({
  repositoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Repository",
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  issueId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Issue",
  },

  // GitHub PR Info
  githubPrId: {
    type: Number,
    required: true,
  },
  prNumber: {
    type: Number,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  body: String,
  url: {
    type: String,
    required: true,
  },
  branch: String,

  // Status
  status: {
    type: String,
    enum: ["open", "closed", "merged"],
    default: "open",
  },
  reviewStatus: {
    type: String,
    enum: ["pending", "approved", "changes_requested"],
    default: "pending",
  },

  // AI Metadata
  aiGenerated: {
    type: Boolean,
    default: true,
  },
  riskLevel: {
    type: String,
    enum: ["LOW", "MEDIUM", "HIGH"],
  },
  changesSummary: String,

  // Stats
  filesChanged: Number,
  additions: Number,
  deletions: Number,

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  lastSyncedAt: {
    type: Date,
    default: null,
  },

  syncStatus: {
    type: String,
    enum: ["pending", "synced", "failed"],
    default: "pending",
  },
  mergedAt: Date,
  closedAt: Date,
});

module.exports = mongoose.model("PullRequest", PullRequestSchema);
