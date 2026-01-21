FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker/package.json packages/worker/package.json

RUN npm install

COPY packages/shared packages/shared
COPY packages/worker packages/worker

RUN npm --workspace @watch-tower/shared run build
RUN npm --workspace @watch-tower/worker run build

CMD ["npm", "--workspace", "@watch-tower/worker", "run", "start"]
