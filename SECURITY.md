# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Email **myxiaoyu2026@gmail.com** with the
subject prefix `[SECURITY] Xiaoyu`, including the affected route or file, reproduction steps and impact.

## Secrets and data

- **No credentials are committed.** API keys, tokens and payment secrets are read from the environment
  at runtime; nothing sensitive is written into tracked files — including comments and documentation.
- **No user data is committed.** Accounts, conversations, orders and diaries live outside the repository
  and are gitignored.
- Documents in this repository reference configuration by **variable name**, never by value.

---

# 安全政策

## 上报漏洞

安全问题请**不要开公开 issue**，直接邮件 **myxiaoyu2026@gmail.com**（主题前缀 `[SECURITY] Xiaoyu`），
附上受影响的接口或文件、复现步骤与影响面。

## 密钥与数据

- **不提交任何凭据**：API Key、令牌与支付密钥一律在运行时从环境变量读取，任何被跟踪的文件（含注释与文档）都不写真实值。
- **不提交用户数据**：账号、会话、订单与日记存放在仓库之外并被 gitignore。
- 文档中只引用**变量名**，不写它的值。
