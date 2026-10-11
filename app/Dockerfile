FROM scratch AS manifests

COPY package.json yarn.lock .npmrc ./
COPY excalidraw-app/package.json ./excalidraw-app/package.json
COPY packages/common/package.json ./packages/common/package.json
COPY packages/element/package.json ./packages/element/package.json
COPY packages/excalidraw/package.json ./packages/excalidraw/package.json
COPY packages/fractional-indexing/package.json ./packages/fractional-indexing/package.json
COPY packages/laser-pointer/package.json ./packages/laser-pointer/package.json
COPY packages/math/package.json ./packages/math/package.json
COPY packages/utils/package.json ./packages/utils/package.json

FROM --platform=${BUILDPLATFORM} node:24@sha256:8530f76a96d88820d288761f022e318970dda93d01536919fbc16076b7983e63 AS dependencies

WORKDIR /opt/node_app

COPY --from=manifests / ./

ARG TARGETARCH

# do not ignore optional dependencies:
# Error: Cannot find module @rollup/rollup-linux-x64-gnu
RUN --mount=type=cache,target=/root/.cache/yarn \
    HUSKY=0 npm_config_target_arch=${TARGETARCH} yarn --frozen-lockfile --network-timeout 600000

FROM dependencies AS build

ARG NODE_ENV=production

COPY . .

RUN npm_config_target_arch=${TARGETARCH} yarn build:app:docker

FROM nginx:stable-alpine-slim@sha256:2c605dbeab79a6b2a63340474fe58119d0ef95bdc4b1f41df0aa689659b3d13b

COPY excalidraw-app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /opt/node_app/excalidraw-app/build /usr/share/nginx/html

HEALTHCHECK CMD wget -q -O /dev/null http://localhost:3000 || exit 1
