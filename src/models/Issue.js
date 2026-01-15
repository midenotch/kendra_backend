const mongoose = require('mongoose');

const IssueSchema = new mongoose.Schema({
  repositoryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Repository',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Issue Details
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  issueType: {
    type: String,
    enum: ['security', 'performance', 'code-quality', 'ci-cd', 'dependency', 'bug', 'api-security', 'pen-test'],
    required: true
  },
  severity: {
    type: String,
    enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'],
    required: true
  },
  
  // Code Location
  filePath: String,
  lineNumber: Number,
  codeSnippet: String,
  
  // AI Analysis
  aiConfidence: {
    type: Number,
    min: 0,
    max: 1
  },
  aiExplanation: String,
  suggestedFix: String,
  
  // Status Tracking
  status: {
    type: String,
    enum: ['detected', 'fix-generated', 'pr-created', 'resolved', 'ignored'],
    default: 'detected'
  },
  fixAttempts: {
    type: Number,
    default: 0
  },
  
  // Pull Request Link
  pullRequestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PullRequest'
  },
  githubIssueNumber: Number,
  
  // Timestamps
  detectedAt: {
    type: Date,
    default: Date.now
  },
  resolvedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Issue', IssueSchema);