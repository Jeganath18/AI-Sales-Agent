FROM node:18-alpine

# Create working directory
WORKDIR /app

# Install dependencies first (better caching)
COPY package*.json ./
RUN npm install --production

# Copy all project files
COPY . .

# Traefik will route this port 
EXPOSE 80

# Start the orchestrator
CMD ["node", "orchestrator/index.js"]
