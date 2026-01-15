const express = require("express");
const crypto = require("crypto");
const PullRequest = require("../models/PullRequest");
const Issue = require("../models/Issue");
const auditService = require("../services/auditService");
const config = require("../config");

const router = express.Router();

/**
 * Verify GitHub webhook signature
 */
function verifyGitHubSignature(req, res, next) {
  const signature = req.headers["x-hub-signature-256"];

  if (!signature) {
    console.error("❌ No signature in webhook");
    return res.status(401).json({ error: "No signature" });
  }

  const payload = JSON.stringify(req.body);
  const hmac = crypto.createHmac("sha256", config.githubWebhookSecret);
  const digest = "sha256=" + hmac.update(payload).digest("hex");

  if (signature !== digest) {
    console.error("❌ Invalid webhook signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  next();
}

/**
 * Handle GitHub webhook events
 */
router.post(
  "/github",
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
  verifyGitHubSignature,
  async (req, res) => {
    try {
      const event = req.headers["x-github-event"];
      const payload = req.body;

      console.log(`📡 Webhook received: ${event}`);

      if (event === "pull_request") {
        await handlePullRequestEvent(payload);
      }

      if (event === "push") {
        await handlePushEvent(payload);
      }

      res.status(200).json({ success: true, message: "Webhook processed" });
    } catch (error) {
      console.error("❌ Webhook error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  }
);

/**
 * Handle pull request events
 */

async function handlePullRequestEvent(payload) {
  const action = payload.action;
  const pr = payload.pull_request;

  console.log(`🔀 PR #${pr.number} - Action: ${action} - Merged: ${pr.merged}`);

  const dbPr = await PullRequest.findOne({ githubPrId: pr.id });

  if (!dbPr) {
    console.log("ℹ️ PR not found in database (not created by Pipex AI)");
    return;
  }

  console.log(`📝 PR Database Status: ${dbPr.status}, Issue: ${dbPr.issueId}`);

  switch (action) {
    case "closed":
      const previousStatus = dbPr.status;
      const isMerged = pr.merged === true;

      dbPr.status = isMerged ? "merged" : "closed";
      dbPr.updatedAt = new Date();

      if (isMerged) {
        dbPr.mergedAt = new Date(pr.merged_at);
        console.log(`✅ PR #${pr.number} merged (was: ${previousStatus})`);

        if (dbPr.issueId) {
          const issue = await Issue.findByIdAndUpdate(
            dbPr.issueId,
            {
              status: "resolved",
              resolvedAt: new Date(),
              pullRequestStatus: "merged",
              lastUpdatedAt: new Date(),
            },
            { new: true } 
          );

          if (issue) {
            console.log(`✅ Issue ${dbPr.issueId} marked as resolved`);
            await auditService.logIssueResolution(
              dbPr.userId,
              dbPr.repositoryId,
              issue
            );
          }
        }

        // Log PR merge
        await auditService.logPRMerge(dbPr.userId, dbPr.repositoryId, dbPr);
      } else {
        dbPr.closedAt = new Date(pr.closed_at);
        console.log(
          `🚫 PR #${pr.number} closed without merging (was: ${previousStatus})`
        );

        // If PR was closed without merging, update issue status
        if (dbPr.issueId && previousStatus === "open") {
          const issue = await Issue.findByIdAndUpdate(
            dbPr.issueId,
            {
              status: "detected", // Revert to detected
              pullRequestStatus: "closed",
              lastUpdatedAt: new Date(),
            },
            { new: true }
          );

          if (issue) {
            console.log(`🔄 Issue ${dbPr.issueId} reverted to detected status`);
          }
        }
      }

      await dbPr.save();
      break;

    case "opened":
    case "reopened":
      dbPr.status = "open";
      dbPr.updatedAt = new Date();

      // Update issue status if it was previously resolved
      if (dbPr.issueId) {
        const issue = await Issue.findById(dbPr.issueId);
        if (issue && issue.status === "resolved") {
          await Issue.findByIdAndUpdate(dbPr.issueId, {
            status: "detected",
            pullRequestStatus: "reopened",
            lastUpdatedAt: new Date(),
          });
          console.log(
            `🔄 Issue ${dbPr.issueId} reverted to detected (PR reopened)`
          );
        }
      }

      await dbPr.save();
      console.log(`🔓 PR #${pr.number} opened/reopened`);
      break;

    case "synchronize":
      // PR was updated with new commits
      dbPr.updatedAt = new Date();
      await dbPr.save();
      console.log(`🔄 PR #${pr.number} synchronized`);
      break;

    default:
      console.log(`ℹ️ Unhandled PR action: ${action}`);
  }
}

/**
 * Handle push events
 */
async function handlePushEvent(payload) {
  const ref = payload.ref;
  const commits = payload.commits || [];

  console.log(`📤 Push to ${ref} - ${commits.length} commits`);

  // Check if this is a merge to main/master
  if (ref === "refs/heads/main" || ref === "refs/heads/master") {
    // Look for merged PRs in commit messages
    for (const commit of commits) {
      const prMatch = commit.message.match(/#(\d+)/);
      if (prMatch) {
        const prNumber = parseInt(prMatch[1]);

        const dbPr = await PullRequest.findOne({ prNumber });
        if (dbPr && dbPr.status === "open") {
          dbPr.status = "merged";
          dbPr.mergedAt = new Date(commit.timestamp);
          dbPr.updatedAt = new Date();
          await dbPr.save();

          // Update related issue
          if (dbPr.issueId) {
            await Issue.findByIdAndUpdate(dbPr.issueId, {
              status: "resolved",
              resolvedAt: new Date(),
            });
          }

          console.log(`✅ PR #${prNumber} marked as merged from push event`);
        }
      }
    }
  }
}

/**
 * POST /api/webhooks/sync-pr-status
 * Manually sync PR status from GitHub (useful for debugging)
 */
router.post("/sync-pr-status", express.json(), async (req, res) => {
  try {
    const { repositoryId, prNumber } = req.body;

    if (!repositoryId || !prNumber) {
      return res.status(400).json({
        success: false,
        error: "repositoryId and prNumber are required",
      });
    }

    // Find the repository
    const Repository = require("../models/Repository");
    const repository = await Repository.findById(repositoryId);

    if (!repository) {
      return res.status(404).json({
        success: false,
        error: "Repository not found",
      });
    }

    // Find the PR in database
    const dbPr = await PullRequest.findOne({
      repositoryId,
      prNumber,
    });

    if (!dbPr) {
      return res.status(404).json({
        success: false,
        error: "PR not found in database",
      });
    }

    // Find user who created the PR (to get GitHub token)
    const User = require("../models/User");
    const user = await User.findById(dbPr.userId);

    if (!user || !user.githubAccessToken) {
      return res.status(400).json({
        success: false,
        error: "User GitHub token not available",
      });
    }

    // Fetch current PR status from GitHub API
    const axios = require("axios");
    const githubResponse = await axios.get(
      `https://api.github.com/repos/${repository.repoOwner}/${repository.repoName}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `Bearer ${user.githubAccessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "Pipex-AI-DevOps",
        },
      }
    );

    const githubPr = githubResponse.data;
    const wasMerged = githubPr.merged === true;
    const wasClosed = githubPr.state === "closed";

    // Update database status
    if (wasMerged) {
      dbPr.status = "merged";
      dbPr.mergedAt = new Date(githubPr.merged_at);
      console.log(`✅ Manually synced PR #${prNumber}: Merged`);

      // Update issue if exists
      if (dbPr.issueId) {
        await Issue.findByIdAndUpdate(dbPr.issueId, {
          status: "resolved",
          resolvedAt: new Date(),
          lastUpdatedAt: new Date(),
        });
        console.log(`✅ Issue ${dbPr.issueId} marked as resolved`);
      }
    } else if (wasClosed) {
      dbPr.status = "closed";
      dbPr.closedAt = new Date(githubPr.closed_at);
      console.log(`🚫 Manually synced PR #${prNumber}: Closed without merge`);
    } else {
      dbPr.status = "open";
      console.log(`🔓 Manually synced PR #${prNumber}: Open`);
    }

    dbPr.updatedAt = new Date();
    await dbPr.save();

    res.json({
      success: true,
      message: "PR status synced successfully",
      pr: {
        id: dbPr._id,
        number: dbPr.prNumber,
        status: dbPr.status,
        merged: wasMerged,
        closed: wasClosed,
      },
    });
  } catch (error) {
    console.error("❌ PR sync error:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: "Failed to sync PR status",
    });
  }
});

/**
 * GET /api/webhooks/test
 * Test endpoint to verify webhook setup
 */
router.get("/test", (req, res) => {
  res.json({
    success: true,
    message: "Webhook endpoint is working",
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
