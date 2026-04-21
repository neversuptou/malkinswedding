FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js telegram.config.js ./
COPY index.html gallery.html wedding.html ./
COPY public ./public

RUN mkdir -p photos

EXPOSE 3000

CMD ["node", "server.js"]