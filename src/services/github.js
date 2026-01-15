const axios = require("axios");

class GitHubService {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.api = axios.create({
      baseURL: "https://api.github.com",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Kendra-AI-DevOps",
      },
    });
  }

  // Get authenticated user
  async getUser() {
    try {
      const response = await this.api.get("/user");
      return response.data;
    } catch (error) {
      console.error(
        "GitHub get user error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to fetch GitHub user");
    }
  }

  // List user repositories
  async listRepositories(options = {}) {
    try {
      const params = {
        visibility: options.visibility || "all",
        affiliation:
          options.affiliation || "owner,collaborator,organization_member",
        sort: options.sort || "updated",
        direction: options.direction || "desc",
        per_page: options.per_page || 100,
        page: options.page || 1,
      };

      const response = await this.api.get("/user/repos", { params });
      return response.data;
    } catch (error) {
      console.error(
        "GitHub list repos error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to fetch repositories");
    }
  }

  // Get a specific repository
  async getRepository(owner, repo) {
    try {
      const response = await this.api.get(`/repos/${owner}/${repo}`);
      return response.data;
    } catch (error) {
      console.error(
        "GitHub get repo error:",
        error.response?.data || error.message
      );
      throw new Error(`Failed to fetch repository ${owner}/${repo}`);
    }
  }

  // Create a pull request
  async createPullRequest(owner, repo, data) {
    try {
      const response = await this.api.post(
        `/repos/${owner}/${repo}/pulls`,
        data
      );
      return response.data;
    } catch (error) {
      console.error(
        "GitHub create PR error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to create pull request");
    }
  }

  // Get repository issues
  async getIssues(owner, repo, options = {}) {
    try {
      const params = {
        state: options.state || "open",
        sort: options.sort || "created",
        direction: options.direction || "desc",
        per_page: options.per_page || 100,
      };

      const response = await this.api.get(`/repos/${owner}/${repo}/issues`, {
        params,
      });
      return response.data.filter((issue) => !issue.pull_request);
    } catch (error) {
      console.error(
        "GitHub get issues error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to fetch issues");
    }
  }

  // Create or update a file
  async createOrUpdateFile(owner, repo, path, content, message, sha = null) {
    try {
      const data = {
        message,
        content: Buffer.from(content).toString("base64"),
        branch: "main",
      };

      if (sha) {
        data.sha = sha; 
      }

      const response = await this.api.put(
        `/repos/${owner}/${repo}/contents/${path}`,
        data
      );
      return response.data;
    } catch (error) {
      console.error(
        "GitHub file operation error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to create/update file");
    }
  }

  // Create a new branch
  async createBranch(owner, repo, branchName, fromBranch = "main") {
    try {
      // Get the SHA of the base branch
      const baseRef = await this.api.get(
        `/repos/${owner}/${repo}/git/refs/heads/${fromBranch}`
      );
      const baseSha = baseRef.data.object.sha;

      // Create new branch
      const response = await this.api.post(`/repos/${owner}/${repo}/git/refs`, {
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      });

      return response.data;
    } catch (error) {
      console.error(
        "GitHub create branch error:",
        error.response?.data || error.message
      );
      throw new Error("Failed to create branch");
    }
  }
}

module.exports = GitHubService;
