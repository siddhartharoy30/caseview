# QView

Case queue dashboard with SLA alerts and AI-suggested replies, built on top of Rubrik's Salesforce case data.

## Setup

1. Copy .env.example to .env and fill in real values.
2. Place Rubrik's internal CA bundle at certs/rubrik-ca-bundle.pem (needed for ANTHROPIC_BASE_URL calls through Rubrik's internal gateway — not checked into git).
3. Run npm install, npm run build, npm start, or run via the sibling salesforce-case-tracker docker-compose stack.

## Auth

Login is email + Slack one-time-password, restricted to a single allowed email (QVIEW_ALLOWED_EMAIL). The code is posted to a fixed Slack channel via the bot token (SLACK_BOT_TOKEN), not DMed.
