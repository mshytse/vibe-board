# Team Activity Dashboard

Internal Jira activity feed and support board.

## Requirements

- **Node.js ≥ 14** — no `npm install` needed, all dependencies are built into Node.

## Setup

1. Run the server from the project folder:
   ```
   node server.js
   ```
2. Open **http://localhost:3000** in a browser.
3. Go to **http://localhost:3000/settings.html** and fill in:
   - **Jira URL** — your Atlassian instance URL
   - **Email** — your Scalr email
   - **API Token** — generate one at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
   - **Project Keys** — comma-separated keys for the projects you want to track
   - **Team Members** — search and add the people you want to monitor

## Notes

- Your credentials are stored locally in `config.json` (gitignored — never committed).
- Each person runs their own instance with their own API token.
