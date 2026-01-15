const express = require("express");
const authMiddleware = require("../middleware/auth");
const analysisService = require("../services/analysisService");
const fixService = require("../services/fixService");
const Issue = require("../models/Issue");
const PullRequest = require("../models/PullRequest");

const router = express.Router();

/**
 * POST /api/issues/analyze/:repositoryId
 * Analyze a repository for issues
 */
router.post(
  "/analyze/:repositoryId",
  authMiddleware.verifyToken,
  async (req, res) => {
    try {
      const { repositoryId } = req.params;

      console.log(`🔍 Analyze request for repository: ${repositoryId}`);

      // Start analysis (this will run in background)
      const result = await analysisService.analyzeRepository(
        repositoryId,
        req.userId
      );

      res.json({
        success: true,
        message: "Analysis completed",
        ...result,
      });
    } catch (error) {
      console.error("❌ Analysis error:", error);
      res.status(500).json({
        success: false,
        error: "Analysis failed",
        details: error.message,
      });
    }
  }
);

/**
 * GET /api/issues
 * Get all issues for the user
 */
router.get("/", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { repositoryId, status, severity } = req.query;

    const query = { userId: req.userId };

    if (repositoryId) query.repositoryId = repositoryId;
    if (status) query.status = status;
    if (severity) query.severity = severity;

    const issues = await Issue.find(query)
      .populate("repositoryId", "repoName repoOwner repoUrl")
      .populate("pullRequestId", "prNumber url status")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      issues,
      count: issues.length,
    });
  } catch (error) {
    console.error("❌ Get issues error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch issues",
    });
  }
});

/**
 * GET /api/issues/:id
 * Get single issue details
 */
router.get("/:id", authMiddleware.verifyToken, async (req, res) => {
  try {
    const issue = await Issue.findOne({
      _id: req.params.id,
      userId: req.userId,
    })
      .populate("repositoryId")
      .populate("pullRequestId");

    if (!issue) {
      return res.status(404).json({
        success: false,
        error: "Issue not found",
      });
    }

    res.json({
      success: true,
      issue,
    });
  } catch (error) {
    console.error("❌ Get issue error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch issue",
    });
  }
});

/**
 * POST /api/issues/:id/fix
 * Generate fix and create PR for an issue
 */
router.post("/:id/fix", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`🔧 Fix request for issue: ${id}`);

    const result = await fixService.fixIssue(id, req.userId);

    res.json({
      success: true,
      message: "Fix generated and PR created",
      ...result,
    });
  } catch (error) {
    console.error("❌ Fix error:", error);
    res.status(500).json({
      success: false,
      error: "Fix generation failed",
      details: error.message,
    });
  }
});

/**
 * PATCH /api/issues/:id
 * Update issue (e.g., mark as ignored)
 */
router.patch("/:id", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { status } = req.body;

    const issue = await Issue.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { status, updatedAt: new Date() },
      { new: true }
    );

    if (!issue) {
      return res.status(404).json({
        success: false,
        error: "Issue not found",
      });
    }

    res.json({
      success: true,
      issue,
    });
  } catch (error) {
    console.error("❌ Update issue error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update issue",
    });
  }
});

/**
 * GET /api/issues/stats/:repositoryId
 * Get issue statistics for a repository
 */
router.get(
  "/stats/:repositoryId",
  authMiddleware.verifyToken,
  async (req, res) => {
    try {
      const { repositoryId } = req.params;

      const stats = await Issue.aggregate([
        { $match: { repositoryId: repositoryId, userId: req.userId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            critical: {
              $sum: { $cond: [{ $eq: ["$severity", "CRITICAL"] }, 1, 0] },
            },
            high: {
              $sum: { $cond: [{ $eq: ["$severity", "HIGH"] }, 1, 0] },
            },
            medium: {
              $sum: { $cond: [{ $eq: ["$severity", "MEDIUM"] }, 1, 0] },
            },
            low: {
              $sum: { $cond: [{ $eq: ["$severity", "LOW"] }, 1, 0] },
            },
            detected: {
              $sum: { $cond: [{ $eq: ["$status", "detected"] }, 1, 0] },
            },
            fixing: {
              $sum: { $cond: [{ $eq: ["$status", "fix-generated"] }, 1, 0] },
            },
            prCreated: {
              $sum: { $cond: [{ $eq: ["$status", "pr-created"] }, 1, 0] },
            },
            resolved: {
              $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] },
            },
          },
        },
      ]);

      res.json({
        success: true,
        stats: stats[0] || {
          total: 0,
          critical: 0,
          high: 0,
          medium: 0,
          low: 0,
          detected: 0,
          fixing: 0,
          prCreated: 0,
          resolved: 0,
        },
      });
    } catch (error) {
      console.error("❌ Get stats error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch stats",
      });
    }
  }
);

module.exports = router;
