# 정적 사이트 하나가 전부다. 백엔드가 없다 —
# 브라우저가 gw.goorm.io 를 직접 부르고, 자격증명은 서버를 거치지 않는다.
FROM nginx:1.27-alpine

COPY deploy/nginx.conf deploy/security-headers.conf /etc/nginx/conf.d/
COPY app/www /usr/share/nginx/html

# nginx 이미지의 비루트 사용자로 돌린다 (101:101)
RUN touch /var/run/nginx.pid \
 && chown -R nginx:nginx /var/run/nginx.pid /var/cache/nginx /usr/share/nginx/html
USER nginx

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
