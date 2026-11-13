# VerityDAM — AI-Native Digital Asset Intelligence

> **Trusted Visual Assets for Humans & AI.**  
> *Zero Speculation • Evidence-Grounded Verification • Agentic-Ready MCP*

VerityDAM is an enterprise-grade, AI-native Digital Asset Management platform designed to bridge the trust gap between unstructured media assets, product catalogs, and autonomous AI agents.

Built from the ground up for high-fidelity visual search, evidence-grounded SKU verification, and automated marketing workflows, VerityDAM prevents visual hallucinations, invalid asset substitutions, and unverified publication.

---

## 🌟 Core Pillars & Strategic Moat

1. **Zero-Speculation SKU Verification:**
   * High-precision visual product verification using dual-space visual embeddings (SigLIP2 1152-dim / OpenCLIP 256-dim).
   * Distinguishes lookalike models, subtle hardware revisions, and installation contexts from actual physical photos.
   * Hard-negative refusal: AI agents refuse to guess when provenance or visual proof is insufficient.

2. **Evidence-Grounded Retrieval & Hybrid Search:**
   * Reciprocal Rank Fusion (RRF) combining vector semantic search (pgvector HNSW), Vietnamese/English lexical search, and catalog entity matching.
   * Maximal Marginal Relevance (MMR) for visual diversity in marketing results.

3. **Standardized Model Context Protocol (MCP) Server:**
   * 13+ production-ready MCP tools over Streamable HTTP, SSE, and stdio.
   * Full agentic integration with Antigravity, Claude Code/Desktop, Cursor, and any MCP-compatible client.
   * Automatic policy enforcement: checks asset review status, copyright, and publishing permissions before releasing URLs.

4. **Human-in-the-Loop Review Queue (`/review`):**
   * Rapid keyboard-driven curation interface with AI-assisted pre-fill.
   * Reviewer provenance loop: every human correction enriches the reference knowledge base.

5. **Configurable Enterprise Taxonomy:**
   * Agnostic schema adaptable to any vertical: Consumer Goods, Hardware & IoT, Fashion, Real Estate, or Industrial Equipment.

---

## 🏗️ System Architecture

```
┌────────────────────────────────────────────────────────┐
│               AI Agents & Client Apps                  │
│       (Antigravity / Claude / Cursor / Web UI)         │
└───────────────────────────┬────────────────────────────┘
                            │
               MCP (HTTP/SSE) / REST API
                            │
┌───────────────────────────▼────────────────────────────┐
│              VerityDAM Core Application                │
│    Next.js 15 (App Router) + TypeScript + Tailwind     │
│             Better Auth (RBAC / Sessions)              │
└──────────────┬──────────────────────────┬──────────────┘
               │                          │
        Postgres / pgvector           S3 / Cloudflare R2
        (HNSW Indexing)             (Canonical WebP/AVIF)
               ▲                          ▲
               │                          │
┌──────────────┴──────────────────────────┴──────────────┐
│           VerityDAM Python Vision Worker               │
│        SigLIP2 / ONNX Runtime + pHash Dedup            │
└────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start (Local Development)

### 1. Prerequisites
* **Node.js** 20+
* **Python** 3.10+
* **Docker & Docker Compose** (PostgreSQL 17 + pgvector)
* An **S3-compatible bucket** (Cloudflare R2, MinIO, AWS S3). Uploads and published renditions are stored there.

### 2. Configure
```bash
cp .env.example .env.local
cp backend/.env.example backend/.env
```
Fill in at least `BETTER_AUTH_SECRET`, the `R2_*` storage variables, and generate the Vision config key:
```bash
openssl rand -base64 32   # -> VERITY_VISION_CONFIG_MASTER_KEY (must decode to exactly 32 bytes)
```

### 3. Database
```bash
docker compose up -d postgres
cd backend && python -m scripts.apply_native_migrations && cd ..
```

### 4. Web app
```bash
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000). Create the first account with `npm run provision:test-accounts` (local only) or `scripts/provision-better-auth-user.mjs`.

### 5. Analysis worker and embeddings
The worker computes pHash, SigLIP2 embeddings and calls your OpenAI-compatible Vision endpoint (configured by an admin under *Settings → AI Vision*).
```bash
docker compose up -d verity-dam-worker
```
SigLIP2 ONNX artifacts are not bundled (361 MB). Put `siglip2-vision-opset18.onnx` (+ `.data`) in `backend/models/`, or host them yourself and set `VERITY_MODELS_CDN_URL` before running `python backend/scripts/download_siglip2_model.py`.

### 6. Run the MCP server for AI agents
```bash
docker compose --profile mcp up -d verity-dam-mcp
# or: cd backend && python -m verity_dam_mcp
```
The MCP endpoint is `http://localhost:8000/mcp`.

### 7. Tests
```bash
npm test                                   # frontend / API unit tests
cd backend && python -m pytest tests -q    # backend tests
```

---

## 🤖 Connecting AI Agents via MCP

Add the following configuration to your agent environment:

### Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "verity-dam": {
      "transport": {
        "type": "streamable-http",
        "url": "http://localhost:8000/mcp",
        "headers": {
          "Authorization": "Bearer verity_mcp_live_YOUR_TOKEN"
        }
      }
    }
  }
}
```

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcp": {
    "servers": {
      "verity-dam": {
        "url": "http://localhost:8000/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer verity_mcp_live_YOUR_TOKEN"
        }
      }
    }
  }
}
```

---

## 🛡️ License & Trademarks

VerityDAM is licensed under the Apache 2.0 / MIT Dual License. Designed as an independent open-core system for trustworthy digital asset management.
