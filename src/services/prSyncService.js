const PullRequest = require("../models/PullRequest");
const Repository = require("../models/Repository");
const User = require("../models/User");
const Issue = require("../models/Issue");
const axios = require("axios");

class PRSyncService {
  constructor() {
    this.syncInterval = 30 * 60 * 1000;
    this.isSyncing = false;
  }

  /**
   * Start periodic sync
   */
  startPeriodicSync() {
    // console.log("🔄 Starting periodic PR status sync...");

    setTimeout(() => this.syncAllOpenPRs(), 60000);

    setInterval(() => this.syncAllOpenPRs(), this.syncInterval);
  }

  /**
   * Sync all open PRs from GitHub
   */
  async syncAllOpenPRs() {
    if (this.isSyncing) {
      console.log("⏳ PR sync already in progress, skipping...");
      return;
    }

    this.isSyncing = true;
    console.log("🔄 Syncing all open PRs from GitHub...");

    try {
      // Find all open PRs
      const openPRs = await PullRequest.find({ status: "open" });

      console.log(`Found ${openPRs.length} open PRs to sync`);

      let syncedCount = 0;
      let mergedCount = 0;

      for (const pr of openPRs) {
        try {
          const synced = await this.syncSinglePR(pr);
          if (synced) {
            syncedCount++;
            if (pr.status === "merged") {
              mergedCount++;
            }
          }
        } catch (error) {
          console.error(`❌ Failed to sync PR #${pr.prNumber}:`, error.message);
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // console.log(
      //   `✅ PR sync completed: ${syncedCount} synced, ${mergedCount} merged`
      // );
    } catch (error) {
      console.error("❌ PR sync failed:", error.message);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync a single PR from GitHub
   */
  async syncSinglePR(dbPr) {
    try {
      // Get repository
      const repository = await Repository.findById(dbPr.repositoryId);
      if (!repository) {
        console.log(`ℹ️ Repository not found for PR #${dbPr.prNumber}`);
        return false;
      }

      // Get user for GitHub token
      const user = await User.findById(dbPr.userId);
      if (!user || !user.githubAccessToken) {
        console.log(`ℹ️ GitHub token not available for PR #${dbPr.prNumber}`);
        return false;
      }

      // Fetch current PR status from GitHub
      const response = await axios.get(
        `https://api.github.com/repos/${repository.repoOwner}/${repository.repoName}/pulls/${dbPr.prNumber}`,
        {
          headers: {
            Authorization: `Bearer ${user.githubAccessToken}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Pipex-AI-DevOps",
          },
          timeout: 10000,
        }
      );

      const githubPr = response.data;
      const wasMerged = githubPr.merged === true;
      const wasClosed = githubPr.state === "closed";
      const previousStatus = dbPr.status;

      // Update if status changed
      if (wasMerged && dbPr.status !== "merged") {
        dbPr.status = "merged";
        dbPr.mergedAt = new Date(githubPr.merged_at);
        dbPr.updatedAt = new Date();

        // Update related issue
        if (dbPr.issueId) {
          await Issue.findByIdAndUpdate(dbPr.issueId, {
            status: "resolved",
            resolvedAt: new Date(),
            lastUpdatedAt: new Date(),
          });
          console.log(`✅ PR #${dbPr.prNumber} merged, issue resolved`);
        }

        await dbPr.save();
        return true;
      } else if (wasClosed && dbPr.status !== "closed") {
        dbPr.status = "closed";
        dbPr.closedAt = new Date(githubPr.closed_at);
        dbPr.updatedAt = new Date();
        await dbPr.save();
        console.log(`🚫 PR #${dbPr.prNumber} closed without merging`);
        return true;
      }

      // Status unchanged
      return false;
    } catch (error) {
      if (error.response?.status === 404) {
        // PR was deleted on GitHub
        dbPr.status = "closed";
        dbPr.updatedAt = new Date();
        await dbPr.save();
        console.log(`🗑️ PR #${dbPr.prNumber} appears to be deleted on GitHub`);
        return true;
      }
      throw error;
    }
  }
}

module.exports = new PRSyncService();
