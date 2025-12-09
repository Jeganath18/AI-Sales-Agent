FROM node:18-alpine

# Create working directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install --production

# Copy all project files
COPY . .

# Expose ONLY the HTTP port (Traefik will route this)
EXPOSE 3000

# Start the orchestrator
CMD ["node", "orchestrator/index.js"]
