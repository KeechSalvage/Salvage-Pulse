# ==========================================
# Stage 1: Build Frontend (Vite + React + TS)
# ==========================================
FROM node:22-alpine AS frontend-builder
WORKDIR /build

# Install dependencies first for optimal Docker layer caching
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --legacy-peer-deps

# Copy frontend source files
COPY frontend/ ./

# Build production distribution
RUN npm run build

# ==========================================
# Stage 2: Production Python Backend & SPA
# ==========================================
FROM python:3.11-slim AS runner
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    DATA_DIR=/app/backend/data \
    INITIAL_MASTER_EMAIL=brettk@salvagepulsepro.com \
    INITIAL_MASTER_NAME="Brett K"

# Install runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/backend/data

# Install python requirements
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r ./backend/requirements.txt

# Copy backend application code
COPY backend/ ./backend/

# Copy built frontend assets from stage 1 into backend/static
COPY --from=frontend-builder /build/dist ./backend/static

WORKDIR /app/backend

EXPOSE 8000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8000/api/health || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
