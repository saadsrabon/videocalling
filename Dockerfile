FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    ninja-build \
    meson \
    pkg-config \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

EXPOSE 3004
EXPOSE 40000/udp

CMD ["node", "dist/index.js"]
