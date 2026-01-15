const express = require("express");
const authMiddleware = require("../middleware/auth");
const PullRequest = require("../models/PullRequest");
const Issue = require("../models/Issue");

const router = express.Router();

/**
 * GET /api/pull-requests
 * Get all pull requests for the user
 */
router.get("/", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { repositoryId, status } = req.query;

    const query = { userId: req.userId };

    if (repositoryId) query.repositoryId = repositoryId;
    if (status) query.status = status;

    const pullRequests = await PullRequest.find(query)
      .populate("repositoryId", "repoName repoOwner repoUrl")
      .populate("issueId", "title severity issueType")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      pullRequests,
      count: pullRequests.length,
    });
  } catch (error) {
    console.error("❌ Get PRs error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch pull requests",
    });
  }
});

/**
 * GET /api/pull-requests/:id
 * Get single PR details
 */
router.get("/:id", authMiddleware.verifyToken, async (req, res) => {
  try {
    const pr = await PullRequest.findOne({
      _id: req.params.id,
      userId: req.userId,
    })
      .populate("repositoryId")
      .populate("issueId");

    if (!pr) {
      return res.status(404).json({
        success: false,
        error: "Pull request not found",
      });
    }

    res.json({
      success: true,
      pullRequest: pr,
    });
  } catch (error) {
    console.error("❌ Get PR error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch pull request",
    });
  }
});

/**
 * GET /api/pull-requests/stats/:repositoryId
 * Get PR statistics for a repository
 */
router.get(
  "/stats/:repositoryId",
  authMiddleware.verifyToken,
  async (req, res) => {
    try {
      const { repositoryId } = req.params;

      const stats = await PullRequest.aggregate([
        { $match: { repositoryId: repositoryId, userId: req.userId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            open: {
              $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] },
            },
            merged: {
              $sum: { $cond: [{ $eq: ["$status", "merged"] }, 1, 0] },
            },
            closed: {
              $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
            },
          },
        },
      ]);

      res.json({
        success: true,
        stats: stats[0] || {
          total: 0,
          open: 0,
          merged: 0,
          closed: 0,
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
