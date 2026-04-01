FROM node:18-slim

WORKDIR /app

# Install python3 + pip + ffmpeg for yt-dlp
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip ffmpeg && \
    pip3 install --break-system-packages yt-dlp && \
    rm -rf /var/lib/apt/lists/*

# Install node dependencies
COPY package*.json ./
RUN npm ci --production

# Copy app
COPY . .

EXPOSE 3000
CMD ["node", "backend/server.js"]
