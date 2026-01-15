const express = require("express");
const authMiddleware = require("../middleware/auth");
const Repository = require("../models/Repository");
const Issue = require("../models/Issue");
const PullRequest = require("../models/PullRequest");
const auditService = require("../services/auditService");

const router = express.Router();

/**
 * GET /api/stats/:repositoryId
 * Get comprehensive statistics for a repository
 */
router.get("/:repositoryId", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { repositoryId } = req.params;
    const userId = req.userId;

    console.log(`📊 Fetching stats for repository: ${repositoryId}`);

    // Verify repository access
    const repository = await Repository.findOne({
      _id: repositoryId,
      userId: userId,
    });

    if (!repository) {
      return res.status(404).json({
        success: false,
        error: "Repository not found or access denied",
      });
    }

    // Get issue statistics
    const issueStats = await Issue.aggregate([
      { $match: { repositoryId: repository._id } },
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
          fixGenerated: {
            $sum: { $cond: [{ $eq: ["$status", "fix-generated"] }, 1, 0] },
          },
          prCreated: {
            $sum: { $cond: [{ $eq: ["$status", "pr-created"] }, 1, 0] },
          },
          resolved: {
            $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] },
          },
          security: {
            $sum: { $cond: [{ $eq: ["$issueType", "security"] }, 1, 0] },
          },
          bugs: {
            $sum: { $cond: [{ $eq: ["$issueType", "bug"] }, 1, 0] },
          },
          performance: {
            $sum: { $cond: [{ $eq: ["$issueType", "performance"] }, 1, 0] },
          },
          codeQuality: {
            $sum: { $cond: [{ $eq: ["$issueType", "code-quality"] }, 1, 0] },
          },
        },
      },
    ]);

    // Get PR statistics
    const prStats = await PullRequest.aggregate([
      { $match: { repositoryId: repository._id } },
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
          highRisk: {
            $sum: { $cond: [{ $eq: ["$riskLevel", "HIGH"] }, 1, 0] },
          },
          mediumRisk: {
            $sum: { $cond: [{ $eq: ["$riskLevel", "MEDIUM"] }, 1, 0] },
          },
          lowRisk: {
            $sum: { $cond: [{ $eq: ["$riskLevel", "LOW"] }, 1, 0] },
          },
        },
      },
    ]);

    // Get audit statistics
    const auditStats = await auditService.getStats(userId, repositoryId);

    // Calculate resolution rate
    const totalIssues = issueStats[0]?.total || 0;
    const resolvedIssues = issueStats[0]?.resolved || 0;
    const resolutionRate =
      totalIssues > 0 ? Math.round((resolvedIssues / totalIssues) * 100) : 0;

    // Calculate PR merge rate
    const totalPRs = prStats[0]?.total || 0;
    const mergedPRs = prStats[0]?.merged || 0;
    const mergeRate =
      totalPRs > 0 ? Math.round((mergedPRs / totalPRs) * 100) : 0;

    const stats = {
      repository: {
        id: repository._id,
        name: repository.repoName,
        owner: repository.repoOwner,
        language: repository.language,
        lastAnalyzed: repository.lastAnalyzedAt,
        analysisStatus: repository.analysisStatus,
      },
      issues: {
        total: totalIssues,
        bySeverity: {
          critical: issueStats[0]?.critical || 0,
          high: issueStats[0]?.high || 0,
          medium: issueStats[0]?.medium || 0,
          low: issueStats[0]?.low || 0,
        },
        byStatus: {
          detected: issueStats[0]?.detected || 0,
          fixGenerated: issueStats[0]?.fixGenerated || 0,
          prCreated: issueStats[0]?.prCreated || 0,
          resolved: resolvedIssues,
        },
        byType: {
          security: issueStats[0]?.security || 0,
          bugs: issueStats[0]?.bugs || 0,
          performance: issueStats[0]?.performance || 0,
          codeQuality: issueStats[0]?.codeQuality || 0,
        },
        resolutionRate,
      },
      pullRequests: {
        total: totalPRs,
        byStatus: {
          open: prStats[0]?.open || 0,
          merged: mergedPRs,
          closed: prStats[0]?.closed || 0,
        },
        byRisk: {
          high: prStats[0]?.highRisk || 0,
          medium: prStats[0]?.mediumRisk || 0,
          low: prStats[0]?.lowRisk || 0,
        },
        mergeRate,
      },
      audit: {
        totalActions: auditStats.total,
        analyses: auditStats.analyses,
        fixes: auditStats.fixes,
        prsCreated: auditStats.prsCreated,
        prsMerged: auditStats.prsMerged,
        errors: auditStats.errors,
        highRiskActions: auditStats.highRisk,
      },
    };

    console.log(`✅ Stats fetched for ${repository.repoName}`);

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error("❌ Get repository stats error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch repository statistics",
    });
  }
});

/**
 * GET /api/stats/user/overview
 * Get overview statistics for user across all repositories
 */
router.get("/user/overview", authMiddleware.verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    console.log(`📊 Fetching user overview stats`);

    // Get all user repositories
    const repositories = await Repository.find({ userId });
    const repoIds = repositories.map((r) => r._id);

    // Aggregate statistics across all repositories
    const issueStats = await Issue.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          critical: {
            $sum: { $cond: [{ $eq: ["$severity", "CRITICAL"] }, 1, 0] },
          },
          resolved: {
            $sum: { $cond: [{ $eq: ["$status", "resolved"] }, 1, 0] },
          },
        },
      },
    ]);

    const prStats = await PullRequest.aggregate([
      { $match: { userId: userId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          merged: {
            $sum: { $cond: [{ $eq: ["$status", "merged"] }, 1, 0] },
          },
        },
      },
    ]);

    const auditStats = await auditService.getStats(userId);

    const overview = {
      repositories: repositories.length,
      issues: {
        total: issueStats[0]?.total || 0,
        critical: issueStats[0]?.critical || 0,
        resolved: issueStats[0]?.resolved || 0,
      },
      pullRequests: {
        total: prStats[0]?.total || 0,
        merged: prStats[0]?.merged || 0,
      },
      audit: {
        totalActions: auditStats.total,
        analyses: auditStats.analyses,
        fixes: auditStats.fixes,
      },
    };

    res.json({
      success: true,
      overview,
    });
  } catch (error) {
    console.error("❌ Get user overview error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch user overview",
    });
  }
});

module.exports = router;
