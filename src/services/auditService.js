const AuditLog = require("../models/AuditLog");

class AuditService {
  /**
   * Log an AI action
   */
  async logAction(data) {
    try {
      const log = await AuditLog.create({
        userId: data.userId,
        repositoryId: data.repositoryId,
        agentName: data.agentName || "Pipex AI",
        action: data.action,
        actionType: data.actionType,
        riskLevel: data.riskLevel,
        approved: data.approved !== undefined ? data.approved : true,
        details: data.details,
        metadata: data.metadata,
      });

      console.log(`📝 Audit log created: ${data.action}`);
      return log;
    } catch (error) {
      console.error("❌ Failed to create audit log:", error);
      return null;
    }
  }

  /**
   * Log repository analysis
   */
  async logAnalysis(userId, repositoryId, repository, result) {
    return this.logAction({
      userId,
      repositoryId,
      agentName: "Analysis Engine",
      action: `Analyzed repository ${repository.repoOwner}/${repository.repoName}`,
      actionType: "analysis",
      riskLevel: "LOW",
      approved: true,
      details: {
        issuesFound: result.issuesFound,
        criticalIssues: result.critical,
        filesAnalyzed: result.filesAnalyzed || 0,
        duration: result.duration || 0,
      },
      metadata: {
        repoName: repository.repoName,
        repoOwner: repository.repoOwner,
        language: repository.language,
      },
    });
  }

  /**
   * Log fix generation
   */
  async logFixGeneration(userId, repositoryId, issue, result) {
    const riskLevel = this.calculateRiskLevel(issue.severity);

    return this.logAction({
      userId,
      repositoryId,
      agentName: "Fix Generator",
      action: `Generated fix for: ${issue.title}`,
      actionType: "fix-generation",
      riskLevel,
      approved: true,
      details: {
        issueId: issue._id,
        issueType: issue.issueType,
        severity: issue.severity,
        filePath: issue.filePath,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
      },
      metadata: {
        issueTitle: issue.title,
        branch: result.pullRequest?.branch,
      },
    });
  }

  /**
   * Log PR creation
   */
  async logPRCreation(userId, repositoryId, pr, issue) {
    const riskLevel = issue
      ? this.calculateRiskLevel(issue.severity)
      : "MEDIUM";

    return this.logAction({
      userId,
      repositoryId,
      agentName: "PR Manager",
      action: `Created Pull Request #${pr.prNumber}: ${pr.title}`,
      actionType: "pr-creation",
      riskLevel,
      approved: true,
      details: {
        prNumber: pr.prNumber,
        prUrl: pr.url,
        branch: pr.branch,
        issueId: issue?._id,
        issueType: issue?.issueType,
        severity: issue?.severity,
      },
      metadata: {
        prTitle: pr.title,
        filesChanged: pr.filesChanged,
      },
    });
  }

  /**
   * Log PR merge
   */
  async logPRMerge(userId, repositoryId, pr) {
    return this.logAction({
      userId,
      repositoryId,
      agentName: "GitHub Webhook",
      action: `Pull Request #${pr.prNumber} merged`,
      actionType: "pr-merge",
      riskLevel: "LOW",
      approved: true,
      details: {
        prNumber: pr.prNumber,
        prUrl: pr.url,
        mergedAt: pr.mergedAt,
        issueId: pr.issueId,
      },
      metadata: {
        prTitle: pr.title,
      },
    });
  }

  /**
   * Log issue resolution
   */
  async logIssueResolution(userId, repositoryId, issue) {
    return this.logAction({
      userId,
      repositoryId,
      agentName: "Issue Tracker",
      action: `Issue resolved: ${issue.title}`,
      actionType: "issue-resolution",
      riskLevel: "LOW",
      approved: true,
      details: {
        issueId: issue._id,
        issueType: issue.issueType,
        severity: issue.severity,
        resolvedAt: issue.resolvedAt,
        prId: issue.pullRequestId,
      },
      metadata: {
        issueTitle: issue.title,
        filePath: issue.filePath,
      },
    });
  }

  /**
   * Log errors and failures
   */
  async logError(userId, repositoryId, action, error) {
    return this.logAction({
      userId,
      repositoryId,
      agentName: "System",
      action: `Failed: ${action}`,
      actionType: "error",
      riskLevel: "HIGH",
      approved: false,
      details: {
        error: error.message,
        stack: error.stack,
      },
    });
  }

  /**
   * Calculate risk level from severity
   */
  calculateRiskLevel(severity) {
    switch (severity) {
      case "CRITICAL":
        return "HIGH";
      case "HIGH":
        return "HIGH";
      case "MEDIUM":
        return "MEDIUM";
      case "LOW":
      default:
        return "LOW";
    }
  }

  /**
   * Get audit logs for user
   */
  async getUserLogs(userId, options = {}) {
    const query = { userId };

    if (options.repositoryId) {
      query.repositoryId = options.repositoryId;
    }

    if (options.actionType) {
      query.actionType = options.actionType;
    }

    if (options.riskLevel) {
      query.riskLevel = options.riskLevel;
    }

    const logs = await AuditLog.find(query)
      .populate("repositoryId", "repoName repoOwner")
      .sort({ timestamp: -1 })
      .limit(options.limit || 100);

    return logs;
  }

  /**
   * Get audit statistics
   */
  async getStats(userId, repositoryId = null) {
    const match = { userId };
    if (repositoryId) {
      match.repositoryId = repositoryId;
    }

    const stats = await AuditLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          analyses: {
            $sum: { $cond: [{ $eq: ["$actionType", "analysis"] }, 1, 0] },
          },
          fixes: {
            $sum: { $cond: [{ $eq: ["$actionType", "fix-generation"] }, 1, 0] },
          },
          prsCreated: {
            $sum: { $cond: [{ $eq: ["$actionType", "pr-creation"] }, 1, 0] },
          },
          prsMerged: {
            $sum: { $cond: [{ $eq: ["$actionType", "pr-merge"] }, 1, 0] },
          },
          errors: {
            $sum: { $cond: [{ $eq: ["$actionType", "error"] }, 1, 0] },
          },
          highRisk: {
            $sum: { $cond: [{ $eq: ["$riskLevel", "HIGH"] }, 1, 0] },
          },
        },
      },
    ]);

    return (
      stats[0] || {
        total: 0,
        analyses: 0,
        fixes: 0,
        prsCreated: 0,
        prsMerged: 0,
        errors: 0,
        highRisk: 0,
      }
    );
  }
}

module.exports = new AuditService();
