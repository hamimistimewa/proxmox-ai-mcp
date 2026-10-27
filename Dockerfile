# proxmox-ai-mcp has no dependencies, so the image is just Node plus this repository.
FROM node:22-alpine
WORKDIR /app
COPY bin ./bin
COPY lib ./lib
COPY skills ./skills
COPY package.json ./
RUN chmod +x server/*.mjs server/pmx 2>/dev/null || true
# stdio by default; set PROXMOX_AI_TRANSPORT=http to serve several clients over one port.
ENV PROXMOX_AI_TRANSPORT=stdio \
    PROXMOX_AI_PORT=8080 \
    PROXMOX_AI_HOST=0.0.0.0
EXPOSE 8080
ENTRYPOINT ["node", "server/proxmox-ai-mcp.mjs"]
