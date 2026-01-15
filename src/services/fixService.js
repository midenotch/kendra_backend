const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const axios = require("axios");
const Issue = require("../models/Issue");
const PullRequest = require("../models/PullRequest");
const Repository = require("../models/Repository");
const User = require("../models/User");
const auditService = require("./auditService");
const geminiService = require("./geminiService");
const cerebrasService = require("./cerebrasService");

class FixService {
  /**
   * Generate fix for an issue and create PR
   */

  async fixIssue(issueId, userId) {
    let issue = null;
    let repository = null;
    let user = null;

    try {
      console.log(`🔧 Starting fix generation for issue: ${issueId}`);

      // Get issue details
      issue = await Issue.findById(issueId);
      if (!issue) {
        throw new Error("Issue not found");
      }

      if (issue.status !== "detected") {
        throw new Error(
          `Issue already being processed. Status: ${issue.status}`
        );
      }

      // Get repository and user
      repository = await Repository.findById(issue.repositoryId);
      user = await User.findById(userId);

      if (!repository || !user || !user.githubAccessToken) {
        throw new Error("Repository or GitHub connection not found");
      }

      // Validate the issue has required fields
      if (!issue.filePath || !issue.title) {
        throw new Error("Issue missing required fields (filePath or title)");
      }

      // Update issue status
      issue.status = "fix-generated";
      issue.fixAttempts += 1;
      await issue.save();

      // Step 1: Get current file content
      console.log("📄 Fetching current file content...");
      const fileContent = await this.getFileContent(
        repository.repoOwner,
        repository.repoName,
        issue.filePath,
        user.githubAccessToken
      );

      if (!fileContent) {
        throw new Error(`Could not fetch file content for ${issue.filePath}`);
      }

      // Step 2: Generate fix with AI
      console.log("🤖 Generating fix with AI...");
      const fixedContent = await this.generateFixWithAI(
        fileContent,
        issue,
        repository
      );

      if (!fixedContent || fixedContent === fileContent) {
        throw new Error("AI could not generate a valid fix");
      }

      // Step 3: Create new branch
      console.log("🌿 Creating new branch...");
      const branchName = `kendra/fix-${issue._id.toString().substring(0, 8)}`;
      await this.createBranch(
        repository.repoOwner,
        repository.repoName,
        branchName,
        user.githubAccessToken
      );

      // Step 4: Commit fix
      console.log("💾 Committing fix...");
      await this.commitFile(
        repository.repoOwner,
        repository.repoName,
        issue.filePath,
        fixedContent,
        branchName,
        `Fix: ${issue.title}`,
        user.githubAccessToken
      );

      // Step 4.5: Validate before creating PR
      console.log("🔍 Validating before PR creation...");
      const validation = await this.validatePRCreation(
        repository.repoOwner,
        repository.repoName,
        branchName,
        user.githubAccessToken
      );

      if (!validation.canProceed) {
        if (validation.existingPR) {
          // PR already exists, update issue and return existing PR info
          issue.status = "pr-created";
          issue.fixStatus = "existing_pr_found";
          await issue.save();

          return {
            success: true,
            message: "PR already exists for this fix",
            prNumber: validation.existingPR.number,
            prUrl: validation.existingPR.html_url,
            existing: true,
          };
        }
        throw new Error("Pre-flight validation failed");
      }

      // Step 5: Create Pull Request
      console.log("🔀 Creating pull request...");
      const prData = await this.createPullRequest(
        repository.repoOwner,
        repository.repoName,
        branchName,
        issue,
        user.githubAccessToken
      );

      // Step 6: Save PR to database
      const pullRequest = await PullRequest.create({
        repositoryId: repository._id,
        userId: user._id,
        issueId: issue._id,
        githubPrId: prData.id,
        prNumber: prData.number,
        title: prData.title,
        body: prData.body,
        url: prData.html_url,
        branch: branchName,
        status: "open",
        reviewStatus: "pending",
        aiGenerated: true,
        riskLevel: this.calculateRiskLevel(issue.severity),
        changesSummary: `Fixed ${issue.issueType} issue in ${issue.filePath}`,
      });

      // Update issue with PR info
      issue.status = "pr-created";
      issue.pullRequestId = pullRequest._id;
      issue.fixedAt = new Date();
      await issue.save();

      console.log(`✅ Fix complete! PR #${prData.number} created`);

      // Log to audit trail
      await auditService.logFixGeneration(userId, repository._id, issue, {
        prNumber: prData.number,
        prUrl: prData.html_url,
        pullRequest,
      });

      await auditService.logPRCreation(
        userId,
        repository._id,
        pullRequest,
        issue
      );

      return {
        success: true,
        pullRequest,
        prNumber: prData.number,
        prUrl: prData.html_url,
      };
    } catch (error) {
      console.error("❌ Fix generation failed:", error);

      // Update issue status back to detected with error details
      try {
        if (issue && issue.status === "fix-generated") {
          issue.status = "detected";
          issue.lastFixError = error.message.substring(0, 200);
          issue.lastFixAttempt = new Date();
          await issue.save();
        }
      } catch (updateError) {
        console.error("Failed to update issue status:", updateError);
      }

      // Log error to audit trail
      if (issue) {
        await auditService.logError(
          userId,
          issue.repositoryId,
          `Fix generation for issue: ${issue.title}`,
          error
        );
      }

      // Return more specific error messages
      let userMessage = error.message;

      if (error.message.includes("Validation Failed")) {
        userMessage =
          "GitHub rejected the PR creation. This might be due to: 1) Branch doesn't exist, 2) PR already exists, 3) Invalid parameters, or 4) Repository permissions issue.";
      } else if (error.message.includes("rate limit")) {
        userMessage = "GitHub API rate limit exceeded. Please try again later.";
      } else if (error.message.includes("Not Found")) {
        userMessage =
          "Repository or file not found. Please check if the repository still exists.";
      } else if (error.message.includes("permission")) {
        userMessage =
          "Insufficient GitHub permissions. Please ensure you have write access to the repository.";
      }

      throw new Error(`Fix generation failed: ${userMessage}`);
    }
  }

  /**
   * Get file content from GitHub
   */
  async getFileContent(owner, repo, path, token) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Kendra-AI-DevOps",
          },
        }
      );

      return Buffer.from(response.data.content, "base64").toString("utf-8");
    } catch (error) {
      console.error(`Error fetching file ${path}:`, error.message);
      throw new Error(`Failed to fetch file: ${error.message}`);
    }
  }


  async generateFixWithAI(originalContent, issue, repository) {
    /* PREVIOUS PROMPT:
    const systemPrompt = `You are an expert software engineer. Return ONLY the fixed code, no explanations, no markdown formatting.`;

    const userPrompt = `Fix the following issue in this code file.

Repository: ${repository.repoOwner}/${repository.repoName}
Language: ${repository.language || "Unknown"}
File: ${issue.filePath}

Issue Details:
- Title: ${issue.title}
- Type: ${issue.issueType}
- Severity: ${issue.severity}
- Description: ${issue.description}
- Line Number: ${issue.lineNumber || "Unknown"}
- AI Explanation: ${issue.aiExplanation || "Security/quality issue detected"}
- Suggested Fix: ${issue.suggestedFix || "Apply standard fix"}

Current File Content:
\`\`\`
${originalContent}
\`\`\`

TASK: Fix the issue in the code above. Return ONLY the complete fixed file content.

Requirements:
1. Fix ONLY the specific issue mentioned
2. Maintain all existing functionality
3. Keep the same coding style and formatting
4. Don't add comments explaining the fix
5. Ensure the fix is production-ready
6. Return the COMPLETE file with the fix applied

Return ONLY the fixed code, no explanations, no markdown formatting, just the raw code.`;
    */

    // NEW OPTIMIZED PROMPT:
    const systemPrompt = `Expert Debugger. Fix ${issue.issueType} issue. Return ONLY COMPLETE FIXED CODE. No chat. No markdown.`;

    const userPrompt = `File: ${issue.filePath}
Issue: ${issue.title}
Description: ${issue.description}
Fix: ${issue.suggestedFix}

CODE:
${originalContent}`;

    try {
      let fixedContent;
      let serviceUsed = "Gemini";

      if (process.env.CEREBRAS_API_KEY) {
        console.log("⚡ Calling Cerebras for fix generation...");
        try {
          const response = await cerebrasService.generateFix(
            systemPrompt,
            userPrompt,
            {
              model: "llama3.1-70b",
              temperature: 0.1,
              maxTokens: 2000,
            }
          );
          fixedContent = response.text.trim();
          serviceUsed = "Cerebras";
        } catch (cerebrasError) {
          console.warn("⚠️ Cerebras fix generation failed, falling back to Gemini:", cerebrasError.message);
          const response = await geminiService.generateFix(
            systemPrompt,
            userPrompt,
            {
              model: "gemini-2.5-flash",
              temperature: 0.2,
              maxTokens: 2000,
            }
          );
          fixedContent = response.text.trim();
        }
      } else {
        console.log("🤖 Calling Gemini for fix generation...");
        const response = await geminiService.generateFix(
          systemPrompt,
          userPrompt,
          {
            model: "gemini-2.5-flash",
            temperature: 0.2,
            maxTokens: 2000,
          }
        );
        fixedContent = response.text.trim();
      }

      fixedContent = fixedContent
        .replace(/^```[a-z]*\n/i, "")
        .replace(/\n```$/i, "");

      console.log(`✅ ${serviceUsed} generated fix successfully`);
      console.log(
        `📊 Fix length: ${fixedContent.length} chars (original: ${originalContent.length} chars)`
      );

      return fixedContent;
    } catch (error) {
      console.error("❌ Gemini fix generation failed:", error.message);

      // Check if it's a quota error
      if (
        error.message.includes("quota") ||
        error.message.includes("All Gemini API keys")
      ) {
        throw new Error(
          "All Gemini API keys have exceeded quota. Please add more keys or wait."
        );
      }

      throw new Error(`AI fix generation failed: ${error.message}`);
    }
  }
  /**
   * Create a new branch with conflict handling
   */
  async createBranch(owner, repo, branchName, token) {
    try {
      console.log(`🌿 Creating branch: ${branchName}`);

      // Get the default branch SHA
      const repoResponse = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Kendra-AI-DevOps",
          },
          timeout: 10000,
        }
      );

      const defaultBranch = repoResponse.data.default_branch;
      console.log(`✅ Default branch: ${defaultBranch}`);

      // Get the SHA of the default branch
      const branchResponse = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Kendra-AI-DevOps",
          },
          timeout: 10000,
        }
      );

      const sha = branchResponse.data.object.sha;
      console.log(`📌 Base SHA: ${sha.substring(0, 8)}...`);

      // Check if branch already exists
      try {
        await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${branchName}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Kendra-AI-DevOps",
            },
          }
        );
        console.log(`✅ Branch ${branchName} already exists, reusing it`);
        return; // Branch exists, nothing to do
      } catch (branchCheckError) {
        if (branchCheckError.response?.status !== 404) {
          throw branchCheckError;
        }
        // Branch doesn't exist, continue to create it
      }

      // Create new branch
      await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/git/refs`,
        {
          ref: `refs/heads/${branchName}`,
          sha: sha,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Kendra-AI-DevOps",
          },
          timeout: 15000,
        }
      );

      console.log(`✅ Created branch: ${branchName}`);
    } catch (error) {
      console.error("❌ Error creating branch:", {
        branchName,
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 422) {
        // This usually means the branch already exists or invalid ref name
        console.log(`ℹ️ Branch ${branchName} likely already exists`);
        return; // Continue anyway
      }

      throw new Error(`Failed to create branch: ${error.message}`);
    }
  }

  /**
   * Commit file to branch with better error handling
   */
  async commitFile(owner, repo, path, content, branch, message, token) {
    try {
      console.log(`📄 Committing file to ${branch}: ${path}`);

      // Get current file SHA (needed for update)
      let sha = null;
      let fileExists = false;

      try {
        const fileResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
            path
          )}?ref=${branch}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Kendra-AI-DevOps",
            },
            timeout: 10000,
          }
        );
        sha = fileResponse.data.sha;
        fileExists = true;
        console.log(`✅ File exists on branch, SHA: ${sha.substring(0, 8)}...`);
      } catch (error) {
        if (error.response?.status === 404) {
          console.log(
            `📝 File doesn't exist on branch ${branch}, will create new file`
          );
          fileExists = false;
        } else {
          throw error;
        }
      }

      // Create or update file
      const commitData = {
        message: message.substring(0, 250), 
        content: Buffer.from(content).toString("base64"),
        branch: branch,
      };

      if (sha) {
        commitData.sha = sha;
      }

      console.log(`💾 ${fileExists ? "Updating" : "Creating"} file ${path}...`);

      const response = await axios.put(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(
          path
        )}`,
        commitData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Kendra-AI-DevOps",
          },
          timeout: 30000,
        }
      );

      console.log(`✅ Committed file: ${path}`);
      console.log(
        `📌 Commit SHA: ${response.data.commit.sha.substring(0, 8)}...`
      );

      return response.data;
    } catch (error) {
      console.error("❌ Error committing file:", {
        path,
        branch,
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 409) {
        throw new Error(
          `File conflict: ${
            error.response.data.message || "Another commit modified this file"
          }`
        );
      }

      if (error.response?.data?.message?.includes("Invalid parameter")) {
        throw new Error(
          `Invalid file content or encoding: ${error.response.data.message}`
        );
      }

      throw new Error(`Failed to commit file: ${error.message}`);
    }
  }

  /**
   * Create Pull Request with better error handling
   */
  async createPullRequest(owner, repo, branch, issue, token) {
    try {
      console.log(`🔀 Creating PR for branch: ${branch}`);
      let baseBranch = "main";
      try {
        const repoResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Kendra-AI-DevOps",
            },
            timeout: 10000,
          }
        );
        baseBranch = repoResponse.data.default_branch;
        console.log(`✅ Found default branch: ${baseBranch}`);
      } catch (repoError) {
        console.warn(
          `⚠️ Could not fetch repo info, using "main" as default: ${repoError.message}`
        );
      }

      const title = `🤖 AI Fix: ${issue.title}`;

      // Create a better PR body
      let prBody = this.generatePRBody(issue, baseBranch);

      console.log(`📝 PR Details:`);
      console.log(`   Title: ${title}`);
      console.log(`   Head: ${branch}`);
      console.log(`   Base: ${baseBranch}`);
      console.log(`   Body length: ${prBody.length} chars`);

      // Validate PR body length (GitHub has limits)
      if (prBody.length > 65536) {
        console.warn(
          `⚠️ PR body is too long (${prBody.length} chars), truncating...`
        );
        prBody =
          prBody.substring(0, 60000) + "\n\n... (truncated due to length)";
      }

      const response = await axios.post(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
          title: title,
          body: prBody,
          head: branch,
          base: baseBranch,
          draft: false,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Kendra-AI-DevOps",
          },
          timeout: 30000,
        }
      );

      console.log(`✅ Created PR #${response.data.number}`);
      console.log(`🔗 PR URL: ${response.data.html_url}`);

      return response.data;
    } catch (error) {
      console.error("❌ GitHub API Error creating PR:", {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });

      // Extract meaningful error message
      let errorMessage = error.message;

      if (error.response?.data?.message) {
        errorMessage = error.response.data.message;

        // Handle specific validation errors
        if (error.response.data.errors) {
          const validationErrors = error.response.data.errors
            .map((err) => `${err.field || "field"}: ${err.message || err.code}`)
            .join(", ");
          errorMessage += ` - ${validationErrors}`;
        }

        // Handle common validation issues
        if (errorMessage.includes("Validation Failed")) {
          if (error.response.data.errors) {
            console.error("🔍 Validation Errors:", error.response.data.errors);

            // Check for specific validation issues
            const errors = error.response.data.errors;
            const fieldErrors = errors
              .map(
                (err) =>
                  `Field "${err.field || "unknown"}": ${
                    err.message || err.code
                  }`
              )
              .join("; ");

            errorMessage = `GitHub validation failed: ${fieldErrors}`;
          } else {
            errorMessage =
              "GitHub validation failed. Possible issues: branch doesn't exist, PR already exists, or invalid parameters.";
          }
        }
      }

      throw new Error(`Failed to create PR: ${errorMessage}`);
    }
  }

  /**
   * Calculate risk level based on severity
   */
  calculateRiskLevel(severity) {
    switch (severity) {
      case "CRITICAL":
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
   * Generate PR body with safe field handling
   */
  generatePRBody(issue, baseBranch) {
    const safeGet = (field, defaultValue = "N/A") => {
      const value = issue[field];
      if (value === undefined || value === null) return defaultValue;
      return value.toString().trim();
    };

    const body = `## 🤖 Automated Fix by Kendra

### Issue Details
- **Type:** ${safeGet("issueType", "bug")}
- **Severity:** ${safeGet("severity", "MEDIUM")}
- **File:** ${safeGet("filePath", "Unknown file")}
${safeGet("lineNumber") ? `- **Line:** ${safeGet("lineNumber")}` : ""}

### Problem
${safeGet("description", "Issue detected by AI security scanner")}

### AI Analysis
${safeGet(
  "aiExplanation",
  "AI identified potential security/code quality issue"
)}

### Solution Applied
${safeGet("suggestedFix", "Applied automated fix to resolve the issue")}

### Risk Assessment
- **Risk Level:** ${this.calculateRiskLevel(issue.severity)}
- **AI Confidence:** ${Math.round((issue.aiConfidence || 0.85) * 100)}%

### Technical Details
- **Target Branch:** ${baseBranch}
- **Fix Branch:** ${`kendra/fix-${issue._id.toString().substring(0, 8)}`}
- **Issue ID:** ${issue._id}

---
**⚠️ Please review carefully before merging**

This fix was automatically generated by Kendra. While our AI is highly accurate, human review is always recommended for production code.

### Review Checklist
- [ ] Test the fix locally
- [ ] Verify no breaking changes
- [ ] Check for edge cases
- [ ] Ensure security implications are addressed

🔗 **Note:** This is an AI-generated pull request.`;

    return body;
  }

  /**
   * Check if we can create a PR (pre-flight validation)
   */
  async validatePRCreation(owner, repo, branch, token) {
    try {
      console.log("🔍 Validating PR creation pre-flight...");

      // 1. Check if branch exists
      try {
        await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/branches/${branch}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Pipex-AI-DevOps",
            },
            timeout: 10000,
          }
        );
        console.log(`✅ Branch ${branch} exists`);
      } catch (branchError) {
        throw new Error(
          `Branch ${branch} does not exist: ${branchError.message}`
        );
      }

      // 2. Check if PR already exists for this branch
      try {
        const prsResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/pulls`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Pipex-AI-DevOps",
            },
            params: {
              state: "all",
              head: `${owner}:${branch}`,
            },
            timeout: 10000,
          }
        );

        if (prsResponse.data.length > 0) {
          console.log(
            `⚠️ PR already exists for branch ${branch}: #${prsResponse.data[0].number}`
          );
          return {
            canProceed: false,
            existingPR: prsResponse.data[0],
          };
        }
      } catch (prCheckError) {
        console.warn(
          `⚠️ Could not check existing PRs: ${prCheckError.message}`
        );
      }

      // 3. Check repository permissions
      try {
        const repoResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "Pipex-AI-DevOps",
            },
            timeout: 10000,
          }
        );

        const permissions = repoResponse.data.permissions;
        if (!permissions.push || !permissions.pull) {
          console.warn(
            `⚠️ Limited permissions: push=${permissions.push}, pull=${permissions.pull}`
          );
        }

        console.log(`✅ Repository accessible with permissions:`, permissions);
      } catch (repoError) {
        console.warn(
          `⚠️ Could not verify repository permissions: ${repoError.message}`
        );
      }

      console.log("✅ Pre-flight validation passed");
      return { canProceed: true };
    } catch (error) {
      console.error("❌ Pre-flight validation failed:", error.message);
      throw error;
    }
  }
}

module.exports = new FixService();
