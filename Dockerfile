# Use the lightweight Node.js alpine image
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package configurations
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production

# Copy the core server files and static control panel page
COPY index.js dashboard.html ./

# Expose the default proxy port
EXPOSE 7860

# Start the proxy server
CMD ["npm", "start"]
