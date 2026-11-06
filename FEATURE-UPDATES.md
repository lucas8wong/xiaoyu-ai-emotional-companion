# Feature updates

## 2026-11-06 22:31 (UTC+8) · Operator browser login fix / 运营台浏览器登录修复

Published: same-origin Referrer-Policy preserves native login-form provenance. The previous no-referrer policy made Chromium send Origin:null, which correctly failed the strict origin guard. Isolated real-browser A/B reproduction confirms the old403 and new successful form login; public headers/authenticated readback and gateway tests pass. Cross-site and null-origin requests remain blocked. No data changes or AI/publication calls.

已上线：修复正常登录被误报跨站。真实浏览器隔离复现旧403及修复后登录成功，公网响应头和鉴权读回通过；跨站及null来源仍拦截，未改动业务数据。

## 2026-11-06 22:23 (UTC+8) · Private XHS operator access / 小红书运营台入口

Published and verified: https://myxiaoyu.com/xhs/ uses the existing admin credential, protects every operator resource, and forwards to the independent local worker. Login, authenticated assets/data/images, SSE and logout passed public readback; unauthorized and cross-origin requests are blocked. PC must stay on; this is not a cloud migration. No publishing or paid AI call.

已上线并公网核验：运营台入口为 /xhs/，沿用admin管理口令，稿件／图片／接口全部鉴权，支持实时进度与退出。电脑需保持运行，数据与小愈生产库分离，不代表已上云。本次未发帖、未调用收费模型。

