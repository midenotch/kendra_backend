const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema(
  {
    // User and repository references
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    repositoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Repository",
      index: true,
    },

    // Action details
    agentName: {
      type: String,
      required: true,
      enum: [
        "Pipex AI",
        "Analysis Engine",
        "Fix Generator",
        "PR Manager",
        "Issue Tracker",
        "GitHub Webhook",
        "System",
      ],
      default: "Pipex AI",
    },
    action: {
      type: String,
      required: true,
    },
    actionType: {
      type: String,
      required: true,
      enum: [
        "analysis",
        "fix-generation",
        "pr-creation",
        "pr-merge",
        "pr-close",
        "issue-resolution",
        "error",
        "webhook",
        "manual",
      ],
    },

    // Risk assessment
    riskLevel: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
      required: true,
      default: "LOW",
    },
    approved: {
      type: Boolean,
      default: true,
    },

    // Additional data
    details: {
      type: mongoose.Schema.Types.Mixed,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
    },

    // Timestamp
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient querying
auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ repositoryId: 1, timestamp: -1 });
auditLogSchema.index({ actionType: 1, timestamp: -1 });
auditLogSchema.index({ riskLevel: 1, timestamp: -1 });

const AuditLog = mongoose.model("AuditLog", auditLogSchema);

module.exports = AuditLog;
