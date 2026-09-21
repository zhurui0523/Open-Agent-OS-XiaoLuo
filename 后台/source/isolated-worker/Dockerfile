FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 10001 --create-home worker
WORKDIR /srv
COPY server.mjs /srv/server.mjs
USER 10001
ENV NODE_ENV=production PORT=8788 PACKAGE_ROOT=/packages
EXPOSE 8788
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","/srv/server.mjs"]
