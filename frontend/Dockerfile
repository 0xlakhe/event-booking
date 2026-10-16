# EventBook frontend image.
# Dev target: source bind-mounted, `next dev` with hot reload.
# Prod target: `next build` baked in, `next start` without reload.
FROM node:22-alpine AS base

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . ./

EXPOSE 3000

FROM base AS dev

CMD ["npm", "run", "dev", "--", "--hostname", "0.0.0.0", "--port", "3000"]

FROM base AS prod

# Public API URL baked at image build time. The default keeps local
# behavior; releases pass --build-arg with the deployed HTTPS URL.
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8000/api
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN npm run build

CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]
