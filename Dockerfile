FROM node:8-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json .
RUN yarn install
COPY . .
CMD ["yarn","start"]