const cerebrasService = require('./cerebrasService');
const geminiService = require('./geminiService');

class SecurityAdvisorService {
  /**
   * Generates a detailed Penetration Testing strategy for a specific issue or repository
   */
  async generateTestingStrategy(issue, repository) {
    const systemPrompt = `You are a Senior Penetration Tester and Security Architect. 
Your goal is to provide a SAFE, GUIDED testing strategy for identified vulnerabilities.
DO NOT exploit. Provide educational and strategic advice.
Focus on: 1. Attack surface mapping, 2. Endpoint identification, 3. Neutral testing vectors.`;

    const userPrompt = `Vuln: ${issue.title}
File: ${issue.filePath}
Description: ${issue.description}
Code Context:
${issue.codeSnippet}

TASK: Provide a Guided Penetration Testing Plan. Include:
1. ATTACK SURFACE: Which endpoints/files are exposed?
2. RISKS: What is the impact if exploited?
3. SAFE TESTING STRATEGY: How can a developer verify this vulnerability without causing harm?
4. PLAYBOOK: Steps to secure and monitor this area.`;

    try {
      let response;
      if (process.env.CEREBRAS_API_KEY) {
        response = await cerebrasService.analyzeCode(systemPrompt, userPrompt, {
          model: 'llama3.1-70b',
          temperature: 0.1,
          maxTokens: 2000
        });
      } else {
        response = await geminiService.analyzeCode(systemPrompt, userPrompt, {
          temperature: 0.2,
          maxTokens: 4000
        });
      }

      return {
        success: true,
        strategy: response.text,
        service: process.env.CEREBRAS_API_KEY ? 'Cerebras' : 'Gemini'
      };
    } catch (error) {
      console.error("❌ Security Strategy Generation Failed:", error);
      throw error;
    }
  }

  /**
   * Specifically analyzes API surface for missing auth or broken access control
   */
  async analyzeAPISurface(files) {
    const systemPrompt = `You are an Expert API Security Auditor specialized in OWASP API Security Top 10.
Analyze the provided code for:
1. Broken Object Level Authorization (BOLA)
2. Broken User Authentication
3. Excessive Data Exposure
4. Lack of Resources & Rate Limiting
5. Mass Assignment
6. Security Misconfiguration
7. Injection (SQL, NoSQL, etc.)

Return a JSON array of findings. Each finding must have:
{
  "title": string,
  "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
  "endpoint": string,
  "issueType": "api-security",
  "description": string,
  "remediation": string
}`;

    const codeContext = files.map(f => `FILE: ${f.path}\nCONTENT:\n${f.content}`).join('\n\n');
    const userPrompt = `Analyze the following API-related files for security vulnerabilities:\n\n${codeContext}`;

    try {
      let response;
      if (process.env.CEREBRAS_API_KEY) {
        response = await cerebrasService.analyzeCode(systemPrompt, userPrompt, {
          model: 'llama3.1-70b',
          temperature: 0.1,
          maxTokens: 3000
        });
      } else {
        response = await geminiService.analyzeCode(systemPrompt, userPrompt, {
          temperature: 0.1,
          maxTokens: 8192
        });
      }

      // Extract JSON from response text
      const jsonMatch = response.text.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      return [];
    } catch (error) {
      console.error("❌ API Surface Analysis Failed:", error);
      throw error;
    }
  }
}

module.exports = new SecurityAdvisorService();
