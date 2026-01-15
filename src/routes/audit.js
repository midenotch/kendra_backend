const express = require("express");
const authMiddleware = require("../middleware/auth");
const auditService = require("../services/auditService");
const AuditLog = require("../models/AuditLog");

const router = express.Router();

/**
 * GET /api/audit
 * Get audit logs for the user
 */
router.get("/", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { repositoryId, actionType, riskLevel, limit } = req.query;

    const logs = await auditService.getUserLogs(req.userId, {
      repositoryId,
      actionType,
      riskLevel,
      limit: limit ? parseInt(limit) : 100,
    });

    res.json({
      success: true,
      logs,
      count: logs.length,
    });
  } catch (error) {
    console.error("❌ Get audit logs error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch audit logs",
    });
  }
});

/**
 * GET /api/audit/stats
 * Get audit statistics
 */
router.get("/stats", authMiddleware.verifyToken, async (req, res) => {
  try {
    const { repositoryId } = req.query;

    const stats = await auditService.getStats(req.userId, repositoryId);

    res.json({
      success: true,
      stats,
    });
  } catch (error) {
    console.error("❌ Get audit stats error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch audit statistics",
    });
  }
});

/**
 * GET /api/audit/:id
 * Get single audit log details
 */
router.get("/:id", authMiddleware.verifyToken, async (req, res) => {
  try {
    const log = await AuditLog.findOne({
      _id: req.params.id,
      userId: req.userId,
    })
      .populate("repositoryId")
      .populate("userId", "name email");

    if (!log) {
      return res.status(404).json({
        success: false,
        error: "Audit log not found",
      });
    }

    res.json({
      success: true,
      log,
    });
  } catch (error) {
    console.error("❌ Get audit log error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch audit log",
    });
  }
});

module.exports = router;
