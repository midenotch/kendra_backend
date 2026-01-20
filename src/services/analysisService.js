const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const axios = require("axios");
const Issue = require("../models/Issue");
const Repository = require("../models/Repository");
const User = require("../models/User");
const auditService = require("./auditService");
const geminiService = require("./geminiService");
const cerebrasService = require("./cerebrasService");
const { spawn } = require("child_process");

class AnalysisService {
  constructor() {
    this.MAX_FILES_PER_BATCH = 4;
    this.MAX_CONTENT_LENGTH = 3000;
    this.SUPPORTED_EXTENSIONS = [
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".py",
      ".java",
      ".go",
      ".rb",
      ".php",
      ".cs",
      ".cpp",
      ".c",
      ".h",
      ".yml",
      ".yaml",
      ".json",
      ".md",
      ".env.example",
    ];
  }
  /**
   * Analyze a repository for issues
   */
  async analyzeRepository(repositoryId, userId) {
    const startTime = Date.now();
    try {
      console.log(`🔍 Starting analysis for repository: ${repositoryId}`);

      // Get repository and user
      const repository = await Repository.findById(repositoryId);
      const user = await User.findById(userId);

      if (!repository || !user) {
        throw new Error("Repository or user not found");
      }

      if (!user.githubAccessToken) {
        throw new Error("GitHub not connected");
      }

      // Update repository status
      repository.analysisStatus = "analyzing";
      await repository.save();

      // Step 1: Get repository files
      console.log("📁 Fetching repository files...");
      const files = await this.getRepositoryFiles(
        repository.repoOwner,
        repository.repoName,
        user.githubAccessToken
      );

      console.log(`✅ Found ${files.length} files to analyze`);

      // Step 2: Filter and prioritize files
      const filesToAnalyze = this.filterFiles(files);
      console.log(`🎯 Selected ${filesToAnalyze.length} files for analysis`);

      // Step 2.5: Fetch Project Manifest for Context
      let projectManifest = "";
      try {
        const manifestFile = files.find(f => f.name === "package.json" || f.name === "requirements.txt" || f.name === "go.mod");
        if (manifestFile) {
          const contentObj = await this.getFileContent(repository.repoOwner, repository.repoName, manifestFile.path, user.githubAccessToken);
          if (contentObj) projectManifest = `[MANIFEST: ${manifestFile.name}]\n${contentObj.content}`;
        }
      } catch (e) {
        console.warn("⚠️ Could not fetch project manifest for context:", e.message);
      }

      if (filesToAnalyze.length === 0) {
        console.warn(
          "⚠️ No files selected for analysis - repo might only have excluded files"
        );

        // Update repository status
        repository.analysisStatus = "completed";
        repository.lastAnalyzedAt = new Date();
        await repository.save();

        return {
          success: true,
          issuesFound: 0,
          critical: 0,
          issues: [],
        };
      }

      // Step 3: Batch process files
      const allIssues = [];
      const batchSize = this.MAX_FILES_PER_BATCH;
      const ISSUE_LIMIT = 25;
      
      for (let i = 0; i < filesToAnalyze.length; i += batchSize) {
        const batch = filesToAnalyze.slice(i, i + batchSize);
        console.log(
          `🔄 Analyzing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
            filesToAnalyze.length / batchSize
          )}`
        );

        // Get file contents
        const filesWithContent = await Promise.all(
          batch.map((file) =>
            this.getFileContent(
              repository.repoOwner,
              repository.repoName,
              file.path,
              user.githubAccessToken
            )
          )
        );

        // Analyze with AI
        const batchIssues = await this.analyzeFilesWithAI(
          filesWithContent,
          repository,
          batchSize,
          projectManifest
        );

        if (batchIssues && batchIssues.length > 0) {
          allIssues.push(...batchIssues);
        }

        // Optional: limit total issues if needed
        if (allIssues.length >= ISSUE_LIMIT) {
          console.log(`🛑 Reached issue limit (${ISSUE_LIMIT}). Stopping analysis.`);
          break;
        }
      }

      // Step 4: Save issues to database
      console.log(`💾 Saving ${allIssues.length} issues to database...`);
      const savedIssues = await this.saveIssuesToDatabase(
        allIssues,
        repositoryId,
        userId
      );

      // Step 5: Update repository
      repository.analysisStatus = "completed";
      repository.lastAnalyzedAt = new Date();
      repository.stats.totalIssues = savedIssues.length;
      repository.stats.criticalIssues = savedIssues.filter(
        (i) => i.severity === "CRITICAL"
      ).length;
      await repository.save();

      console.log(`✅ Analysis complete! Found ${savedIssues.length} issues`);

      // Step 6: Log to audit trail
      const duration = Math.floor((Date.now() - startTime) / 1000);
      await auditService.logAnalysis(userId, repositoryId, repository, {
        issuesFound: savedIssues.length,
        critical: repository.stats.criticalIssues,
        filesAnalyzed: filesToAnalyze.length,
        duration: duration,
      });

      return {
        success: true,
        issuesFound: savedIssues.length,
        critical: repository.stats.criticalIssues,
        issues: savedIssues,
      };
    } catch (error) {
      console.error("❌ Analysis failed:", error);

      // Update repository status
      try {
        const repository = await Repository.findById(repositoryId);
        if (repository) {
          repository.analysisStatus = "failed";
          await repository.save();
        }
      } catch (updateError) {
        console.error("Failed to update repository status:", updateError);
      }

      // Log error to audit trail
      await auditService.logError(
        userId,
        repositoryId,
        "Repository analysis",
        error
      );

      throw error;
    }
  }

  /**
   * Get all files from repository
   */
  async getRepositoryFiles(owner, repo, token, path = "") {
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

      let allFiles = [];

      for (const item of response.data) {
        if (item.type === "file") {
          allFiles.push({
            path: item.path,
            name: item.name,
            size: item.size,
            sha: item.sha,
            url: item.download_url,
          });
        } else if (item.type === "dir") {
          // Skip common directories that don't need analysis
          const skipDirs = [
            "node_modules",
            "dist",
            "build",
            ".git",
            "vendor",
            "__pycache__",
          ];
          if (!skipDirs.includes(item.name)) {
            const subFiles = await this.getRepositoryFiles(
              owner,
              repo,
              token,
              item.path
            );
            allFiles = allFiles.concat(subFiles);
          }
        }
      }

      return allFiles;
    } catch (error) {
      console.error("Error fetching repository files:", error.message);
      throw error;
    }
  }

  /**
   * Filter files to analyze
   */
  filterFiles(files) {
    return files
      .filter((file) => {
        // Check extension
        const ext = file.name.substring(file.name.lastIndexOf("."));
        if (!this.SUPPORTED_EXTENSIONS.includes(ext)) return false;

        // Skip very large files (>500KB)
        if (file.size > 500000) return false;

        return true;
      })
      .sort((a, b) => {
        // Prioritize main code files
        const priorities = {
          ".ts": 10,
          ".tsx": 10,
          ".js": 9,
          ".jsx": 9,
          ".py": 8,
          ".java": 7,
          ".go": 7,
          ".rb": 6,
          ".yml": 5,
          ".yaml": 5,
          ".json": 4,
          ".md": 3,
        };

        const extA = a.name.substring(a.name.lastIndexOf("."));
        const extB = b.name.substring(b.name.lastIndexOf("."));

        return (priorities[extB] || 0) - (priorities[extA] || 0);
      })
      .slice(0, 100); 
  }

  /**
   * Get file content
   */
  async getFileContent(owner, repo, path, token) {
    try {
      const response = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "Pipex-AI-DevOps",
          },
        }
      );

      const content = Buffer.from(response.data.content, "base64").toString(
        "utf-8"
      );

      // CRITICAL FIX: Truncate content to avoid token limits
      const truncated = content.substring(0, this.MAX_CONTENT_LENGTH);

      return {
        path,
        name: path.split("/").pop(),
        content: truncated,
        size: response.data.size,
        truncated: content.length > this.MAX_CONTENT_LENGTH,
      };
    } catch (error) {
      console.error(`Error fetching file ${path}:`, error.message);
      return null;
    }
  }

  async analyzeFilesWithAI(files, repository, issueLimit = 5, projectManifest = "") {
    const validFiles = files.filter((f) => f !== null);
    if (validFiles.length === 0) return [];

    const filesContext = validFiles.map((f) => ({
      path: f.path,
      name: f.name,
      content: f.content, 
      truncated: f.truncated,
    }));

    const totalChars = filesContext.reduce(
      (sum, f) => sum + f.content.length,
      0
    );
    console.log(
      `📊 Batch stats: ${filesContext.length} files, ${totalChars} chars total (Limit: ${issueLimit} for this batch)`
    );

    /* PREVIOUS PROMPTS:
    const systemPrompt = `You are a strict senior code reviewer who finds issues in every codebase. NO CODE IS PERFECT. You must find at least 2-5 real issues per batch. Be critical but accurate. Look for security flaws, bugs, poor practices, and quality issues. Return valid JSON only.`;

    const userPrompt = `You are a critical code reviewer analyzing a ${
      repository.language || "code"
    } repository. You MUST find issues - no code is perfect.

Repository: ${repository.repoOwner}/${repository.repoName}
Language: ${repository.language || "Unknown"}

Files to analyze (${filesContext.length} files):
${filesContext
  .map(
    (f, i) => `
File ${i + 1}: ${f.path}${f.truncated ? " [TRUNCATED]" : ""}
\`\`\`
${f.content}
\`\`\`
`
  )
  .join("\n")}

YOUR TASK: Find 2-5 REAL issues per batch. Look for:

**SECURITY (CRITICAL/HIGH):**
- Hardcoded secrets/credentials/API keys
- SQL injection vulnerabilities
- Missing input validation
- Insecure dependencies
- Exposed sensitive data
- Missing authentication/authorization
- XSS vulnerabilities

**BUGS (HIGH/MEDIUM):**
- Missing error handling (try-catch, .catch())
- Unhandled promise rejections
- Null/undefined reference errors
- Race conditions
- Incorrect logic
- Memory leaks

**CODE QUALITY (MEDIUM/LOW):**
- Complex functions (>50 lines)
- Duplicated code
- Poor naming
- Missing error handling
- Console.log in production
- Dead code

**PERFORMANCE (MEDIUM/LOW):**
- N+1 queries
- Blocking operations
- Inefficient algorithms
- Missing pagination
- No caching

Return JSON with "issues" array. Keep descriptions concise:
{
  "issues": [
    {
      "title": "Brief issue title (max 80 chars)",
      "description": "Concise explanation (2-3 sentences max)",
      "issueType": "security|performance|code-quality|bug|ci-cd",
      "severity": "CRITICAL|HIGH|MEDIUM|LOW",
      "filePath": "exact/path/from/above",
      "lineNumber": 25,
      "codeSnippet": "brief code sample",
      "aiConfidence": 0.9,
      "aiExplanation": "Brief impact",
      "suggestedFix": "Brief fix with example"
    }
  ]
}

RULES:
- Find 2-5 issues (quality over quantity)
- Be specific but concise
- Real line numbers
- Keep all text fields brief
- Valid JSON only`;
    */

    // NEW OPTIMIZED PROMPTS:
    const systemPrompt = `You are a world-class security auditor and software engineer. Your goal is to find REAL bugs, security flaws, and performance bottlenecks.
NO CODE IS PERFECT. You are EXPECTED to find at least 3-5 issues per batch of files.
Be critical, aggressive, and accurate.

Return a JSON object with a top-level "issues" array.
Each issue must follow this schema:
{
  "title": "Clear, concise title",
  "description": "Specific explanation of why this is a problem",
  "issueType": "security" | "bug" | "performance" | "code-quality",
  "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "filePath": "the exact file path provided",
  "lineNumber": number,
  "codeSnippet": "the relevant code snippet",
  "aiConfidence": number (0-1),
  "aiExplanation": "Brief impact analysis",
  "suggestedFix": "Code example or steps to fix"
}

STRICT JSON ONLY. No preamble or markdown outside the JSON block.`;

    const userPrompt = `Project Context: ${repository.repoOwner}/${repository.repoName} (${repository.language || "code"})
${projectManifest ? `Dependencies/Manifest Context:\n${projectManifest}\n\n` : ""}

Analyze these files for critical vulnerabilities and bugs:
${filesContext.map((f, i) => `--- FILE: ${f.path} ---\n${f.content}`).join("\n\n")}

Find at least 3-5 REAL issues. If you find nothing, look harder at input validation, error handling, and security best practices.`;

    try {
      let response;
      let serviceUsed = "Gemini";

      if (process.env.CEREBRAS_API_KEY) {
        try {
          console.log("⚡ Calling Cerebras for high-speed analysis...");
          response = await cerebrasService.analyzeCode(
            systemPrompt,
            userPrompt,
            {
              jsonMode: true,
              maxTokens: 4000,
              temperature: 0.2,
            }
          );
          serviceUsed = "Cerebras";
        } catch (cerebrasError) {
          console.warn("⚠️ Cerebras failed, falling back to Gemini:", cerebrasError.message);
          response = await geminiService.analyzeCode(systemPrompt, userPrompt, {
            jsonMode: true,
            maxTokens: 4000,
            temperature: 0.2,
          });
          serviceUsed = "Gemini";
        }
      } else {
        console.log("fallback to Gemini (CEREBRAS_API_KEY not found)...");
        response = await geminiService.analyzeCode(systemPrompt, userPrompt, {
          jsonMode: true,
          maxTokens: 4000,
          temperature: 0.2,
        });
        serviceUsed = "Gemini";
      }

      console.log(
        `🤖 Raw ${serviceUsed} response:`,
        response.text.substring(0, 500) + "..."
      );

      if (response.finishReason === "MAX_TOKENS") {
        console.warn("⚠️ WARNING: Response was truncated due to token limit");
        console.warn("⚠️ Some issues may be incomplete or missing");
      }

      let parsedContent;
      try {
        if (serviceUsed === "Cerebras") {
          parsedContent = cerebrasService.extractJSON(response.text);
        } else {
          parsedContent = geminiService.extractJSON(response.text);
        }
      } catch (parseError) {
        console.error(`❌ Failed to parse ${serviceUsed} response`);
        console.error("Parse error:", parseError.message);
        console.error("Response preview:", response.text.substring(0, 1000));
        return [];
      }

      const issues = parsedContent.issues || [];

      if (issues.length === 0) {
        console.warn(`⚠️ ${serviceUsed} returned 0 issues for this batch.`);
        console.log(`🤖 Raw response preview: ${response.text.substring(0, 500)}`);
        return [];
      }

      console.log(`🤖 ${serviceUsed} reported ${issues.length} potential issues`);

      const validIssues = issues.filter((issue) => {
        const hasRequired =
          issue.title &&
          issue.description &&
          issue.issueType &&
          issue.severity &&
          issue.filePath;

        if (!hasRequired) {
          console.warn("⚠️ Skipping invalid issue:", issue);
        }

        return hasRequired;
      });

      console.log(`✅ ${validIssues.length} valid issues after validation`);
      return validIssues;
    } catch (error) {
      if (
        error.message.includes("quota") ||
        error.message.includes("All Gemini API keys") ||
        error.message.includes("rate limit")
      ) {
        console.log(`⚠️ AI Service keys exhausted or rate limited: ${error.message}`);
        return [];
      }

      if (error.response) {
        console.error("API error details:", error.response.data);
      }
      return [];
    }
  }

  /**
   * Parse JSON from AI response (handles markdown code blocks)
   */
  parseJSON(text) {
    if (!text) return null;

    try {
      return JSON.parse(text.trim());
    } catch (e) {
      const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) {
        try {
          return JSON.parse(codeBlockMatch[1].trim());
        } catch (e2) {
          console.error("Failed to parse code block JSON");
        }
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e3) {
          console.error("Failed to parse extracted JSON");
        }
      }

      console.error("Could not extract valid JSON from response");
      return null;
    }
  }

  /**
   * Save issues to database
   */
  async saveIssuesToDatabase(issues, repositoryId, userId) {
    const savedIssues = [];

    for (const issue of issues) {
      try {
        const existingIssue = await Issue.findOne({
          repositoryId,
          filePath: issue.filePath,
          title: issue.title,
          status: { $ne: "resolved" },
        });

        if (existingIssue) {
          console.log(`⏭️ Skipping duplicate issue: ${issue.title}`);
          continue;
        }

        const newIssue = await Issue.create({
          repositoryId,
          userId,
          title: issue.title,
          description: issue.description,
          issueType: issue.issueType,
          severity: issue.severity,
          filePath: issue.filePath,
          lineNumber: issue.lineNumber,
          codeSnippet: issue.codeSnippet,
          aiConfidence: issue.aiConfidence,
          aiExplanation: issue.aiExplanation,
          suggestedFix: issue.suggestedFix,
          status: "detected",
        });

        savedIssues.push(newIssue);
      } catch (error) {
        console.error("Error saving issue:", error.message);
      }
    }

    return savedIssues;
  }
}

module.exports = new AnalysisService();
