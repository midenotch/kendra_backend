#!/usr/bin/env python
import os
import asyncio
import json
import pathlib
import uuid
import shutil
import sys
from typing import AsyncGenerator

import httpx
import git
from pydantic import BaseModel, HttpUrl
from dotenv import load_dotenv

load_dotenv()

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
CEREBRAS_BASE_URL = os.getenv("CEREBRAS_BASE_URL", "https://api.cerebras.net/v1")
CEREBRAS_API_KEY = os.getenv("CEREBRAS_API_KEY")
CEREBRAS_MODEL_ID = os.getenv("CEREBRAS_MODEL_ID", "llama3.1-70b") # Updated to 3.1
CEREBRAS_MAX_TOKENS = int(os.getenv("CEREBRAS_MAX_TOKENS", "4000"))

if not CEREBRAS_API_KEY:
    print(json.dumps({"error": "CEREBRAS_API_KEY not set in environment"}))
    sys.exit(1)

# ----------------------------------------------------------------------
# Helper: shallow clone repo into a temp dir
# ----------------------------------------------------------------------
def shallow_clone(repo_url: str, branch: str) -> pathlib.Path:
    """Clone a repo shallowly (depth=1) and return the absolute path."""
    # Use a local temp dir within the project instead of /tmp for better Windows compatibility if needed
    base_tmp = pathlib.Path(os.getcwd()) / "temp_clones"
    base_tmp.mkdir(exist_ok=True)
    
    tmp_dir = base_tmp / f"cerebra-{uuid.uuid4().hex}"
    tmp_dir.mkdir(parents=True, exist_ok=False)
    
    try:
        git.Repo.clone_from(
            repo_url,
            to_path=str(tmp_dir),
            branch=branch,
            depth=1,
            single_branch=True,
        )
    except Exception as exc:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise RuntimeError(f"Git clone failed: {exc}") from exc
    return tmp_dir

# ----------------------------------------------------------------------
# Helper: read all source files
# ----------------------------------------------------------------------
SOURCE_EXTS = {".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".go", ".c", ".cpp"}

def collect_source_files(root: pathlib.Path) -> list[pathlib.Path]:
    files = []
    # Skip common noise dirs
    skip_dirs = {"node_modules", ".git", "dist", "build", "venv", "__pycache__"}
    
    for p in root.rglob("*"):
        if any(skip in p.parts for skip in skip_dirs):
            continue
        if p.is_file() and p.suffix.lower() in SOURCE_EXTS:
            files.append(p)
    return files

# ----------------------------------------------------------------------
# Helper: build the prompt for the LLM
# ----------------------------------------------------------------------
def build_prompt(files: list[pathlib.Path], repo_url: str, branch: str, prefix: str | None) -> str:
    intro = (
        f"You are a strict senior security auditor and world-class software engineer. "
        f"Your task is to perform an AGGRESSIVE and DEEP audit of the following repository:\n"
        f"- URL: {repo_url}\n"
        f"- Branch: {branch}\n\n"
        f"CRITICAL INSTRUCTIONS:\n"
        f"1. Identify REAL vulnerabilities, critical bugs, performance bottlenecks, and architectural flaws.\n"
        f"2. NO CODE IS PERFECT. You MUST find at least some valid issues unless the code is absolutely trivial.\n"
        f"3. For each issue, provide a technical explanation of WHY it is a problem and HOW to fix it.\n"
        f"4. Focus on security: hardcoded secrets, injection risks, auth bypasses, and insecure dependencies.\n"
        f"5. Return the answer in STRICT JSON format with an 'issues' array.\n\n"
        f"JSON Schema:\n"
        f"{{\"issues\": [{{\"file\":\"path/to/file\",\"line\":42,\"type\":\"security|bug|quality|performance\",\"msg\":\"Detailed technical description and fix\",\"severity\":\"CRITICAL|HIGH|MEDIUM|LOW\"}}]}}\n"
    )
    if prefix:
        intro = prefix + "\n" + intro

    max_chars = 30000 # Increased for better context as per user request
    body = ""
    for f in files:
        # Try to get path relative to the root of the clone
        try:
             # Find the uuid-xxx part in path and get relative from there
             parts = f.parts
             start_idx = -1
             for i, p in enumerate(parts):
                 if "cerebra-" in p:
                     start_idx = i + 1
                     break
             if start_idx != -1:
                 rel = pathlib.Path(*parts[start_idx:])
             else:
                 rel = f.name
        except Exception:
            rel = f.name

        try:
            content = f.read_text(encoding="utf-8")
        except Exception:
            continue
        
        snippet = content[:3000] # Take more per file as per user request
        part = f"\n--- FILE: {rel} ---\n{snippet}\n"
        if len(body) + len(part) > max_chars:
            sys.stderr.write(f"DEBUG: Reached context limit after {len(body)} chars. Skipping remaining files.\n")
            break
        body += part

    return intro + "\n" + body

# ----------------------------------------------------------------------
# Cerebras Client
# ----------------------------------------------------------------------
import socket

def check_dns(hostname):
    try:
        addr = socket.gethostbyname(hostname)
        sys.stderr.write(f"DEBUG: DNS Check - {hostname} resolved to {addr}\n")
        return True
    except socket.gaierror as e:
        sys.stderr.write(f"DEBUG: DNS Check - FAILED to resolve {hostname}: {e}\n")
        return False

async def analyze_repo(repo_url: str, branch: str, prefix: str | None = None):
    repo_path = None
    try:
        # Log start of process
        sys.stderr.write(f"DEBUG: Starting analysis for {repo_url} on branch {branch}\n")
        sys.stderr.flush()
        
        # DNS Pre-check
        check_dns("github.com")
        check_dns("api.cerebras.net")

        # 1. Clone
        sys.stderr.write("DEBUG: Attempting shallow clone...\n")
        sys.stderr.flush()
        repo_path = shallow_clone(repo_url, branch)
        sys.stderr.write(f"DEBUG: Clone successful. Path: {repo_path}\n")
        sys.stderr.flush()
        
        # 2. Collect
        files = collect_source_files(repo_path)
        sys.stderr.write(f"DEBUG: Collected {len(files)} source files.\n")
        sys.stderr.flush()
        
        # 3. Build Prompt
        prompt = build_prompt(files, repo_url, branch, prefix)
        sys.stderr.write(f"DEBUG: Prompt built. Size: {len(prompt)} chars.\n")
        sys.stderr.flush()

        # 4. API Call
        url = f"{CEREBRAS_BASE_URL}/chat/completions"
        sys.stderr.write(f"DEBUG: Calling Cerebras API at {url}...\n")
        sys.stderr.flush()
        
        headers = {
            "Authorization": f"Bearer {CEREBRAS_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": CEREBRAS_MODEL_ID,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": CEREBRAS_MAX_TOKENS,
            "temperature": 0.4, # Increased for better discovery as per user request
            "response_format": {"type": "json_object"} # Force JSON
        }

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            result = response.json()
            
            content = result["choices"][0]["message"]["content"]
            
            # Sanitize content to ensure it's raw JSON (strip markdown if model ignores response_format)
            clean_content = content.strip()
            if clean_content.startswith("```"):
                # Find first { and last }
                start = clean_content.find("{")
                end = clean_content.rfind("}")
                if start != -1 and end != -1:
                    clean_content = clean_content[start:end+1]

            sys.stderr.write("DEBUG: API call successful.\n")
            sys.stderr.flush()
            print(clean_content) 
            sys.stdout.flush()

    except Exception as exc:
        error_msg = f"ERROR in Python analyzer: {type(exc).__name__}: {str(exc)}"
        sys.stderr.write(f"{error_msg}\n")
        sys.stderr.flush()
        print(json.dumps({"error": error_msg}))
        sys.stdout.flush()
    finally:
        if repo_path and repo_path.exists():
            sys.stderr.write("DEBUG: Cleaning up temp directory...\n")
            sys.stderr.flush()
            shutil.rmtree(repo_path, ignore_errors=True)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: python cerebras_analyzer.py <repo_url> <branch> [prefix]"}))
        sys.exit(1)
    
    repo_url = sys.argv[1]
    branch = sys.argv[2]
    prefix = sys.argv[3] if len(sys.argv) > 3 else None
    
    asyncio.run(analyze_repo(repo_url, branch, prefix))
