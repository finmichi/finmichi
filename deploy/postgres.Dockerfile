FROM postgres:17-bookworm@sha256:839fbb5a4942a7758dd93e18b42ea5649807491a0545b5eeeb8f0b8bb11857a5
LABEL org.opencontainers.image.source="https://github.com/finmichi/finmichi"
RUN rm -f /usr/local/bin/gosu
USER postgres
