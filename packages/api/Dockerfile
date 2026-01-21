FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api/package.json packages/api/package.json

RUN npm install

COPY packages/shared packages/shared
COPY packages/api packages/api

RUN npm --workspace @watch-tower/shared run build
RUN npm --workspace @watch-tower/api run build

EXPOSE 3001
CMD ["npm", "--workspace", "@watch-tower/api", "run", "start"]
