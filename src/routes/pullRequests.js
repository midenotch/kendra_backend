const express = require("express");
const authMiddleware = require("../middleware/auth");
const PullRequest = require("../models/PullRequest");
const Issue = require("../models/Issue");

const router = express.Router();


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


router.post("/sync", authMiddleware.verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    console.log("🔄 Syncing pull requests for user:", userId);

    const User = require("../models/User");
    const axios = require("axios");

    
    const user = await User.findById(userId);
    if (!user || !user.githubAccessToken) {
      return res.status(400).json({
        success: false,
        error: "GitHub not connected",
      });
    }

    
    const openPRs = await PullRequest.find({
      userId: userId,
      status: "open",
    }).populate("repositoryId");

    console.log(`📋 Found ${openPRs.length} open PRs to check`);

    let updatedCount = 0;
    const updates = [];

    for (const pr of openPRs) {
      const repo = pr.repositoryId;
      if (!repo) continue;

      try {
        
        const response = await axios.get(
          `https://api.github.com/repos/${repo.repoOwner}/${repo.repoName}/pulls/${pr.prNumber}`,
          {
            headers: {
              Authorization: `Bearer ${user.githubAccessToken}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Kendra-AI-DevOps",
            },
          }
        );

        const githubPR = response.data;
        let newStatus = pr.status;

        
        if (githubPR.merged) {
          newStatus = "merged";
        } else if (githubPR.state === "closed") {
          newStatus = "closed";
        }

        
        if (newStatus !== pr.status) {
          console.log(
            `🔄 updating PR #${pr.prNumber} status: ${pr.status} -> ${newStatus}`
          );

          pr.status = newStatus;
          
          await pr.save();

          updates.push({
            id: pr._id,
            prNumber: pr.prNumber,
            oldStatus: "open",
            newStatus,
          });

          
          if (pr.issueId && newStatus === "merged") {
            await Issue.findByIdAndUpdate(pr.issueId, {
              status: "resolved",
              updatedAt: new Date(),
            });
            console.log(`✅ Marked linked issue ${pr.issueId} as resolved`);
          } else if (pr.issueId && newStatus === "closed") {
            
            
            
          }

          updatedCount++;
        }
      } catch (err) {
        console.error(
          `❌ Error checking PR #${pr.prNumber}: ${err.message}`
        );
      }
    }

    res.json({
      success: true,
      updatedCount,
      updates,
      message: `Synced ${openPRs.length} PRs, ${updatedCount} updated`,
    });
  } catch (error) {
    console.error("❌ Sync PRs error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to sync pull requests",
    });
  }
});

module.exports = router;
