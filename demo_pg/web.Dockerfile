FROM node:20.19.6-alpine AS ui
WORKDIR /build
COPY demo-ui/package.json demo-ui/package-lock.json ./
RUN npm ci
COPY demo-ui/angular.json demo-ui/tsconfig*.json ./
COPY demo-ui/src ./src
COPY demo-ui/public ./public
RUN npm run build

FROM python:3.12-slim AS web
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY demo-requirements.txt ./
RUN pip install --no-cache-dir -r demo-requirements.txt \
    && useradd --create-home --uid 10001 demo
COPY demo_api.py ./
COPY demo_db/__init__.py demo_db/migrate.py demo_db/seed_fictitious.py ./demo_db/
COPY demo_db/migrations ./demo_db/migrations
COPY --from=ui /build/dist/arabica-demo-ui/browser ./demo-ui/dist/arabica-demo-ui/browser
USER demo
EXPOSE 10000
CMD ["sh", "-c", "exec uvicorn demo_api:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
