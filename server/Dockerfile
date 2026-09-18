# 공유 API. 의존성이 없어서 npm install 도, 빌드 단계도 없다.
FROM node:22-alpine

WORKDIR /srv
COPY server/index.js server/store.js ./

# /data 는 PVC 로 덮인다. 마운트 전에도 소유권이 맞아야 첫 기동이 실패하지 않는다.
RUN mkdir -p /data && chown -R node:node /data /srv
USER node

ENV PORT=8081 DATA_FILE=/data/teams.json
EXPOSE 8081
CMD ["node", "index.js"]
